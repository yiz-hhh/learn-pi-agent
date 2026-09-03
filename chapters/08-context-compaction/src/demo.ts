/**
 * 真实 API 演示：Session Compaction（Compaction as an Entry）。
 *
 * 流程：
 * 1. scripted 长历史 U1 A1(toolCall) T1 U2(长文本) A2 U3 A3 写入 Entry 树并落盘（无 LLM）
 * 2. 压缩前先构造 Agent（initialMessages = 完整路径）——模拟「压缩发生时进程内已有 Agent」
 * 3. compactSession（真实 LLM 摘要）→ 结构断言：旧 history 不删、CompactionEntry append、context 变短
 * 4. agent.replaceMessages(重建 context)：同一进程下一次 run 即用 summary + 保留段（无需 reload）
 * 5. 新回合消息继续 append + 落盘 → loadTree → 重建结果一致（compaction 跨 run 持久）
 * 6. 简短 Branch B：从压缩前节点分叉 → 该 path 不受 compaction 影响
 *
 * 输出分三节：
 * - Persistent Session：entry 数量/父链（稳定机制，全部程序化断言）
 * - Reconstructed Context：canonical messages 组成（稳定机制，程序化断言）
 * - Model-dependent：具体摘要文本与模型回复（不做断言，仅供参考）
 *
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { rmSync } from "node:fs";
import { AnthropicLlmAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, LLMRequest, Message } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "./agent.ts";
import { appendEntries, loadTree } from "./jsonl.ts";
import { TreeSession } from "./session-tree.ts";
import { compactSession } from "./compaction.ts";

const SESSION_FILE = "/tmp/learn-pi-agent-demo-compaction.jsonl";
const HEADER = { version: 2 as const, systemPrompt: "你是一个简洁的助手。", model: "" };

/** 记录每次 LLM 输入并转发给真实端点（输入组成是结构断言，回复文本是 Model-dependent）。 */
class RecordingAdapter implements LLMAdapter {
  readonly seenInputs: Message[][] = [];

  constructor(private delegate: LLMAdapter) {}

  async *complete(input: LLMRequest, signal?: AbortSignal): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
    yield* this.delegate.complete(input, signal);
  }
}

/** 程序化断言：demo 自带结构自检，失败即抛错退出（不依赖具体模型文本）。 */
function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`结构断言失败: ${label}`);
  }
  console.log(`✓ ${label}`);
}

/** 角色摘要：toolCall 的 assistant 显示为 assistant(toolCall)。 */
function roleOf(m: Message): string {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return "assistant(toolCall)";
  }
  return m.role;
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }
  HEADER.model = model;

  // ---------------------------------------------------------------------------
  // 1. scripted 长历史（无 LLM；估算 token 1+6+1+34+1+9+1=53 > limitTokens=50，
  //    keepRecentTokens=10 → 切点落在 U3，保留段 [U3, A3]）
  // ---------------------------------------------------------------------------
  console.log("=== Persistent Session：scripted 长历史（压缩前）===");
  const tree = new TreeSession();
  const u1 = tree.appendMessage({ role: "user", text: "任务一：请实现一个计算器。" });
  const a1 = tree.appendMessage({
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
  } as AssistantMessage);
  const t1 = tree.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false });
  const u2 = tree.appendMessage({ role: "user", text: "任务二：这是一段很长的参考文档……" + "x".repeat(132) });
  const a2 = tree.appendMessage({ role: "assistant", stopReason: "end_turn", text: "回复二" } as AssistantMessage);
  const u3 = tree.appendMessage({ role: "user", text: "任务三：再加一个乘法函数。" + "y".repeat(32) });
  const a3 = tree.appendMessage({ role: "assistant", stopReason: "end_turn", text: "回复三" } as AssistantMessage);

  const oldLeaf = tree.getLeafId();
  const oldIds = tree.getEntries().map((e) => e.id);
  appendEntries(SESSION_FILE, HEADER, tree.getEntries());

  console.log(`entries: ${tree.getEntries().length}`);
  console.log(`canonical messages (${tree.buildSessionContext().length}): ${tree.buildSessionContext().map(roleOf).join(", ")}`);

  // ---------------------------------------------------------------------------
  // 2. 压缩发生前进程内已有 Agent（initialMessages = 完整路径 7 条）
  // ---------------------------------------------------------------------------
  const recording = new RecordingAdapter(new AnthropicLlmAdapter());
  const agent = new Agent({
    systemPrompt: HEADER.systemPrompt,
    tools: [],
    llm: recording,
    config: { model },
    initialMessages: tree.getMessages(),
  });
  check(agent.state.messages.length === 7, "压缩前 Agent 持有完整路径 7 条消息");

  // ---------------------------------------------------------------------------
  // 3. compactSession（真实 LLM 摘要）
  // ---------------------------------------------------------------------------
  console.log("\n=== Persistent Session：compaction（append CompactionEntry）===");
  const result = await compactSession(tree, new AnthropicLlmAdapter(), model, { limitTokens: 50, keepRecentTokens: 10 });
  if (!result) {
    throw new Error("compactSession 返回 null（历史未超限或摘要失败）");
  }

  console.log("\n=== Model-dependent：摘要文本 ===");
  console.log(result.summary);

  console.log("\n=== Persistent Session：结构断言 ===");
  const entriesAfter = tree.getEntries();
  check(entriesAfter.length === oldIds.length + 1, `entries ${oldIds.length} → ${entriesAfter.length}（+1，纯追加）`);
  check(oldIds.every((id) => entriesAfter.some((e) => e.id === id)), "旧 history 一条不少（old entries removed: 0）");
  const compactionEntry = entriesAfter.find((e) => e.type === "compaction");
  check(compactionEntry !== undefined && compactionEntry.parentId === oldLeaf, "CompactionEntry.parentId = 旧 leaf（A3）");
  check(tree.getLeafId() === compactionEntry?.id, "append 后 leaf = CompactionEntry");
  check(result.firstKeptEntryId === u3.id, "firstKeptEntryId = 第一个保留 entry（U3）");
  check(compactionEntry !== undefined && compactionEntry.parentId === a3.id, "compaction parent 具体为 A3");
  if (!compactionEntry) {
    throw new Error("CompactionEntry 缺失");
  }
  // 落盘：CompactionEntry 与普通 entry 一样追加进 session 文件（Pi AgentSession 自动持久化，教学由 demo 显式调用）
  appendEntries(SESSION_FILE, HEADER, [compactionEntry]);

  console.log("\n=== Reconstructed Context：buildSessionContext ===");
  const context = result.context;
  console.log(`before: 7 messages`);
  console.log(`after:  ${context.length} messages`);
  console.log(`roles:  ${context.map(roleOf).join(", ")}`);
  check(context.length === 3, "context = summary + U3 + A3（3 条）");
  check(context[0].role === "user" && context[0].text?.includes("<summary>") === true, "summary 投影为带 <summary> 标记的 user 消息");
  check(context[1].role === "user" && context[2].role === "assistant", "保留段 [U3, A3] verbatim");

  // ---------------------------------------------------------------------------
  // 4. canonical state 刷新（无需 reload）：同一进程下一次 run 使用 summary + 保留段
  // ---------------------------------------------------------------------------
  console.log("\n=== canonical state 刷新（agent.replaceMessages，无需 reload）===");
  agent.replaceMessages(result.context); // Pi agent-session.ts L2004-2007 的 seam
  check(agent.state.messages.length === 3, "替换后 Agent 状态 = 重建 context（3 条）");

  await agent.prompt("任务四：总结一下我们目前完成的工作。");
  const firstInput = recording.seenInputs[0];
  console.log(`本次 LLM 输入 (${firstInput.length}): ${firstInput.map(roleOf).join(", ")}`);
  check(firstInput.length === 4, "输入 = summary + U3 + A3 + 新 prompt（4 条）");
  check(firstInput[0].text?.includes("<summary>") === true, "输入以 summary 消息开头");
  check(firstInput.filter((m) => m.text?.includes("<summary>")).length === 1, "summary 消息恰好一条");
  check(firstInput.slice(1).some((m) => m.text?.includes("任务一")) === false, "旧前缀内容只存在于 summary 中，不重复出现在输入里");
  check(firstInput.some((m) => m.toolCalls && m.toolCalls.length > 0) === false, "旧 toolCall（A1）不在本次输入中");

  console.log("\n=== Model-dependent：模型基于「摘要 + 保留段」的回复 ===");
  const reply = agent.state.messages.at(-1);
  console.log(reply?.text ?? "(无)");

  // 新回合消息继续 append（首条挂在 CompactionEntry 之下）并落盘
  const newEntries = agent.state.messages.slice(3).map((m) => tree.appendMessage(m));
  check(newEntries.length === 2 && newEntries[0].parentId === compactionEntry?.id, "新回合首条 entry 挂在 CompactionEntry 之下");
  appendEntries(SESSION_FILE, HEADER, newEntries);

  // ---------------------------------------------------------------------------
  // 5. 落盘 → 恢复：reconstruction 一致（compaction 跨 run 持久）
  // ---------------------------------------------------------------------------
  console.log("\n=== 从文件恢复（save/load 幂等）===");
  const loaded = loadTree(SESSION_FILE);
  if (!loaded) {
    throw new Error("会话恢复失败");
  }
  const reloadedContext = loaded.tree.buildSessionContext();
  console.log(`reloaded canonical messages (${reloadedContext.length}): ${reloadedContext.map(roleOf).join(", ")}`);
  check(reloadedContext.length === 5, "恢复后 = summary + U3 + A3 + 任务四 + 回复（5 条）");
  check(reloadedContext[0].text?.includes("<summary>") === true, "恢复后 summary 消息仍在首位");
  check(loaded.tree.getEntries().length === tree.getEntries().length, "恢复后 full entries 数量一致（历史仍可查）");

  // ---------------------------------------------------------------------------
  // 6. Branch B：从压缩前节点分叉（不经过 CompactionEntry）
  // ---------------------------------------------------------------------------
  console.log("\n=== Branch B：从压缩前的 U2 分叉 ===");
  tree.branch(u2.id);
  tree.appendMessage({ role: "user", text: "分支B：换个思路重写。" });
  const branchBContext = tree.buildSessionContext();
  console.log(`branch B canonical messages (${branchBContext.length}): ${branchBContext.map(roleOf).join(", ")}`);
  check(branchBContext.some((m) => m.text?.includes("<summary>")) === false, "分支 B path 不含 compaction → 完整原历史、0 条 summary");
}

main()
  .finally(() => {
    rmSync(SESSION_FILE, { force: true }); // 失败路径也清理会话文件
  })
  .catch((error: unknown) => {
    console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
