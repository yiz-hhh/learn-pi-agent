/**
 * 07 章测试（Phase 2）：Entry 树会话。
 * 覆盖：append 后 leaf 移动、fork 双支隔离、navigate 回溯、向根查询、custom entry、
 * getTree/getChildren、JSONL round-trip 与容错、分支后继续对话集成、
 * 恢复后 leaf 正确、树价值（状态从分支路径推导）。
 * 流式 mock LLM 驱动（离线）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { appendEntries, loadTree } from "../src/jsonl.ts";
import { TreeSession, type Entry, type MessageEntry } from "../src/session-tree.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：步骤用尽后重复最后一步。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(): AsyncIterable<AssistantMessageEvent> {
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
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

function makeAgent(llm: LLMAdapter, initialMessages?: Message[], tools: Tool[] = [createCalculatorTool()]): Agent {
  return new Agent({
    systemPrompt: "助手",
    tools,
    llm,
    config: { model: "m" },
    initialMessages,
  });
}

/**
 * 把 Agent 的新增消息写进树并落盘（Pi AgentSession 的 message_end → appendMessage 模式）。
 * 新增消息 = agent.state.messages 中超出「当前分支消息数」的部分。
 */
function persist(tree: TreeSession, agent: Agent, file: string): void {
  const before = tree.getMessages().length;
  const entries = agent.state.messages.slice(before).map((m) => tree.appendMessage(m));
  appendEntries(file, { version: 2, systemPrompt: "助手", model: "m" }, entries);
}

/** 计数器工具：状态存 tool result details，reconstruct 从分支路径推导（todo.ts 机制的最小版）。 */
function createCounterTool(): Tool & { count: number; reconstruct: (entries: Entry[]) => void } {
  const tool = {
    count: 0,
    name: "counter",
    description: "计数器",
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.count += 1;
      return { content: `count=${tool.count}`, details: { count: tool.count } };
    },
    reconstruct(entries: Entry[]) {
      tool.count = 0;
      for (const e of entries) {
        if (e.type !== "message") continue;
        const m = (e as MessageEntry).message;
        if (m.role === "toolResult" && m.toolName === "counter") {
          const details = m.details as { count?: number } | undefined;
          if (typeof details?.count === "number") tool.count = details.count;
        }
      }
    },
  } as Tool & { count: number; reconstruct: (entries: Entry[]) => void };
  return tool;
}

/** 临时会话文件（afterEach 统一清理）。 */
let tempRoot: string | undefined;
function tempFile(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "lpia-07-"));
  return join(tempRoot, "session.jsonl");
}

describe("Entry 树（07 章 Phase 2）", () => {
  it("append 后 leaf 移动：新 entry 成为 leaf，parentId 挂到当前 leaf（Pi _appendEntry L1045-1050）", () => {
    const tree = new TreeSession();
    const e1 = tree.appendMessage({ role: "user", text: "你好" });
    expect(tree.getLeafId()).toBe(e1.id);
    expect(e1.parentId).toBeNull(); // 首条 entry 是根
    const e2 = tree.appendMessage({ role: "assistant", text: "回复" });
    expect(tree.getLeafId()).toBe(e2.id);
    expect(e2.parentId).toBe(e1.id);
  });

  it("fork 双支隔离：branch 回历史点 append 出新支，两支互不污染（Pi branch L1361-1366）", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "A1" });
    const a1 = tree.appendMessage({ role: "assistant", text: "A 回复" });
    tree.branch(u1.id); // 分叉到根
    const b1 = tree.appendMessage({ role: "user", text: "B1" });
    const b2 = tree.appendMessage({ role: "assistant", text: "B 回复" });
    // leaf 在 B 支
    expect(tree.getLeafId()).toBe(b2.id);
    // 两支路径互不污染
    expect(tree.getBranch(a1.id).map((e) => e.id)).toEqual([u1.id, a1.id]);
    expect(tree.getBranch().map((e) => e.id)).toEqual([u1.id, b1.id, b2.id]);
    // A 支没有 B 的 entry
    expect(tree.getChildren(u1.id).map((e) => e.id)).toEqual([a1.id, b1.id]);
  });

  it("navigate：切到历史 entry 后 leaf 正确，再从该点 append 生成新子支", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    const a1 = tree.appendMessage({ role: "assistant", text: "R1" });
    const a2 = tree.appendMessage({ role: "assistant", text: "R2" });
    tree.branch(a1.id); // 切到历史 entry
    expect(tree.getLeafId()).toBe(a1.id);
    const a3 = tree.appendMessage({ role: "assistant", text: "R3" });
    expect(a3.parentId).toBe(a1.id);
    expect(tree.getLeafId()).toBe(a3.id);
    expect(tree.getEntry(a2.id)).toBeDefined(); // 原路径 R2 仍在（append-only，不删除）
  });

  it("getBranch 向根查询（root→leaf 顺序）；branch 不存在的 entry 抛错", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    const a1 = tree.appendMessage({ role: "assistant", text: "R" });
    expect(tree.getBranch().map((e) => e.id)).toEqual([u1.id, a1.id]); // 默认从 leaf 起
    expect(tree.getBranch(u1.id).map((e) => e.id)).toEqual([u1.id]);
    expect(() => tree.branch("nope")).toThrow("not found"); // Pi L1361-1366 校验
  });

  it("custom entry：入树、leaf 前进、不参与消息路径（Pi CustomEntry，不进 LLM 上下文）", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    const c1 = tree.appendCustomEntry("todo", { count: 1 });
    expect(tree.getEntry(c1.id)).toBeDefined();
    expect(c1.parentId).toBe(u1.id);
    expect(tree.getLeafId()).toBe(c1.id);
    expect(tree.getMessages()).toHaveLength(1); // custom 不产消息
    expect(tree.getMessages()[0]).toMatchObject({ role: "user", text: "Q" });
  });

  it("getTree：多支结构正确、孤儿 entry 当根、children 按 timestamp 排序（Pi L1311-1349）", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    tree.appendMessage({ role: "assistant", text: "R1" });
    tree.branch(u1.id);
    const b1 = tree.appendMessage({ role: "assistant", text: "R2" });
    const roots = tree.getTree();
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.entry.id)).toEqual([tree.getChildren(u1.id)[0].id, b1.id]); // 按 timestamp
    // 孤儿当根：parent 缺失的 entry 独立成根（Pi L1332-1335）
    const orphan: Entry = {
      type: "message",
      id: "o1",
      parentId: "ghost",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", text: "孤儿" },
    };
    tree.load([...tree.getEntries(), orphan]);
    expect(tree.getTree()).toHaveLength(2);
  });
});

describe("JSONL 持久化（07 章 Phase 2）", () => {
  it("round-trip：save → load 结构一致、leaf 正确（分支态）", () => {
    const file = tempFile();
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "A1" });
    const a1 = tree.appendMessage({ role: "assistant", text: "A 回复" });
    tree.branch(u1.id);
    const b1 = tree.appendMessage({ role: "user", text: "B1" });
    appendEntries(file, { version: 2, systemPrompt: "助手", model: "m" }, tree.getEntries());

    const loaded = loadTree(file);
    expect(loaded).not.toBeNull();
    expect(loaded?.header).toMatchObject({ systemPrompt: "助手", model: "m" });
    expect(loaded?.tree.getEntries()).toHaveLength(3);
    expect(loaded?.tree.getLeafId()).toBe(b1.id); // 恢复后 leaf = 最后一条 entry（Pi _buildIndex L959）
    expect(loaded?.tree.getBranch(a1.id).map((e) => e.id)).toEqual([u1.id, a1.id]); // A 支完好
  });

  it("JSONL 容错：损坏行跳过、缺尾换行 append 先补换行", () => {
    const file = tempFile();
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "第一条" });
    const a1 = tree.appendMessage({ role: "assistant", text: "第二条" });
    appendEntries(file, { version: 2, systemPrompt: "助手", model: "m" }, tree.getEntries());
    // 破坏中间行：单行损坏不杀死整个会话
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l);
    writeFileSync(file, [lines[0], "{{{broken", ...lines.slice(1)].join("\n") + "\n", "utf8");
    const loaded = loadTree(file);
    expect(loaded?.tree.getMessages().map((m) => m.text)).toEqual(["第一条", "第二条"]);
    expect(loaded?.tree.getLeafId()).toBe(a1.id);
    // 缺尾换行：外部写入后无换行 → append 先补换行，不合并损坏
    writeFileSync(file, raw.trimEnd(), "utf8");
    const tree2 = new TreeSession();
    tree2.load(tree.getEntries()); // 复用现有 entry，leaf 落在最后一条（追加位置正确）
    const u2 = tree2.appendMessage({ role: "user", text: "第三条" });
    appendEntries(file, { version: 2, systemPrompt: "助手", model: "m" }, [u2]);
    const loaded2 = loadTree(file);
    expect(loaded2?.tree.getMessages().map((m) => m.text)).toEqual(["第一条", "第二条", "第三条"]);
  });

  it("文件不存在返回 null；头损坏返回 null（不可恢复语义）", () => {
    const file = tempFile();
    expect(loadTree(file)).toBeNull();
    writeFileSync(file, '{"version": 1, "systemPrompt": "x", "model": "m"}\n', "utf8"); // v1 线性头不匹配 v2
    expect(loadTree(file)).toBeNull();
    writeFileSync(file, "not json\n", "utf8");
    expect(loadTree(file)).toBeNull();
  });
});

describe("集成（07 章 Phase 2，scripted LLM）", () => {
  it("分支后继续对话：切到历史 entry 重建 Agent，新分支与旧分支消息序列正确", async () => {
    const file = tempFile();
    const tree = new TreeSession();
    // 分支 A：算 1+2
    const agentA = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]),
    );
    await agentA.prompt("算 1+2");
    persist(tree, agentA, file);
    const a1Reply = tree.getLeafId()!;
    const branchPoint = tree.getBranch()[0].id;
    // 分支 B：从根分叉，算 3+4
    tree.branch(branchPoint);
    const agentB = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c2", name: "calculator", args: { a: 3, b: 4 } }]), textStream("7")]),
      tree.getMessages(),
    );
    await agentB.prompt("算 3+4");
    persist(tree, agentB, file);
    // 两支隔离：同根、第二层就分叉、消息互不污染
    // 分支 B 路径 = u1 + userB + b1(tool) + trB + b1text（5 条）；分支 A 路径 = u1 + a1(tool) + tr1 + a1text（4 条）
    expect(tree.getBranch()[0].id).toBe(branchPoint);
    expect(tree.getBranch()).toHaveLength(5);
    expect(tree.getBranch(a1Reply)).toHaveLength(4);
    expect(tree.getBranch()[1].id).not.toBe(tree.getBranch(a1Reply)[1].id);
    expect(tree.getMessages().at(-1)).toMatchObject({ role: "assistant", text: "7" });
  });

  it("保存恢复后 leaf 正确，继续对话落在原分支", async () => {
    const file = tempFile();
    const tree = new TreeSession();
    // 分支 A
    const agentA = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]),
    );
    await agentA.prompt("算 1+2");
    persist(tree, agentA, file);
    const branchPoint = tree.getBranch()[0].id;
    // 分支 B
    tree.branch(branchPoint);
    const agentB = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c2", name: "calculator", args: { a: 3, b: 4 } }]), textStream("7")]),
      tree.getMessages(),
    );
    await agentB.prompt("算 3+4");
    persist(tree, agentB, file);
    const bLeaf = tree.getLeafId()!;
    // 恢复：leaf 正确落在 B 支
    const loaded = loadTree(file);
    expect(loaded).not.toBeNull();
    expect(loaded?.tree.getLeafId()).toBe(bLeaf);
    // 继续对话落在原分支（历史从 B 支路径恢复）
    const agentC = makeAgent(new ScriptedLlm([textStream("第二轮")]), loaded!.tree.getMessages());
    await agentC.prompt("再来一轮");
    expect(agentC.state.messages).toHaveLength(loaded!.tree.getMessages().length + 2);
    expect(agentC.state.messages[0]).toMatchObject({ text: "算 1+2" });
  });

  it("树价值：状态存工具结果，分支回溯后按路径推导的状态回到历史值（todo.ts 机制）", async () => {
    const counter = createCounterTool();
    const file = tempFile();
    const tree = new TreeSession();
    const agent = makeAgent(
      new ScriptedLlm([
        toolStream([{ id: "c1", name: "counter", args: {} }]),
        textStream("1"),
        toolStream([{ id: "c2", name: "counter", args: {} }]),
        textStream("2"),
      ]),
      undefined,
      [counter],
    );
    await agent.prompt("计数");
    persist(tree, agent, file);
    await agent.prompt("再计数");
    persist(tree, agent, file);
    expect(counter.count).toBe(2);
    // 分支回溯：回到第一条 counter 工具结果 entry，状态推导回 count=1
    const toolResults = tree
      .getEntries()
      .filter((e) => e.type === "message" && (e as MessageEntry).message.role === "toolResult" && (e as MessageEntry).message.toolName === "counter");
    expect(toolResults).toHaveLength(2);
    tree.branch(toolResults[0].id);
    counter.reconstruct(tree.getBranch());
    expect(counter.count).toBe(1);
    // 回到根：状态清零
    tree.branch(tree.getBranch()[0].id);
    counter.reconstruct(tree.getBranch());
    expect(counter.count).toBe(0);
  });
});

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});
