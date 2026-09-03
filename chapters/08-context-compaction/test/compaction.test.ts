/**
 * 08 章测试：Session Compaction（Compaction as an Entry）。
 *
 * 覆盖（按机制分层）：
 * - token 估算与触发：estimateTokens / shouldCompact
 * - 安全切点：user/assistant 均可切、toolResult 永不、阈值区全 toolResult 回退 0、
 *   切在 assistant(toolCall) 时其 toolResult 位于保留段
 * - structural invariant：appendCompaction 纯 additive（N→N+1、旧 entry 全在、
 *   parentId=旧 leaf、leaf 前移、后续 append 挂 compaction 之下）
 * - reconstruction：无 compaction 与 07 章 getMessages 等价（回归）；单次 compaction =
 *   summary + firstKeptEntryId 起 + 之后；firstKeptEntryId 找不到宽容降级；custom 不投影
 * - orchestration：compactSession 成功/不超限/三种摘要失败（Session 零副作用）；
 *   firstKeptEntryId 确实是第一个 retained entry
 * - canonical state 刷新：compact 后 agent.replaceMessages，同一进程下一次 run 即用
 *   summary + 保留段（无需 reload）
 * - branch-local：分支 A compact 不污染分支 B；pre-compaction 位置重建 = 完整旧历史
 * - multiple compactions：C1/C2 都在树里、reconstruction 只用 latest、原历史全在
 * - JSONL round-trip：append → load → 重建结果一致（compaction 跨 run 持久）
 * 流式 mock LLM 驱动（离线）；不依赖具体摘要文本。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { appendEntries, loadTree } from "../src/jsonl.ts";
import {
  TreeSession,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type Entry,
} from "../src/session-tree.ts";
import {
  compactSession,
  estimateTokens,
  findCutPoint,
  shouldCompact,
  type CompactionSettings,
} from "../src/compaction.ts";
import type { AssistantMessage, AssistantMessageEvent, LLMRequest, Message } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";

/** assistant 消息构造：基础 Message 不含 stopReason，需 AssistantMessage 定型。 */
function assistantMsg(text: string): AssistantMessage {
  return { role: "assistant", stopReason: "end_turn", text };
}

/** 摘要 LLM：返回固定摘要（不引用原消息；文本内容不参与结构断言）。 */
class SummaryLlm implements LLMAdapter {
  async *complete(): AsyncIterable<AssistantMessageEvent> {
    yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
    yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text: "【摘要】历史被压缩了" } };
  }
}

/** 记录每次 LLM 输入的主对话 LLM（步骤用尽后重复最后一步）。 */
class RecordingLlm implements LLMAdapter {
  private next = 0;
  readonly seenInputs: Message[][] = [];

  constructor(private steps: AssistantMessageEvent[][]) {}

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
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

/**
 * 标准长历史：U1 A1(toolCall) T1 U2(长文本) A2 U3(中长文本) A3。
 * 估算 token：1+6+1+34+1+9+1=53（limitTokens=50 触发）；keepRecentTokens=10 时
 * 从后往前累积在 U3 处达阈值（9+1≥10）→ 切点 = U3 → 保留段 [U3, A3]。
 */
function buildLongHistory(tree: TreeSession) {
  const u1 = tree.appendMessage({ role: "user", text: "任务一" });
  const a1Msg: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
  };
  const a1 = tree.appendMessage(a1Msg);
  const t1 = tree.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false });
  const u2 = tree.appendMessage({ role: "user", text: "任务二：" + "x".repeat(132) });
  const a2 = tree.appendMessage(assistantMsg("回复二"));
  const u3 = tree.appendMessage({ role: "user", text: "任务三：" + "y".repeat(32) });
  const a3 = tree.appendMessage(assistantMsg("回复三"));
  return { u1, a1, t1, u2, a2, u3, a3 };
}

/** 摘要失败 LLM（按 stopReason/异常分类）。 */
function failingLlm(kind: "error" | "aborted" | "throw"): LLMAdapter {
  return {
    async *complete(): AsyncIterable<AssistantMessageEvent> {
      if (kind === "throw") {
        throw new Error("网络中断：stream reset");
      }
      yield { type: "start", partial: { role: "assistant", stopReason: kind } };
      yield {
        type: "done",
        partial: kind === "error"
          ? { role: "assistant", stopReason: "error", errorMessage: "API 失败" }
          : { role: "assistant", stopReason: "aborted", text: "碎片文本" },
      };
    },
  };
}

const SETTINGS: CompactionSettings = { limitTokens: 50, keepRecentTokens: 10 };

// ---------------------------------------------------------------------------
// token 估算与触发
// ---------------------------------------------------------------------------

describe("estimateTokens / shouldCompact", () => {
  it("estimateTokens：字符 / 4 估算", () => {
    expect(estimateTokens({ role: "user", text: "abcd" })).toBe(1);
    expect(estimateTokens({ role: "user", text: "abcdefgh" })).toBe(2);
    expect(estimateTokens({ role: "toolResult", toolCallId: "c", toolName: "t", text: "x".repeat(400), isError: false })).toBe(100);
  });

  it("shouldCompact：估算超阈值触发", () => {
    expect(shouldCompact([{ role: "user", text: "hi" }], 10)).toBe(false);
    expect(shouldCompact([{ role: "user", text: "x".repeat(400) }], 10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findCutPoint：安全切点
// ---------------------------------------------------------------------------

describe("findCutPoint（安全切点）", () => {
  it("assistant 可以是 firstKeptEntry：切在 assistant(toolCall)，其 toolResult 位于保留段（配对不被拆开）", () => {
    const messages: Message[] = [
      { role: "user", text: "任务一" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false },
      { role: "user", text: "任务二" },
      { role: "assistant", text: "回复二" },
    ];
    // 累积在 assistant(c1)（6 token）处达阈值 → 最近合法切点 = 该 assistant（索引 1）
    const cut = findCutPoint(messages, 5);
    expect(cut).toBe(1);
    const kept = messages.slice(cut);
    expect(kept[0].role).toBe("assistant");
    expect(kept[0].toolCalls?.map((c) => c.id)).toEqual(["c1"]);
    expect(kept[1].role).toBe("toolResult");
    expect(kept[1].toolCallId).toBe("c1");
  });

  it("toolResult 永不作为切点：阈值区全 toolResult → 返回 0 不压缩", () => {
    const messages: Message[] = [
      { role: "user", text: "任务一" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false },
      { role: "toolResult", toolCallId: "c2", toolName: "echo", text: "4", isError: false },
    ];
    expect(findCutPoint(messages, 2)).toBe(0);
  });

  it("历史本身不超过 keep 窗口 → 返回 0（无需压缩）", () => {
    const messages: Message[] = [
      { role: "user", text: "任务一" },
      { role: "assistant", text: "回复一" },
    ];
    expect(findCutPoint(messages, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendCompaction：structural invariant（additive）
// ---------------------------------------------------------------------------

describe("appendCompaction（additive invariant）", () => {
  it("compact 前 N → 后 N+1；旧 entry 全在；parentId=旧 leaf；leaf 前移；后续 append 挂 compaction 之下", () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "任务一" });
    tree.appendMessage(assistantMsg("回复一"));
    const u2 = tree.appendMessage({ role: "user", text: "任务二" });

    const before = tree.getEntries();
    const oldLeaf = tree.getLeafId();
    const oldIds = before.map((e) => e.id);

    const compaction = tree.appendCompaction("摘要：已完成任务一", before[0].id, 42);

    const after = tree.getEntries();
    expect(after.length).toBe(before.length + 1);
    expect(oldIds.every((id) => after.some((e) => e.id === id))).toBe(true); // 旧 entry 一条不少
    expect(compaction.parentId).toBe(oldLeaf);
    expect(compaction.parentId).toBe(u2.id);
    expect(tree.getLeafId()).toBe(compaction.id); // append 后 leaf = CompactionEntry

    const next = tree.appendMessage({ role: "user", text: "任务三" });
    expect(next.parentId).toBe(compaction.id); // 后续新 entry 挂在 compaction 之下
  });
});

// ---------------------------------------------------------------------------
// buildContextEntries / buildSessionContext：重建投影
// ---------------------------------------------------------------------------

describe("buildContextEntries / buildSessionContext（reconstruction）", () => {
  it("无 compaction：与 07 章 getMessages 完全等价（compatibility 回归）", () => {
    const tree = new TreeSession();
    const history = buildLongHistory(tree);
    expect(tree.buildSessionContext()).toEqual(tree.getMessages());
    expect(tree.buildSessionContext().length).toBe(7);
    expect(tree.getMessages()[0]).toMatchObject(history.u1.message);
  });

  it("单次 compaction：context = summary + firstKeptEntryId 起 + 之后；firstKeptEntryId 确实是第一个 retained entry", () => {
    const tree = new TreeSession();
    const { u3 } = buildLongHistory(tree);
    const oldLeaf = tree.getLeafId();
    tree.appendCompaction("摘要：任务一与任务二已完成", u3.id, 53);

    const context = tree.buildSessionContext();
    expect(context.length).toBe(3);
    expect(context[0].role).toBe("user");
    expect(context[0].text).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(context[0].text).toContain("摘要：任务一与任务二已完成");
    expect(context[0].text).toContain(COMPACTION_SUMMARY_SUFFIX);
    expect(context[1]).toMatchObject(u3.message); // firstKeptEntryId → 第一个保留的 entry
    expect(context[1].role).toBe("user");
    expect(context[2].role).toBe("assistant");

    // 树数据不变：7 条历史 + 1 条 compaction
    const entries = tree.getEntries();
    expect(entries.length).toBe(8);
    expect(entries[7].type).toBe("compaction");
    expect(tree.getLeafId()).toBe(entries[7].id);
    expect(oldLeaf).toBe(entries[6].id);
  });

  it("firstKeptEntryId 找不到：宽容降级为 [compaction] + 之后的 entries，不抛错", () => {
    const tree = new TreeSession();
    buildLongHistory(tree);
    tree.appendCompaction("摘要", "不存在的-id", 53);
    tree.appendMessage({ role: "user", text: "任务四" });

    const context = tree.buildSessionContext();
    expect(context.length).toBe(2); // summary + 任务四
    expect(context[0].text).toContain("<summary>");
    expect(context[1]).toMatchObject({ role: "user", text: "任务四" });
  });

  it("custom entry 不产 context 消息（扩展状态不进 LLM 上下文）", () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "任务一" });
    tree.appendMessage(assistantMsg("回复一"));
    tree.appendCustomEntry("todo", { items: ["a"] });
    tree.appendMessage({ role: "user", text: "任务二" });
    tree.appendMessage(assistantMsg("回复二"));

    expect(tree.buildSessionContext().length).toBe(4);
    expect(tree.buildSessionContext().some((m) => (m as Message).role === "toolResult")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compactSession：orchestration 与失败安全
// ---------------------------------------------------------------------------

describe("compactSession（orchestration）", () => {
  it("成功：append CompactionEntry + 返回重建 context；旧 history 全保留", async () => {
    const tree = new TreeSession();
    const { u3, a3 } = buildLongHistory(tree);
    const oldLeaf = tree.getLeafId();

    const result = await compactSession(tree, new SummaryLlm(), "m", SETTINGS);

    expect(result).not.toBeNull();
    expect(result!.firstKeptEntryId).toBe(u3.id); // 第一个 retained entry 的 id
    expect(result!.tokensBefore).toBe(53);
    expect(result!.context).toEqual(tree.buildSessionContext());
    expect(result!.context.length).toBe(3);
    expect(result!.context[0].text).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(result!.context[1]).toMatchObject(u3.message);
    expect(result!.context[2]).toMatchObject(a3.message);

    const entries = tree.getEntries();
    expect(entries.length).toBe(8); // 7 + 1，无删除
    expect(entries[7].type).toBe("compaction");
    expect(entries[7].parentId).toBe(oldLeaf);
    expect(tree.getLeafId()).toBe(entries[7].id);
  });

  it("不超限：返回 null，Session 零副作用", async () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "任务一" });
    tree.appendMessage(assistantMsg("回复一"));

    const result = await compactSession(tree, new SummaryLlm(), "m", { limitTokens: 1000, keepRecentTokens: 100 });
    expect(result).toBeNull();
    expect(tree.getEntries().some((e) => e.type === "compaction")).toBe(false);
  });

  it.each(["error", "aborted", "throw"] as const)("摘要失败（%s）：不 append，Session 与 canonical state 均不变", async (kind) => {
    const tree = new TreeSession();
    buildLongHistory(tree);
    const before = tree.getEntries();
    const contextBefore = tree.buildSessionContext();

    const result = await compactSession(tree, failingLlm(kind), "m", SETTINGS);

    expect(result).toBeNull();
    expect(tree.getEntries()).toEqual(before); // 无 CompactionEntry，无任何写入
    expect(tree.buildSessionContext()).toEqual(contextBefore); // canonical 不变
  });

  it("compact 成功后 agent 状态当场刷新：同一进程下一次 run 使用 summary + 保留段（无需 reload）", async () => {
    const tree = new TreeSession();
    buildLongHistory(tree);

    // Agent 在压缩前已存在：initialMessages = 完整路径（07 章 getMessages，7 条）
    const chat = new RecordingLlm([textStream("任务四完成")]);
    const agent = new Agent({
      systemPrompt: "助手",
      tools: [],
      llm: chat,
      config: { model: "m" },
      initialMessages: tree.getMessages(),
    });
    expect(agent.state.messages.length).toBe(7);

    const result = await compactSession(tree, new SummaryLlm(), "m", SETTINGS);
    expect(result).not.toBeNull();
    agent.replaceMessages(result!.context); // Pi agent-session.ts L2004-2007 的 seam
    expect(agent.state.messages.length).toBe(3);

    await agent.prompt("任务四");

    const firstInput = chat.seenInputs[0];
    expect(firstInput.length).toBe(4); // summary + U3 + A3 + 任务四
    expect(firstInput[0].text).toContain("<summary>");
    expect(firstInput.filter((m) => m.text?.includes("<summary>")).length).toBe(1); // summary 恰好一条
    expect(firstInput.slice(1).some((m) => m.text?.includes("任务一"))).toBe(false); // 旧前缀内容只在 summary 中
    expect(firstInput.some((m) => m.toolCalls && m.toolCalls.length > 0)).toBe(false); // A1 的 toolCall 不在输入中
    expect(firstInput.at(-1)).toMatchObject({ role: "user", text: "任务四" });
  });
});

// ---------------------------------------------------------------------------
// branch-local semantics
// ---------------------------------------------------------------------------

describe("branch-local（compaction 只影响其 descendant path）", () => {
  it("分支 A compact 不污染分支 B；pre-compaction 位置重建 = 完整旧历史", () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "任务一" });
    const a1 = tree.appendMessage(assistantMsg("回复一"));

    // 分支 A：从 A1 继续并 compact
    const u2a = tree.appendMessage({ role: "user", text: "任务A" });
    const a2a = tree.appendMessage(assistantMsg("回复A"));
    tree.appendCompaction("摘要A", u2a.id, 100);
    const branchALeaf = tree.getLeafId()!;

    // 分支 B：回到 A1 分叉（path 不含 A 的 compaction entry）
    tree.branch(a1.id);
    tree.appendMessage({ role: "user", text: "任务B" });
    tree.appendMessage(assistantMsg("回复B"));

    // B 的 active path：完整原 messages，0 条 summary
    const contextB = tree.buildSessionContext();
    expect(contextB.length).toBe(4); // U1 A1 B1 B2
    expect(contextB.some((m) => m.text?.includes("<summary>"))).toBe(false);

    // A 的 path（经其 leaf 重建）：summary + 保留段
    expect(tree.getBranch(branchALeaf).some((e) => e.type === "compaction")).toBe(true);
    tree.branch(branchALeaf);
    const contextA = tree.buildSessionContext();
    expect(contextA.length).toBe(3); // summary + U2a + A2a
    expect(contextA[0].text).toContain("<summary>");
    expect(contextA[1]).toMatchObject(u2a.message);

    // 回到 compaction 之前的节点：完整旧历史，无 summary
    tree.branch(a1.id);
    const contextPre = tree.buildSessionContext();
    expect(contextPre.length).toBe(2); // U1 A1（A1 视角的完整历史）
    expect(contextPre.some((m) => m.text?.includes("<summary>"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// multiple compactions
// ---------------------------------------------------------------------------

describe("multiple compactions（latest wins）", () => {
  it("C1/C2 都保留在树里；reconstruction 只用 latest C2；原历史全部仍在", () => {
    const tree = new TreeSession();
    const { u1, a1 } = buildLongHistory(tree);

    const c1 = tree.appendCompaction("摘要1", u1.id, 50);
    const u4 = tree.appendMessage({ role: "user", text: "任务四" });
    tree.appendMessage(assistantMsg("回复四"));
    // Pi 的 prepareCompaction 会把新切点设在 C1 保留边界之后（boundaryStart = 上次
    // firstKeptEntryId 的 index，compaction.ts L771-772）；本测试按该语义用 scripted
    // summary 直接构造：C2.firstKeptEntryId = 任务四（C1 之后的第一个 entry）。
    const c2 = tree.appendCompaction("摘要2", u4.id, 40);
    tree.appendMessage({ role: "user", text: "任务五" });
    tree.appendMessage(assistantMsg("回复五"));

    const entries = tree.getEntries();
    expect(entries.filter((e) => e.type === "compaction").map((e) => e.id)).toEqual([c1.id, c2.id]); // 都在树里
    expect(entries.filter((e) => e.type === "message").length).toBe(11); // U1..A3(7) + 任务四/回复四 + 任务五/回复五，全保留

    const context = tree.buildSessionContext();
    expect(context.length).toBe(5); // summary2 + 任务四 + 回复四 + 任务五 + 回复五
    expect(context[0].text).toContain("摘要2");
    expect(context[0].text).not.toContain("摘要1"); // C1 不直接出现在 current context
    expect(context[1]).toMatchObject({ role: "user", text: "任务四" });
    expect(context[2]).toMatchObject(assistantMsg("回复四"));

    // 原始历史（含 C1 之前的 entry）仍在 entries 中可查
    expect(entries.some((e) => e.id === u1.id)).toBe(true);
    expect(entries.some((e) => e.id === a1.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL round-trip
// ---------------------------------------------------------------------------

describe("JSONL round-trip（compaction 跨 run 持久）", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append → save → load → 重建结果一致；full entries 仍可查", () => {
    const dir = mkdtempSync(join(tmpdir(), "ch08-compaction-"));
    tmpDirs.push(dir);
    const file = join(dir, "session.jsonl");
    const header = { version: 2 as const, systemPrompt: "助手", model: "m" };

    const tree = new TreeSession();
    const { u3 } = buildLongHistory(tree);
    tree.appendCompaction("摘要", u3.id, 53);
    tree.appendMessage({ role: "user", text: "任务四" });
    tree.appendMessage(assistantMsg("回复四"));

    appendEntries(file, header, tree.getEntries());
    const loaded = loadTree(file);
    expect(loaded).not.toBeNull();

    // 重建结果与压缩前内存态一致：summary + U3 + A3 + 任务四 + 回复四
    expect(loaded!.tree.buildSessionContext()).toEqual(tree.buildSessionContext());
    expect(loaded!.tree.buildSessionContext().length).toBe(5);
    expect(loaded!.tree.buildSessionContext()[0].text).toContain("<summary>");
    // full entries（含 compaction 之前的完整历史）数量与内容一致
    expect(loaded!.tree.getEntries().length).toBe(10);
    expect(loaded!.tree.getLeafId()).toBe(tree.getLeafId());
  });
});
