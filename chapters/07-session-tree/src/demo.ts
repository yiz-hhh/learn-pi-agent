/**
 * 真实 API 演示：Agent 封装 + Entry 树会话（07 章 Phase 2）。
 * 流程：分支 A 提问 → resetLeaf（Pi navigateTree 对 root user 的语义：重写首条提问 = leaf 移到其 parent）
 * → 分支 B 全新根提问 → 结构断言 → 文件恢复（leaf = 分支 B）→ branch-at 切回分支 A 继续 → 打印树。
 * 原语选择锚定 Pi 产品层语义（agent-session.ts L3208-3249）：
 * 重写一条 user 提问用 resetLeaf（root 特例）；从 assistant/toolResult 等已有状态继续用 branch。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "./agent.ts";
import { clearSession } from "./session.ts";
import { appendEntries, loadTree } from "./jsonl.ts";
import { TreeSession, type Entry, type MessageEntry, type TreeNode } from "./session-tree.ts";

const SESSION_FILE = "/tmp/learn-pi-agent-demo-session-tree.jsonl";
const HEADER = { version: 2 as const, systemPrompt: "你是一个计算助手，回答要简洁。", model: "" };

/** 一次完整回合：以当前分支路径为 initialMessages 重建 Agent，结束后把新消息写进树并落盘。 */
async function runTurn(tree: TreeSession, input: string): Promise<void> {
  const agent = new Agent({
    systemPrompt: HEADER.systemPrompt,
    tools: [createCalculatorTool()],
    llm: new AnthropicLlmAdapter(),
    config: { model: HEADER.model },
    initialMessages: tree.getMessages(),
  });
  agent.subscribe((event) => {
    if (event.type === "turn_start") console.log("-- 回合开始");
    if (event.type === "tool_execution_end") console.log(`· 工具: ${event.toolName} → ${event.result.content}`);
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.text) {
      console.log(`· 回复: ${event.message.text}`);
    }
  });
  const before = tree.getMessages().length;
  await agent.prompt(input);
  const entries = agent.state.messages.slice(before).map((m) => tree.appendMessage(m));
  appendEntries(SESSION_FILE, HEADER, entries);
}

/** 树结构文本渲染（缩进 + leaf 标记）。 */
function renderTree(tree: TreeSession, node: TreeNode, depth: number, out: string[]): void {
  const e = node.entry;
  const label =
    e.type === "message"
      ? `${(e as MessageEntry).message.role}: ${((e as MessageEntry).message.text ?? "(工具调用)").slice(0, 30)}`
      : `custom(${(e as Entry & { customType: string }).customType})`;
  const leafMark = e.id === tree.getLeafId() ? " ← leaf" : "";
  out.push("  ".repeat(depth) + `${e.id} [${label}]${leafMark}`);
  for (const child of node.children) {
    renderTree(tree, child, depth + 1, out);
  }
}

/** 程序化断言：demo 自带结构自检，失败即抛错退出（不依赖具体模型文本或固定 entry 数量）。 */
function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`结构断言失败: ${label}`);
  }
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }
  HEADER.model = model;

  console.log("=== Phase 1（session.ts 线性）===");
  console.log("线性 JSONL 只能顺序追加：想回到第 1 条消息继续，只能复制文件再截断；分支需另开文件。");
  console.log("升级：Entry{id,parentId} 树（session-tree.ts + jsonl.ts），分支只移 leaf 指针。\n");

  console.log("=== 会话：Entry 树（分支 A / 全新分支 B / branch-at 继续 / 恢复）===");
  const tree = new TreeSession();

  // 分支 A：提问，记录 root 与最新回复（后者是 branch-at 的合法目标：非 user entry）
  console.log("\n[分支 A] 第一问：");
  await runTurn(tree, "请计算 12 + 30 等于多少？");
  const branchARootId = tree.getBranch()[0].id;
  const branchAReplyId = tree.getLeafId()!;
  const branchAPathIds = tree.getBranch().map((e) => e.id);
  const entriesBeforeReset = tree.getEntries().length;

  // 全新问题：Pi navigateTree 对 user 目标 = leaf 移到 target.parentId（root user → null），文本进编辑器重写。
  // 教学没有 editor 编排，用 resetLeaf() 表达同一语义——分支 B 不共享 A 的 root user。
  console.log("\n[分支 B] 全新问题（resetLeaf，不共享 A 的 root user）：");
  tree.resetLeaf();
  check(tree.getLeafId() === null, "resetLeaf 后 leaf 为空");
  check(tree.getEntries().length === entriesBeforeReset, "resetLeaf 不删改任何已有 entry");

  await runTurn(tree, "请计算 100 - 40 等于多少？");
  const branchBLeafId = tree.getLeafId()!;
  const branchBPathIds = tree.getBranch().map((e) => e.id);

  check(tree.getEntry(branchBPathIds[0])?.parentId === null, "分支 B 首条 entry 成为新根（parentId === null）");
  check(branchBPathIds[0] !== branchARootId, "分支 B 根 ≠ 分支 A 根");
  check(branchBPathIds.every((id) => !branchAPathIds.includes(id)), "分支 B 路径与 A 零共享（不含 A 的 root user 与回复）");
  check(tree.getBranch(branchAReplyId).map((e) => e.id).join() === branchAPathIds.join(), "分支 A 原路径仍可完整重建");
  check(tree.getEntries().length === entriesBeforeReset + branchBPathIds.length, "A/B 两支同在一个 append-only entry 集合");

  // 落盘 → 恢复：leaf = 最后 append 的分支 B
  const loaded = loadTree(SESSION_FILE);
  if (!loaded) {
    throw new Error("会话恢复失败");
  }
  console.log("\n=== 从文件恢复 ===");
  check(loaded.tree.getLeafId() === branchBLeafId, "恢复后 active leaf = 最后 append 的分支 B");
  check(loaded.tree.getBranch().map((e) => e.id).join() === branchBPathIds.join(), "恢复后重建 = 仅分支 B 路径");
  check(loaded.tree.getBranch(branchAReplyId).map((e) => e.id).join() === branchAPathIds.join(), "旧分支 A 仍可通过其 leaf id 重建");

  // 切回分支 A 继续：目标是 assistant 回复（非 user entry）→ branch AT，目标保留在新路径中
  console.log("\n[分支 A] branch-at 继续（目标为 assistant 回复）：");
  tree.branch(branchAReplyId);
  await runTurn(tree, "很好，再算一下 5 * 3 等于多少？");
  check(tree.getBranch(branchBLeafId).map((e) => e.id).join() === branchBPathIds.join(), "A 支继续后，分支 B 路径原样未动");

  // 树结构与 leaf（双根并存：分支 A 根 + 分支 B 根）
  const out: string[] = [];
  for (const node of tree.getTree()) {
    renderTree(tree, node, 0, out);
  }
  console.log("\n=== 树结构（分支 A/B 并存，双根）===");
  console.log(out.join("\n"));
  console.log(`leaf: ${tree.getLeafId()}`);
}

main()
  .finally(() => {
    clearSession(SESSION_FILE); // finally 先于 catch，保证失败路径也清理会话文件
  })
  .catch((error: unknown) => {
    console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
