/**
 * 03 章测试：Tool Runtime——流水线（prepare/validate/execute/normalize）、
 * 钩子（beforeToolCall/afterToolCall）、tool_execution_* 事件、批终止语义。
 * 流式 mock LLM 驱动（离线）。
 */
import { describe, expect, it } from "vitest";
import { agentLoop, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEventSink } from "../src/tool-runtime.ts";
import type { LLMAdapter, LLMRequest } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Tool,
} from "../../00-minimal-llm-call/src/index.ts";
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
    // 快照请求时刻的 messages（循环会 push 进同一数组引用），供断言「后续 LLM 请求未被污染」使用
    this.inputs.push({ ...input, messages: [...input.messages] });
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

function textStream(text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason } },
    { type: "done", partial: { role: "assistant", stopReason, text: text || undefined } },
  ];
}

/** 工具调用流：支持任意数量工具调用（一次模型回复可带多个 toolCall）。 */
function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  };
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
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
  get toolEvents(): AgentEvent[] {
    return this.events.filter((e) => e.type.startsWith("tool_execution"));
  }
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function baseContext(tools: Tool[] = [echo, calculator]): AgentContext {
  return { systemPrompt: "助手", messages: [], tools };
}

describe("Tool Runtime（03 章）", () => {
  it("校验拦截：参数类型错误 → 错误结果，工具从未执行", async () => {
    let executed = 0;
    const guarded: Tool<{ a: number; b: number }> = {
      ...calculator,
      async execute(args: { a: number; b: number }) {
        executed++;
        return calculator.execute(args);
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "calculator", args: { a: "不是数字", b: 2 } }]),
      textStream("参数有误"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "算" }], baseContext([guarded]), { model: "m" }, llm, recorder.sink);

    expect(executed).toBe(0);
    const result = messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ isError: true, toolName: "calculator" });
    expect(result?.text).toContain("参数校验失败");
    expect(llm.callCount).toBe(2); // 错误结果回传后模型继续
  });

  it("校验拦截：缺少必填参数 → 错误结果", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: {} }]), textStream("缺参数")]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, () => {});

    expect(messages.find((m) => m.role === "toolResult")?.text).toContain("缺少必填参数");
  });

  it("beforeToolCall 钩子：block → 错误结果，工具未执行", async () => {
    let executed = 0;
    const guarded: Tool<{ text: string }> = {
      ...echo,
      async execute(args: { text: string }) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("被拦")]);
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([guarded]),
      {
        model: "m",
        beforeToolCall: async () => ({ block: true, reason: "测试拦截" }),
      },
      llm,
      () => {},
    );

    expect(executed).toBe(0);
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true, text: "测试拦截" });
  });

  it("afterToolCall 钩子：字段级改写 content 与 terminate", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("改写后")]);
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext(),
      {
        model: "m",
        afterToolCall: async ({ result }) => ({ content: `改写: ${result.content}`, terminate: true }),
      },
      llm,
      () => {},
    );

    const result = messages.find((m) => m.role === "toolResult");
    expect(result?.text).toBe("改写: hi");
    expect(result?.terminate).toBe(true);
  });

  it("tool_execution_* 事件：start/end 必发，update 在 onUpdate 时发", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("完成")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    const types = recorder.toolEvents.map((e) => e.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).not.toContain("tool_execution_update"); // echo 不调 onUpdate
  });

  it("onUpdate：工具执行中 partial 更新 → tool_execution_update 事件", async () => {
    const streaming: Tool = {
      name: "slow",
      description: "分步执行",
      parameters: { type: "object", properties: {} },
      async execute(_args, onUpdate) {
        onUpdate?.({ content: "第一步完成" });
        onUpdate?.({ content: "第二步完成" });
        return { content: "全部完成" };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "slow", args: {} }]), textStream("完成")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext([streaming]), { model: "m" }, llm, recorder.sink);

    const updates = recorder.toolEvents.filter((e) => e.type === "tool_execution_update");
    expect(updates).toHaveLength(2);
    if (updates[0]?.type === "tool_execution_update") {
      expect(updates[0].partialResult).toMatchObject({ content: "第一步完成" });
    }
  });

  it("normalize：details/usage/terminate/addedToolNames 进入工具结果消息", async () => {
    const rich: Tool = {
      name: "rich",
      description: "返回结构化结果",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: "处理完成",
          details: { rows: 42 },
          usage: { inputTokens: 10, outputTokens: 5 },
          terminate: true,
          addedToolNames: ["echo"],
        };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "rich", args: {} }]), textStream("完成")]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([rich]), { model: "m" }, llm, () => {});

    const result = messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({
      text: "处理完成",
      details: { rows: 42 },
      usage: { inputTokens: 10, outputTokens: 5 },
      terminate: true,
      addedToolNames: ["echo"],
      isError: false,
    });
  });

  it("prepareArguments：兼容层把模型原始参数转为工具期望格式", async () => {
    const lenient: Tool<{ text: string }> = {
      name: "echo2",
      description: "接受 { input } 或 { text }",
      // parameters 描述转换后的形状：校验发生在 prepare 之后（Pi L617-618）
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      prepareArguments: (args) => {
        const record = args as Record<string, unknown>;
        return { text: typeof record.text === "string" ? record.text : String(record.input ?? "") };
      },
      async execute({ text }) {
        return { content: `echo2: ${text}` };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo2", args: { input: "兼容" } }]), textStream("完成")]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([lenient]), { model: "m" }, llm, () => {});

    expect(messages.find((m) => m.role === "toolResult")?.text).toBe("echo2: 兼容");
  });

  it("批终止：整批全部 terminate 才停；仅部分 terminate 则继续", async () => {
    const stopping: Tool = {
      name: "stop",
      description: "建议停止",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "建议停", terminate: true };
      },
    };

    // 场景 A：两个工具都 terminate → 循环停止（不再调用 LLM）
    const allStop = new ScriptedLlm([toolStream([{ id: "c1", name: "stop", args: {} }, { id: "c2", name: "stop", args: {} }])]);
    const recorderA = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext([stopping]), { model: "m" }, allStop, recorderA.sink);
    expect(allStop.callCount).toBe(1);
    expect(recorderA.types.at(-1)).toBe("agent_end");

    // 场景 B：一个 terminate、一个不 terminate → 继续循环
    const partialStop = new ScriptedLlm([
      toolStream([{ id: "c1", name: "stop", args: {} }, { id: "c2", name: "echo", args: { text: "hi" } }]),
      textStream("继续后完成"),
    ]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([stopping, echo]), { model: "m" }, partialStop, () => {});
    expect(partialStop.callCount).toBe(2);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "继续后完成" });
  });

  it("正常闭环仍工作：echo → calculator → 最终文本（回归）", async () => {
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "echo", args: { text: "开始" } }]),
      toolStream([{ id: "c2", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("3"),
    ]);
    const messages = await agentLoop([{ role: "user", text: "依次执行" }], baseContext(), { model: "m" }, llm);
    const result = await messages.result();

    expect(result.at(-1)).toMatchObject({ role: "assistant", text: "3" });
    expect(result.filter((m) => m.role === "toolResult").length).toBe(2);
  });

  it("beforeToolCall 抛错：错误结果、工具不执行、start/end 配对、不击穿循环（Pi L616-667）", async () => {
    let executed = 0;
    const guarded: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("继续")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([guarded]),
      {
        model: "m",
        beforeToolCall: async () => {
          throw new Error("钩子炸了");
        },
      },
      llm,
      recorder.sink,
    );

    expect(executed).toBe(0); // 钩子抛错发生在 execute 之前
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
      text: "beforeToolCall 钩子抛错: 钩子炸了",
    });
    const starts = recorder.toolEvents.filter((e) => e.type === "tool_execution_start");
    const ends = recorder.toolEvents.filter((e) => e.type === "tool_execution_end");
    expect(starts).toHaveLength(1); // start/end 配对不受钩子错误影响
    expect(ends).toHaveLength(1);
    expect(llm.callCount).toBe(2); // 错误不击穿循环，下一轮继续
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("afterToolCall 抛错：执行已完成、结果转错误、end 与 toolResult 一致、不击穿批次（Pi L747-750）", async () => {
    let executed = 0;
    const guarded: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "echo", args: { text: "hi" } },
        { id: "c2", name: "echo", args: { text: "b" } },
      ]),
      textStream("继续"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([guarded]),
      {
        model: "m",
        afterToolCall: async () => {
          throw new Error("改写炸了");
        },
      },
      llm,
      recorder.sink,
    );

    expect(executed).toBe(2); // 两个工具都已实际执行
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ isError: true, text: "改写炸了" }); // 原成功结果不得进 history
    }
    const ends = recorder.toolEvents.filter((e) => e.type === "tool_execution_end");
    expect(ends).toHaveLength(2);
    if (ends[0]?.type === "tool_execution_end") {
      expect(ends[0]).toMatchObject({ isError: true, result: { content: "改写炸了" } }); // end 与最终 toolResult 一致
    }
    expect(llm.callCount).toBe(2); // 不击穿批次/循环
  });

  it("not-found：tool_execution_start 在 lookup 之前发生，start/end 各一次，工具不执行（Pi L445-450 + L608-614）", async () => {
    let executed = 0;
    const guarded: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "ghost", args: {} }]), textStream("继续")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([guarded]), { model: "m" }, llm, recorder.sink);

    // 事件顺序：tool_execution_start → tool_execution_end → message_start(toolResult) → message_end(toolResult)
    const indexOf = (type: string): number => recorder.events.findIndex((e) => e.type === type);
    expect(indexOf("tool_execution_start")).toBeGreaterThanOrEqual(0);
    expect(indexOf("tool_execution_end")).toBeGreaterThan(indexOf("tool_execution_start"));
    const resultStart = recorder.events.findIndex((e) => e.type === "message_start" && e.message.role === "toolResult");
    const resultEnd = recorder.events.findIndex((e) => e.type === "message_end" && e.message.role === "toolResult");
    expect(resultStart).toBeGreaterThan(indexOf("tool_execution_end"));
    expect(resultEnd).toBeGreaterThan(resultStart);

    // start/end 各一次：若未来有人把 start 移到 lookup 成功之后，not-found 路径将没有 start
    expect(recorder.toolEvents.filter((e) => e.type === "tool_execution_start")).toHaveLength(1);
    expect(recorder.toolEvents.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true, text: "Tool ghost not found" });
    expect(executed).toBe(0);
  });

  it("signal 中途 abort：首个工具后 break，第二个不执行，结果入史并收尾（Pi L478-480）", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const first: Tool = {
      ...echo,
      name: "echo_first",
      async execute(args: never) {
        executed.push("first");
        controller.abort(); // 执行期间触发 abort：循环在第一个工具返回后 break
        return echo.execute(args);
      },
    };
    const second: Tool = {
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
      baseContext([first, second]),
      { model: "m" },
      llm,
      recorder.sink,
      controller.signal,
    );

    expect(executed).toEqual(["first"]); // 第二个工具从未执行
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1); // 已完成的第一个 toolResult 正常入史
    expect(toolResults[0]).toMatchObject({ toolCallId: "c1", toolName: "echo_first" });
    const turnEnds = recorder.events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2); // 工具轮与 aborted 轮均正确收尾
    if (turnEnds[0]?.type === "turn_end") {
      expect(turnEnds[0].toolResults).toHaveLength(1);
    }
    expect(llm.callCount).toBe(2);
    expect(recorder.types.at(-1)).toBe("agent_end"); // 生命周期正确收尾
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("message 事件快照隔离：消费者改动 event.message 不污染 history 与后续 LLM 请求", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("完成")]);
    const mutatingSink: AgentEventSink = (event) => {
      // 消费者恶意改动事件 payload：快照隔离前，raw-reference 位点会被直接污染内部 history
      if (event.type === "message_end") {
        event.message.text = "被污染";
        event.message.isError = true;
      }
    };
    const messages = await runAgentLoop([{ role: "user", text: "回显" }], baseContext(), { model: "m" }, llm, mutatingSink);

    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ text: "hi", isError: false });
    expect(messages.at(-1)?.text).toBe("完成"); // assistant 最终消息同样未被污染
    const secondRequest = llm.inputs[1]; // 第二轮 LLM 请求（请求时刻快照）
    expect(secondRequest.messages.find((m) => m.role === "toolResult")).toMatchObject({ text: "hi", isError: false });
  });
});
