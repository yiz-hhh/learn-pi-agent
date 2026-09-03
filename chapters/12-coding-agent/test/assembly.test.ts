/**
 * 12 章测试：组装集成（原 10 章 Trace it 离线验证的延续）。
 * 00-09 全部机制在一次 run 中协同：Agent 封装（07）+ skills（09）+ 动态工具（09）。
 * 08 层 Session Compaction 的组装接入见本文件后段 describe（saveSession 触发，
 * 不经 transformContext——压缩归 Session 生命周期，与 08 章语义一致）。
 * 流式 mock LLM 驱动（离线）。12 章新增的产品链路见 e2e.test.ts。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { appendEntries, loadTree } from "../src/jsonl.ts";
import { TreeSession } from "../src/session-tree.ts";
import { createCodingAgent } from "../src/assembly.ts";
import { createToolRegistry, formatSkillsForSystemPrompt, readSkillContent } from "../src/extensions.ts";
import type { ExtensionFactory } from "../../10-extension-runtime/src/extension-api.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：记录输入（transformContext 后的消息），按步骤回放（用尽后重复最后一步）。 */
class ChatLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenInputs: Message[][] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

/** 混合 mock LLM：摘要调用（systemPrompt 含「摘要助手」）返回固定摘要，其余调用记录输入并回脚本回复。 */
class CompactingLlm implements LLMAdapter {
  readonly seenInputs: Message[][] = [];

  constructor(
    private summaryText: string,
    private chatText = "回复",
  ) {}

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
    const text = input.systemPrompt.includes("摘要助手") ? this.summaryText : this.chatText;
    yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
    yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } };
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  } as const;
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
    { type: "done", partial },
  ];
}

function unlockTool(): Tool {
  return {
    name: "unlock_echo",
    description: "解锁 echo 工具",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "已解锁", addedToolNames: ["echo"] };
    },
  };
}

/** 按需读取工具（09 章技能机制）：凭 location 读取技能文件。 */
function readSkillTool(filePath: string): Tool {
  return {
    name: "read_skill",
    description: "读取技能文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(args: { path: string }) {
      return { content: readSkillContent(args.path) };
    },
  };
}

/** 记录 transformContext 时看到的 canonical context，并追加一条注入消息（10 章 Inject）。 */
function markerExtension(seen: Message[][]): ExtensionFactory {
  return (pi) => {
    pi.on("context", async (event) => {
      seen.push([...event.messages]);
      return [...event.messages, { role: "user", text: "[扩展注入标记]" }];
    });
  };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "lpia-10-")), "session.jsonl");
}

describe("组装集成（10 章，Trace it 离线验证）", () => {
  it("00-09 协同：技能目录 + 按需读取 + 动态工具 + Agent 状态", async () => {
    const skillFile = join(mkdtempSync(join(tmpdir(), "lpia-10-")), "calc.md");
    writeFileSync(skillFile, "用 calculator 计算", "utf8");
    const chat = new ChatLlm([
      toolStream([{ id: "c1", name: "read_skill", args: { path: skillFile } }]),
      toolStream([{ id: "c2", name: "unlock_echo", args: {} }]),
      toolStream([{ id: "c3", name: "echo", args: { text: "你好" } }]),
      textStream("全部完成"),
    ]);
    const registry = createToolRegistry([createEchoTool()]);
    const skillsBlock = formatSkillsForSystemPrompt([
      { name: "calc", description: "计算", content: readSkillContent(skillFile), filePath: skillFile },
    ]);
    const systemPrompt = "你是一个计算助手。\n" + skillsBlock;

    const agent = new Agent({
      systemPrompt,
      tools: [createCalculatorTool(), unlockTool(), readSkillTool(skillFile)],
      llm: chat,
      config: {
        model: "m",
        // 动态工具（09）
        loadTools: (names) => registry.load(names),
      },
    });
    const toolEvents: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") toolEvents.push(event.toolName);
    });

    await agent.prompt("解锁并回显");

    // 1. 技能目录在 systemPrompt：含 location，content 不在其中（层 2/09）
    expect(agent.state.systemPrompt).toContain("<available_skills>");
    expect(agent.state.systemPrompt).toContain(skillFile);
    expect(agent.state.systemPrompt).not.toContain("用 calculator 计算");
    // 1.5 按需读取：read_skill 把技能内容带回历史（层 2/09）
    const readResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "read_skill");
    expect(readResult?.text).toContain("用 calculator 计算");
    // 2. 动态工具：unlock 后 echo 在后续轮次可用（层 8/09）
    expect(
      chat.seenInputs.slice(1).some((msgs) => msgs.some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "echo"))),
    ).toBe(true);
    // 3. 工具事件完整（层 6/02）
    expect(toolEvents).toContain("read_skill");
    expect(toolEvents).toContain("unlock_echo");
    expect(toolEvents).toContain("echo");
    // 4. Agent 状态累积（层 5/07）
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "全部完成" });
    expect(agent.state.isStreaming).toBe(false);
  });

  it("会话持久化：run 后保存 → 恢复继续（层 7/08，跨 run 记忆）", async () => {
    const file = tempFile();
    const chat1 = new ChatLlm([textStream("第一轮回复")]);
    const agent1 = new Agent({
      systemPrompt: "助手",
      tools: [createCalculatorTool()],
      llm: chat1,
      config: { model: "m" },
    });
    await agent1.prompt("算 1+2");
    // 消息写进 Entry 树（append-only），entry 行落盘（v2 格式）
    const tree = new TreeSession();
    const entries = agent1.state.messages.map((m) => tree.appendMessage(m));
    appendEntries(file, { version: 2, systemPrompt: "助手", model: "m" }, entries);

    // 恢复 → 继续（leaf = 最后一条 entry，Pi _buildIndex）
    const loaded = loadTree(file);
    expect(loaded?.tree.getMessages()).toHaveLength(2);
    expect(loaded?.tree.getLeafId()).toBe(entries[entries.length - 1].id);
    const chat2 = new ChatLlm([textStream("第二轮回复")]);
    const agent2 = new Agent({
      systemPrompt: "助手",
      tools: [createCalculatorTool()],
      llm: chat2,
      config: { model: "m" },
      initialMessages: loaded?.tree.getMessages(),
    });
    await agent2.prompt("继续");
    expect(agent2.state.messages).toHaveLength(4); // 恢复 2 + 新 prompt + 回复
    expect(agent2.state.messages[0]).toMatchObject({ role: "user", text: "算 1+2" });

    rmSync(join(tmpdir(), "lpia-10-"), { recursive: true, force: true });
  });
});

/** 08 层压缩历史（估算 token ≈ 4+6+1+38+2+11+2 = 64 > limitTokens=50；keepRecentTokens=10 → 切点落在 U3）。 */
const compactionHistory: Message[] = [
  { role: "user", text: "任务一：请实现一个计算器。" },
  {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
  } as Message,
  { role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false },
  { role: "user", text: "任务二：这是一段很长的参考文档……" + "x".repeat(132) },
  { role: "assistant", stopReason: "end_turn", text: "回复二" } as Message,
  { role: "user", text: "任务三：再加一个乘法函数。" + "y".repeat(32) },
  { role: "assistant", stopReason: "end_turn", text: "回复三" } as Message,
];

const COMPACT_SETTINGS = { limitTokens: 50, keepRecentTokens: 10 };

describe("08 层：Session Compaction 接入（saveSession 触发，不经 transformContext）", () => {
  it("saveSession 压缩：旧 entries 不删、CompactionEntry 追加、agent state = 重建 context", async () => {
    const llm = new CompactingLlm("【摘要】前五个回合实现并讨论了计算器");
    const assembly = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm,
      skills: [],
      compact: COMPACT_SETTINGS,
    });
    assembly.agent.state.messages.push(...compactionHistory);
    await assembly.saveSession();

    // 1. Session source of truth：7 条消息 entry 一条不少，CompactionEntry 纯追加
    const entries = assembly.session.getEntries();
    expect(entries.filter((e) => e.type === "message")).toHaveLength(7);
    const compaction = entries.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction?.parentId).toBe(entries[6].id); // 旧 leaf = A3 的 entry
    expect(assembly.session.getLeafId()).toBe(compaction?.id);
    // 2. 重建投影缩短：summary + U3 + A3（3 条，而非完整 7 条）
    const context = assembly.session.buildSessionContext();
    expect(context).toHaveLength(3);
    expect(context[0].text).toContain("<summary>");
    expect(context[1].text).toContain("任务三");
    // 3. canonical state 同步刷新（replaceMessages seam，Pi agent-session.ts L2004-2007）
    expect(assembly.agent.state.messages).toHaveLength(3);
    expect(assembly.agent.state.messages[0].text).toContain("<summary>");
    // 4. 摘要 LLM 收到的是被压前缀（5 条），不是全量历史
    expect(llm.seenInputs[0]).toHaveLength(5);
  });

  it("压缩后下一 run 使用重建 context（provider 输入 = summary + 保留段 + 新 prompt）", async () => {
    const llm = new CompactingLlm("【摘要】早期任务");
    const assembly = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm,
      skills: [],
      compact: COMPACT_SETTINGS,
    });
    assembly.agent.state.messages.push(...compactionHistory);
    await assembly.saveSession();

    await assembly.agent.prompt("任务四：继续");

    const chatInput = llm.seenInputs.at(-1)!;
    expect(chatInput).toHaveLength(4); // summary + U3 + A3 + 新 prompt
    expect(chatInput[0].text).toContain("<summary>");
    expect(chatInput.some((m) => m.text?.includes("任务一"))).toBe(false);
    expect(chatInput.at(-1)?.text).toBe("任务四：继续");
  });

  it("压缩跨 run 持久：恢复走 buildSessionContext（summary + 保留段，非完整历史）", async () => {
    const file = tempFile();
    const a1 = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm: new CompactingLlm("【摘要】早期任务"),
      skills: [],
      sessionFile: file,
      compact: COMPACT_SETTINGS,
    });
    a1.agent.state.messages.push(...compactionHistory);
    await a1.saveSession();

    // CompactionEntry 与消息一样落盘（跨 run 持久）
    const loaded = loadTree(file);
    expect(loaded!.tree.getEntries().some((e) => e.type === "compaction")).toBe(true);

    // 恢复：canonical 初始消息 = 重建 context（3 条），不是完整历史（7 条）
    const a2 = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm: new CompactingLlm("【摘要】早期任务"),
      skills: [],
      sessionFile: file,
      compact: COMPACT_SETTINGS,
    });
    expect(a2.agent.state.messages).toHaveLength(3);
    expect(a2.agent.state.messages[0].text).toContain("<summary>");
    expect(a2.agent.state.messages.some((m) => m.text?.includes("任务一"))).toBe(false);
  });

  it("transformContext 仍只做 extension 注入：Compaction first、Extension second", async () => {
    const extensionSeen: Message[][] = [];
    const llm = new CompactingLlm("【摘要】早期任务");
    const assembly = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm,
      skills: [],
      extensions: [markerExtension(extensionSeen)],
      compact: COMPACT_SETTINGS,
    });
    assembly.agent.state.messages.push(...compactionHistory);
    await assembly.saveSession(); // 压缩：canonical = summary + U3 + A3

    await assembly.agent.prompt("继续");

    // 扩展注入发生在压缩之后：extension 看到的 canonical context 是重建后的 4 条，不是完整历史
    const seenByExtension = extensionSeen.at(-1)!;
    expect(seenByExtension).toHaveLength(4);
    expect(seenByExtension[0].text).toContain("<summary>");
    // provider 输入 = 重建 context + 扩展注入消息（5 条）
    const providerInput = llm.seenInputs.at(-1)!;
    expect(providerInput).toHaveLength(5);
    expect(providerInput.at(-1)?.text).toBe("[扩展注入标记]");
  });
});
