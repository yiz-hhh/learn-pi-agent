/**
 * 04 章测试：Parallel Tool Execution——两阶段并行、消息保序、
 * end 事件完成顺序、分流（sequential/executionMode）、immediate 失败、terminate 延续。
 * 流式 mock LLM 驱动（离线）。
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Tool,
} from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM。 */
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

  get callCount(): number {
    return this.next;
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

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
  toolEventsOf(type: string): AgentEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

/** 延迟工具：executionMs 毫秒后完成。 */
function slowTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `${delayMs}ms 后完成`,
    parameters: { type: "object", properties: {} },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: `${name} done` };
    },
  };
}

function baseContext(tools: Tool[] = [echo, calculator]): AgentContext {
  return { systemPrompt: "助手", messages: [], tools };
}

describe("Parallel Tool Execution（04 章）", () => {
  it("默认并行：全部 tool_execution_start 先发，随后才出现第一个 end（两阶段结构）", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "fast1", args: {} },
        { id: "c2", name: "slow200", args: {} },
        { id: "c3", name: "fast2", args: {} },
      ]),
      textStream("完成"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("fast1", 10), slowTool("slow200", 200), slowTool("fast2", 10)]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const starts = recorder.toolEventsOf("tool_execution_start");
    const ends = recorder.toolEventsOf("tool_execution_end");
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    // 两阶段：全部 start 先于第一个 end
    const startIdx = recorder.events.findIndex((e) => e.type === "tool_execution_start");
    const firstEndIdx = recorder.events.findIndex((e) => e.type === "tool_execution_end");
    const lastStartIdx = recorder.events.map((e) => e.type).lastIndexOf("tool_execution_start");
    expect(startIdx).toBeLessThan(firstEndIdx);
    expect(lastStartIdx).toBeLessThan(firstEndIdx);
  });

  it("end 事件按完成顺序，toolResult 消息按 assistant 源顺序", async () => {
    // 源顺序：fast1(10ms) → slow200(200ms) → fast2(10ms)
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "fast1", args: {} },
        { id: "c2", name: "slow200", args: {} },
        { id: "c3", name: "fast2", args: {} },
      ]),
      textStream("完成"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("fast1", 10), slowTool("slow200", 200), slowTool("fast2", 10)]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    // end 完成顺序：fast1、fast2（并行完成）、slow200 最后
    const endOrder = recorder.toolEventsOf("tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder[0]).toBe("fast1");
    expect(endOrder[1]).toBe("fast2");
    expect(endOrder[2]).toBe("slow200");

    // 消息源顺序：fast1 → slow200 → fast2（与 assistant 请求顺序一致）
    const resultNames = messages.filter((m) => m.role === "toolResult").map((m) => m.toolName);
    expect(resultNames).toEqual(["fast1", "slow200", "fast2"]);
  });

  it("分流：config.toolExecution = sequential → 串行（end 顺序 = 源顺序）", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "fast1", args: {} },
        { id: "c2", name: "slow200", args: {} },
      ]),
      textStream("完成"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("fast1", 10), slowTool("slow200", 200)]),
      { model: "m", toolExecution: "sequential" },
      llm,
      recorder.sink,
    );

    const endOrder = recorder.toolEventsOf("tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder).toEqual(["fast1", "slow200"]);
  });

  it("工具级 executionMode：一个 sequential 工具 → 整批串行（Pi L419-421）", async () => {
    const sequentialTool: Tool = { ...echo, executionMode: "sequential" };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "echo", args: { text: "a" } },
        { id: "c2", name: "calculator", args: { a: 1, b: 2 } },
      ]),
      textStream("完成"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([sequentialTool, calculator]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const endOrder = recorder.toolEventsOf("tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder).toEqual(["echo", "calculator"]);
  });

  it("immediate 失败：批中一个未找到 → 就地收尾，其余并发执行", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "unknown", args: {} },
        { id: "c2", name: "calculator", args: { a: 1, b: 2 } },
      ]),
      textStream("继续"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([echo, calculator]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const unknown = messages.find((m) => m.toolName === "unknown");
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown?.text).toContain("not found");
    const calc = messages.find((m) => m.toolName === "calculator");
    expect(calc).toMatchObject({ isError: false, text: "3" });
    expect(llm.callCount).toBe(2);
  });

  it("immediate 消息事件按源序：unknown 在第二位时其消息事件在 calculator 之后（Pi L543-548）", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "calculator", args: { a: 1, b: 2 } },
        { id: "c2", name: "unknown", args: {} },
      ]),
      textStream("继续"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([echo, calculator]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const msgStarts = recorder.events.filter(
      (e): e is Extract<AgentEvent, { type: "message_start" }> => e.type === "message_start" && e.message.role === "toolResult",
    );
    expect(msgStarts.map((e) => e.message.toolName)).toEqual(["calculator", "unknown"]);
  });

  it("AbortSignal：已 abort 的 signal → 剩余工具不再 prepare/执行（Pi L516-518/L629-654）", async () => {
    const executed: string[] = [];
    const guardTool: Tool = {
      name: "guard",
      description: "记录执行",
      parameters: { type: "object", properties: {} },
      async execute(args: never, _onUpdate?: (p: { content: string }) => void, signal?: AbortSignal) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        executed.push("guard");
        return { content: "ok" };
      },
    };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "echo", args: { text: "x" } },
        { id: "c2", name: "guard", args: {} },
      ]),
      textStream("继续"),
    ]);
    const aborted = new AbortController();
    aborted.abort();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([echo, guardTool]),
      { model: "m" },
      llm,
      () => {},
      aborted.signal,
    );
    // 阶段 1 prepare 前 abort 检查：echo 被 Operation aborted 拦截，guard 不再 prepare
    expect(executed).toEqual([]);
    expect(llm.callCount).toBe(2);  // 错误结果回传后循环继续
  });

  it("延续：并行下整批全部 terminate 才停", async () => {
    const stopping: Tool = {
      name: "stop",
      description: "建议停止",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "停", terminate: true };
      },
    };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "stop", args: {} },
        { id: "c2", name: "stop", args: {} },
      ]),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext([stopping]), { model: "m" }, llm, recorder.sink);

    expect(llm.callCount).toBe(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("回归：正常闭环 echo → calculator → 文本（并行默认）", async () => {
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "echo", args: { text: "开始" } }]),
      toolStream([{ id: "c2", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("3"),
    ]);
    const messages = await runAgentLoop([{ role: "user", text: "依次执行" }], baseContext(), { model: "m" }, llm, () => {});

    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "3" });
    expect(messages.filter((m) => m.role === "toolResult").length).toBe(2);
  });

  it("prepare 阶段严格串行：hook 按源序逐个完成且互不重叠，全部完成后 execute 才开始（两阶段结构）", async () => {
    const timeline: string[] = [];
    let hookDepth = 0;
    let hookOverlap = false;
    let execDepth = 0;
    let execOverlap = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const mkTool = (name: string): Tool => ({
      name,
      description: "记录执行",
      parameters: { type: "object", properties: {} },
      async execute() {
        timeline.push(`${name}-exec-start`);
        execDepth++;
        if (execDepth > 1) execOverlap = true;
        await sleep(30);
        execDepth--;
        timeline.push(`${name}-exec-end`);
        return { content: `${name} done` };
      },
    });

    const llm = new ScriptedLlm([
      toolStream([
        { id: "A", name: "tA", args: {} },
        { id: "B", name: "tB", args: {} },
        { id: "C", name: "tC", args: {} },
      ]),
      textStream("完成"),
    ]);
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([mkTool("tA"), mkTool("tB"), mkTool("tC")]),
      {
        model: "m",
        beforeToolCall: async ({ toolCall }) => {
          timeline.push(`${toolCall.name}-hook-start`);
          hookDepth++;
          if (hookDepth > 1) hookOverlap = true;
          await sleep(20); // 拉长 hook，制造可检测的重叠窗口
          hookDepth--;
          timeline.push(`${toolCall.name}-hook-end`);
        },
      },
      llm,
      () => {},
    );

    // 1. hook 调用顺序严格等于 assistant 源序，且互不重叠
    expect(timeline.slice(0, 6)).toEqual([
      "tA-hook-start", "tA-hook-end",
      "tB-hook-start", "tB-hook-end",
      "tC-hook-start", "tC-hook-end",
    ]);
    expect(hookOverlap).toBe(false);
    // 2. prepare 阶段完全结束（全部 hook-end 之后）才有任何 execute 开始
    const execEvents = timeline.slice(6);
    expect(execEvents).toHaveLength(6); // 3 个 exec-start + 3 个 exec-end
    expect(execEvents.filter((e) => e.endsWith("-exec-start"))).toHaveLength(3);
    // 3. execute 阶段允许重叠（并发证据）
    expect(execOverlap).toBe(true);
  });

  it("并行 batch 全局顺序：immediate 的 end 在 prepare 阶段，其余 end 按完成序，全部 end 先于全部消息，消息按源序（Pi L532 + L543-548）", async () => {
    const timeline: string[] = [];
    const sink: AgentEventSink = (event) => {
      switch (event.type) {
        case "tool_execution_start":
          timeline.push(`start:${event.toolName}`);
          break;
        case "tool_execution_end":
          timeline.push(`end:${event.toolName}`);
          break;
        case "message_start":
          if (event.message.role === "toolResult") timeline.push(`msg:${event.message.toolName}`);
          break;
        default:
          break;
      }
    };
    // 源顺序：A=slowA(150ms) → B=ghost(immediate 未找到) → C=fastC(20ms)
    const llm = new ScriptedLlm([
      toolStream([
        { id: "A", name: "slowA", args: {} },
        { id: "B", name: "ghost", args: {} },
        { id: "C", name: "fastC", args: {} },
      ]),
      textStream("继续"),
    ]);
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("slowA", 150), slowTool("fastC", 20)]),
      { model: "m" },
      llm,
      sink,
    );

    const idxOf = (label: string): number => timeline.indexOf(label);
    // 1. starts 按源序发（prepare 阶段逐个）
    expect(timeline.filter((e) => e.startsWith("start:"))).toEqual(["start:slowA", "start:ghost", "start:fastC"]);
    // 2. B 的 immediate end 在 prepare 阶段（早于 fastC 的 start，即早于 execute 阶段）
    expect(idxOf("end:ghost")).toBeLessThan(idxOf("start:fastC"));
    expect(idxOf("end:ghost")).toBeLessThan(idxOf("end:fastC"));
    expect(idxOf("end:ghost")).toBeLessThan(idxOf("end:slowA"));
    // 3. 完成序：C 早于 A（完成顺序 ≠ 源顺序）
    expect(idxOf("end:fastC")).toBeLessThan(idxOf("end:slowA"));
    // 4. 全部 tool_execution_end 先于全部 toolResult 消息事件
    const endIdx = [idxOf("end:ghost"), idxOf("end:fastC"), idxOf("end:slowA")];
    const msgIdx = [idxOf("msg:slowA"), idxOf("msg:ghost"), idxOf("msg:fastC")];
    for (const m of msgIdx) {
      for (const e of endIdx) {
        expect(m).toBeGreaterThan(e);
      }
    }
    // 5. 消息按 assistant 源序 A → B → C（消息提交顺序 ≠ 完成顺序）
    expect(timeline.filter((e) => e.startsWith("msg:"))).toEqual(["msg:slowA", "msg:ghost", "msg:fastC"]);
  });
});
