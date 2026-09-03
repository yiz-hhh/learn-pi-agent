/**
 * 02 章测试：完整 Agent Runtime——事件序列、流式增量（message_update/partial 快照）、
 * 终止语义（error/aborted/length）、newMessages、context 快照隔离、EventStream 入口。
 * 流式 mock LLM 驱动（离线）。
 */
import { describe, expect, it, vi } from "vitest";
import { agentLoop, runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { LLMAdapter, LLMRequest } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AssistantMessage, AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：按脚本步骤逐轮返回事件序列。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly inputs: LLMRequest[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    // 快照请求时刻的 messages：循环会把新消息 push 进同一数组引用，
    // 「下一轮 LLM 请求携带更新后的历史」必须以请求时刻为准断言
    this.inputs.push({ ...input, messages: [...input.messages] });
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

/** 文本分段流：text 分 chunks 段逐步到达。 */
function textStream(chunks: string[], stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessageEvent[] {
  const events: AssistantMessageEvent[] = [];
  let acc = "";
  events.push({ type: "start", partial: { role: "assistant", stopReason } });
  for (const chunk of chunks) {
    acc += chunk;
    events.push({ type: "text_delta", partial: { role: "assistant", stopReason, text: acc } });
  }
  events.push({ type: "done", partial: { role: "assistant", stopReason, text: acc || undefined } });
  return events;
}

/** 工具调用流：toolcall_start（完整参数）→ done。 */
function toolStream(id: string, name: string, args: Record<string, unknown>): AssistantMessageEvent[] {
  const partial: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id, name, arguments: args }],
  };
  return [
    { type: "start", partial },
    { type: "toolcall_start", partial },
    { type: "done", partial },
  ];
}

class EventRecorder {
  readonly events: AgentEvent[] = [];
  readonly sink: AgentEventSink = (event) => {
    this.events.push(event);
  };
  get types(): string[] {
    return this.events.map((e) => e.type);
  }
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function baseContext(extra?: Partial<AgentContext>): AgentContext {
  return { systemPrompt: "助手", messages: [{ role: "user", text: "hello" }], tools: [echo, calculator], ...extra };
}

describe("runAgentLoop（02：Agent Runtime）", () => {
  it("事件序列：agent → turn → message → turn_end → agent_end（一轮文本）", async () => {
    const llm = new ScriptedLlm([textStream(["你好！"])]);
    const recorder = new EventRecorder();
    const newMessages = await runAgentLoop([{ role: "user", text: "打个招呼" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update", // 流式增量：单段文本 1 次（02 章消费增量）
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const agentEnd = recorder.events.at(-1);
    expect(agentEnd?.type).toBe("agent_end");
    if (agentEnd?.type === "agent_end") {
      expect(agentEnd.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    }
  });

  it("工具轮：事件含 toolResult 消息事件，turn_end.toolResults 非空，多轮 turn", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "echo", { text: "hi" }), textStream(["已回显"])]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "回显 hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update", // toolcall_start 增量
      "message_end",
      "message_start", // toolResult
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_update", // text_delta 增量
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    const toolTurnEnd = recorder.events.find((e) => e.type === "turn_end" && e.toolResults.length > 0);
    expect(toolTurnEnd).toBeDefined();
    if (toolTurnEnd?.type === "turn_end") {
      expect(toolTurnEnd.toolResults[0]).toMatchObject({ role: "toolResult", toolName: "echo", text: "hi" });
    }
  });

  it("流式增量：message_start 一次、message_update 每段一次、message_end 一次，text 逐段增长", async () => {
    const llm = new ScriptedLlm([textStream(["你", "好，", "世界"])]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    const updates = recorder.events.filter((e) => e.type === "message_update");
    expect(updates).toHaveLength(3);
    const texts = updates.map((e) => (e.type === "message_update" ? e.message.text : ""));
    expect(texts).toEqual(["你", "你好，", "你好，世界"]);
    expect(recorder.types.filter((t) => t === "message_start")).toHaveLength(2);
    expect(recorder.types.filter((t) => t === "message_end")).toHaveLength(2);
  });

  it("partial 快照机制：message_update 携带完整快照（非 delta），text 单调累积（Pi L335-343）", async () => {
    const llm = new ScriptedLlm([textStream(["A", "B"])]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    const updates = recorder.events.filter((e) => e.type === "message_update");
    // 若 payload 是 delta，"AB" 应为 "B"；第二次 update 已含全部文本 = 完整快照的证据
    expect(updates[1]).toMatchObject({ message: { text: "AB" } });
    if (updates[1]?.type === "message_update") {
      expect(updates[1].assistantMessageEvent.type).toBe("text_delta");
    }
    // 注：「快照替换写入了 history」的可观察断言在下一个测试（history 链路）——本测试只锁定 payload 形状
  });

  it("history 链路：partial 替换 + done 落定 + toolResult 入史 → 下一轮 LLM 请求携带更新后的历史", async () => {
    // 第一轮：text 增量与工具调用先后到达（partial 逐步替换 context 末条）
    const startPartial: AssistantMessage = { role: "assistant", stopReason: "tool_use" };
    const withText: AssistantMessage = { role: "assistant", stopReason: "tool_use", text: "查一下" };
    const withCall: AssistantMessage = {
      role: "assistant",
      stopReason: "tool_use",
      text: "查一下",
      toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 12, b: 30 } }],
    };
    const llm = new ScriptedLlm([
      [
        { type: "start", partial: startPartial },
        { type: "text_delta", partial: withText },
        { type: "toolcall_start", partial: withCall },
        { type: "done", partial: withCall },
      ],
      textStream(["42"]),
    ]);
    await runAgentLoop([{ role: "user", text: "算一下" }], baseContext(), { model: "m" }, llm, () => {});

    // 第二轮 LLM 请求（请求时刻快照）必须看到第一轮最终 assistant + 对应 toolResult
    const secondRequest = llm.inputs[1];
    // baseContext 自带 1 条历史 user：请求 = [历史 user, 本轮 user, 第一轮 assistant, toolResult]
    expect(secondRequest.messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "toolResult"]);
    expect(secondRequest.messages.at(-2)).toMatchObject({
      role: "assistant",
      text: "查一下", // done 落定的最终文本，而非某个中间 delta
      toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 12, b: 30 } }],
    });
    expect(secondRequest.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "calculator",
      text: "42",
      isError: false,
    });
  });

  it("工具流：toolcall_start 时 partial 已含工具调用，done 后进入执行闭环", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "calculator", { a: 12, b: 30 }), textStream(["42"])]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "12+30?" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types).toContain("message_update");
    const toolStart = recorder.events.find((e) => e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_start");
    expect(toolStart).toBeDefined();
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ text: "42", isError: false });
    expect(llm.callCount).toBe(2);
  });

  it("终止① error：立即 agent_end，不再调用 LLM；errorMessage 可观测", async () => {
    const llm = new ScriptedLlm([
      [
        { type: "start", partial: { role: "assistant", stopReason: "error", errorMessage: "API 调用失败" } },
        { type: "done", partial: { role: "assistant", stopReason: "error", errorMessage: "API 调用失败" } },
      ],
    ]);
    const recorder = new EventRecorder();
    const newMessages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(llm.callCount).toBe(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
    expect(newMessages[1]).toMatchObject({ stopReason: "error", errorMessage: "API 调用失败" });
  });

  it("终止① aborted：stopReason=aborted → 立即 agent_end，不执行工具（Pi L196）", async () => {
    const aborted = (): AssistantMessageEvent[] => {
      const partial: AssistantMessage = {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "Operation aborted",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
      };
      return [
        { type: "start", partial },
        { type: "done", partial },
      ];
    };
    const llm = new ScriptedLlm([aborted()]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types.at(-1)).toBe("agent_end");
    expect(messages.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("截断保护：stopReason=length 且带 toolCalls → 全部判错、工具不被执行", async () => {
    let calls = 0;
    let executed = 0;
    const countingLlm: LLMAdapter = {
      async *complete() {
        calls++;
        if (calls === 1) {
          const partial: AssistantMessage = {
            role: "assistant",
            stopReason: "length",
            toolCalls: [{ id: "call_1", name: "echo", arguments: { text: "x" } }],
          };
          yield { type: "start", partial };
          yield { type: "done", partial };
        } else {
          yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
          yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text: "重试后完成" } };
        }
      },
    };
    const guardedEcho: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };

    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      { systemPrompt: "助手", messages: [], tools: [guardedEcho] },
      { model: "m" },
      countingLlm,
      (e) => {
        events.push(e);
      },
    );

    expect(executed).toBe(0);
    const truncated = messages.find((m) => m.role === "toolResult");
    expect(truncated).toMatchObject({ isError: true, toolName: "echo" });
    expect(truncated?.text).toContain("token limit");
    // Pi L216：截断批 terminate=false → 继续循环，模型基于错误结果重发完整参数（第二轮）
    expect(calls).toBe(2);
    expect(messages.at(-1)?.text).toBe("重试后完成");
    // Pi L386-403：截断结果事件齐全（tool_execution_start/end + 消息事件）
    const truncToolEvents = events.filter(
      (e) => (e.type === "tool_execution_start" || e.type === "tool_execution_end") && e.toolCallId === "call_1",
    );
    expect(truncToolEvents).toHaveLength(2);
    const truncMsgEvents = events.filter((e) => e.type === "message_start" && e.message.role === "toolResult");
    expect(truncMsgEvents).toHaveLength(1);
  });

  it("signal 中途 abort：首个工具完成后 break，第二个工具不执行，结果正常入史并收尾（Pi L478-480）", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const abortingEcho: Tool = {
      ...echo,
      name: "echo_first",
      async execute(args: never) {
        executed.push("first");
        controller.abort(); // 工具执行期间触发 abort：循环在第一个工具返回后 break（教学 L134-137）
        return echo.execute(args);
      },
    };
    const countingEcho: Tool = {
      ...echo,
      name: "echo_second",
      async execute(args: never) {
        executed.push("second");
        return echo.execute(args);
      },
    };
    const twoCalls: AssistantMessage = {
      role: "assistant",
      stopReason: "tool_use",
      toolCalls: [
        { id: "c1", name: "echo_first", arguments: { text: "a" } },
        { id: "c2", name: "echo_second", arguments: { text: "b" } },
      ],
    };
    // 第二轮：abort 后仍进入下一轮（hasMoreToolCalls=true）；真实 adapter 此时会因 signal 返回 aborted → 终止①
    const aborted: AssistantMessage = { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" };
    const llm = new ScriptedLlm([
      [
        { type: "start", partial: twoCalls },
        { type: "toolcall_start", partial: twoCalls },
        { type: "done", partial: twoCalls },
      ],
      [
        { type: "start", partial: aborted },
        { type: "done", partial: aborted },
      ],
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "两个工具" }],
      { systemPrompt: "助手", messages: [], tools: [abortingEcho, countingEcho] },
      { model: "m" },
      llm,
      recorder.sink,
      controller.signal,
    );

    expect(executed).toEqual(["first"]); // 第二个工具从未执行（Pi L478-480 break）
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1); // 已完成的第一个 toolResult 正常入史
    expect(toolResults[0]).toMatchObject({ toolCallId: "c1", toolName: "echo_first" });
    const turnEnds = recorder.events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2); // 工具轮与 aborted 轮均正确收尾
    if (turnEnds[0]?.type === "turn_end") {
      expect(turnEnds[0].toolResults).toHaveLength(1);
    }
    expect(llm.callCount).toBe(2); // abort 后仍进入下一轮，第二轮以 aborted 终止
    expect(recorder.events.at(-1)?.type).toBe("agent_end"); // 生命周期正确收尾
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("newMessages 语义：只含本轮新增，不含调用方历史", async () => {
    const llm = new ScriptedLlm([textStream(["完成"])]);
    const context = baseContext({ messages: [{ role: "user", text: "旧消息" }] });
    const newMessages = await runAgentLoop([{ role: "user", text: "新消息" }], context, { model: "m" }, llm, () => {});

    expect(newMessages.map((m) => m.text)).toEqual(["新消息", "完成"]);
    expect(newMessages.some((m) => m.text === "旧消息")).toBe(false);
  });

  it("context 快照隔离：调用方 context 不被循环修改", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "calculator", { a: 1, b: 2 }), textStream(["3"])]);
    const context = baseContext();
    const originalLength = context.messages.length;
    await runAgentLoop([{ role: "user", text: "算" }], context, { model: "m" }, llm, () => {});

    expect(context.messages).toHaveLength(originalLength);
  });

  it("agentLoop 入口：for await 收到全部事件、result() 返回 newMessages、agent_end 只出现一次", async () => {
    const llm = new ScriptedLlm([textStream(["完成"])]);
    const stream = agentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm);

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    const result = await stream.result();

    expect(types.at(-1)).toBe("agent_end");
    expect(types.filter((t) => t === "agent_end")).toHaveLength(1);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("agentLoop 异常兜底：background runner 抛错时流仍结束、result() 为 []（教学增强）", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 契约违反场景：adapter 失败本应编码进 done 的 stopReason，此处模拟 runner 级异常（真实挂起风险）
      const throwingLlm: LLMAdapter = {
        async *complete() {
          throw new Error("LLM 炸了");
        },
      };
      const stream = agentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, throwingLlm);

      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      const result = await stream.result();

      // 失败前已发出的事件仍可消费，随后流正常终止——消费者不永久挂起
      expect(types).toEqual(["agent_start", "turn_start", "message_start", "message_end"]);
      expect(result).toEqual([]); // 当前约定：runner 异常 → 空结果（Pi 无 catch，reject 时流挂起）
      expect(consoleSpy).toHaveBeenCalled(); // 异常留痕
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("空 prompts 守卫：runAgentLoop 直接抛错，不调用 LLM（教学增强；Pi 无此守卫）", async () => {
    const llm = new ScriptedLlm([textStream(["x"])]);
    await expect(runAgentLoop([], baseContext(), { model: "m" }, llm, () => {})).rejects.toThrow("prompts 不能为空");
    expect(llm.callCount).toBe(0);
  });
});
