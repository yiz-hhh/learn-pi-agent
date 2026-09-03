/**
 * 05 章测试：Steering & Follow-up——双层循环、两种生命周期的注入时机、
 * steering 三取点、follow-up 单取点、组合流程与回归。
 * 流式 mock LLM 驱动（离线）。
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
} from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：记录每次调用收到的历史（验证 steering/follow-up 进入历史）。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenHistories: Message[][] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenHistories.push([...input.messages]);
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
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function baseContext(): AgentContext {
  return { systemPrompt: "助手", messages: [], tools: [echo, calculator] };
}

/** 记录注入消息进入历史的时序（以 LLM 调用为锚点）。 */
function textsAt(llm: ScriptedLlm, callIndex: number): string[] {
  return llm.seenHistories[callIndex]?.filter((m) => m.role === "user").map((m) => m.text ?? "") ?? [];
}

describe("Steering & Follow-up（05 章）", () => {
  it("steering turn-end 取点：回合完整结束后进入下一回合，模型下一轮看到（L259）", async () => {
    let steeringCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      // 初始取点（L167）返回空；轮末取点（L259）返回 steering——区分两种取点（见下一条测试）
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "中途消息" }] : [];
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("完成")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, recorder.sink);

    // 第一轮 LLM 调用（回合 1）尚未包含 steering
    expect(textsAt(llm, 0)).toEqual(["算"]);
    // 第二轮 LLM 调用时历史里已有 steering（注入在回合之间，L182-190）
    expect(textsAt(llm, 1)).toContain("中途消息");
    // steering 消息进入 newMessages
    expect(messages.some((m) => m.text === "中途消息")).toBe(true);
    // steering 消息有消息事件
    const startEvents = recorder.events.filter((e) => e.type === "message_start");
    expect(startEvents.some((e) => e.type === "message_start" && e.message.text === "中途消息")).toBe(true);

    // 事件相对顺序（README 关键事实）：
    // toolResult 消息事件 → turn_end → 下一 turn_start → steering 消息事件 → 下一 assistant 消息事件
    const toolResultMsg = recorder.events.findIndex(
      (e) => e.type === "message_start" && e.message.role === "toolResult",
    );
    const firstTurnEnd = recorder.events.findIndex((e) => e.type === "turn_end");
    const secondTurnStart = recorder.events.findIndex((e, i) => e.type === "turn_start" && i > toolResultMsg);
    const steeringMsg = recorder.events.findIndex(
      (e) => e.type === "message_start" && e.message.text === "中途消息",
    );
    const assistantStarts = recorder.events
      .map((e, i) => (e.type === "message_start" && e.message.role === "assistant" ? i : -1))
      .filter((i) => i >= 0);
    const secondAssistantMsg = assistantStarts[1];
    expect(toolResultMsg).toBeLessThan(firstTurnEnd);
    expect(firstTurnEnd).toBeLessThan(secondTurnStart);
    expect(secondTurnStart).toBeLessThan(steeringMsg);
    expect(steeringMsg).toBeLessThan(secondAssistantMsg);
    // steering 轮询共三次：初始（空）+ 回合 1 轮末（返回消息）+ 回合 2 轮末（空，内层退出）
    expect(steeringCalls).toBe(3);
  });

  it("steering 时机：初始取点返回的消息在第一次 LLM 调用前进入历史（L167）", async () => {
    let steeringCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      // 有界：只返回一次。契约：无消息时必须返回 []（Pi types.ts L242-243），否则内层循环不停
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 1 ? [{ role: "user", text: "预热消息" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("完成")]);
    await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, () => {});

    // 第一次 LLM 调用已包含初始 steering
    expect(textsAt(llm, 0)).toEqual(["算", "预热消息"]);
  });

  it("follow-up：内层退出后注入 → 外层继续 → 新回合（L263-268）", async () => {
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "退出后新任务" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("第一轮完成"), textStream("第二轮完成")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "任务一" }], baseContext(), config, llm, recorder.sink);

    expect(llm.callCount).toBe(2);
    expect(textsAt(llm, 1)).toContain("退出后新任务");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "第二轮完成" });
    // agent_end 只在最后
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
  });

  it("follow-up 为空时：内层退出即结束（回归，行为等同 04 章）", async () => {
    const llm = new ScriptedLlm([textStream("完成")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "算" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(llm.callCount).toBe(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("组合流程：steering（回合间）+ 工具执行 + follow-up（退出后）全链路", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 1 ? [{ role: "user", text: "改主意了，算 10*10" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "再回显 hello" }] : [];
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), // 第 1 轮：原任务
      textStream("100"),                                                    // 第 2 轮：看到 steering 后
      textStream("已回显 hello"),                                           // 第 3 轮：follow-up
    ]);
    const messages = await runAgentLoop([{ role: "user", text: "算 1+2" }], baseContext(), config, llm, () => {});

    expect(llm.callCount).toBe(3);
    // 历史顺序：原任务 → 工具结果 → steering → 第二回复 → follow-up → 第三回复
    const userTexts = messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(userTexts).toEqual(["算 1+2", "改主意了，算 10*10", "再回显 hello"]);
    // 第二轮 LLM 调用时历史包含工具结果与 steering（历史累积正确）
    const secondHistory = llm.seenHistories[1];
    expect(secondHistory.some((m) => m.role === "toolResult" && m.text === "3")).toBe(true);
    expect(secondHistory.some((m) => m.role === "user" && m.text === "改主意了，算 10*10")).toBe(true);
  });

  it("注入位置：steering 的消息事件在 turn 之间，follow-up 在 agent_end 之前", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      // steering：第 1 次（初始取点 L167）返回空，第 2 次（轮末重取 L259）返回 S
      // → S 出现在第一个回合结束后、第二个回合开始时（回合之间）
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "S" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "F" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("A"), textStream("B")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, recorder.sink);

    // steering S 的消息事件：发生在第一个 turn_end 之后（回合之间）
    const sIdx = recorder.types.findIndex((t, i) => t === "message_start" && recorder.events[i].type === "message_start" && recorder.events[i].message.text === "S");
    const firstTurnEnd = recorder.types.indexOf("turn_end");
    expect(sIdx).toBeGreaterThan(firstTurnEnd);
    // follow-up F 的消息事件：在 S 之后、agent_end 之前；
    // 它在被注入的那个回合的开头进入（L182-190），而不是独立出现在 agent_end 前
    const fIdx = recorder.types.findIndex((t, i) => t === "message_start" && recorder.events[i].type === "message_start" && recorder.events[i].message.text === "F");
    const agentEnd = recorder.types.lastIndexOf("agent_end");
    expect(fIdx).toBeGreaterThan(sIdx);
    expect(fIdx).toBeLessThan(agentEnd);
    expect(llm.callCount).toBe(3); // 原任务 → steering 后 → follow-up 后
  });

  it("copy policy：消费者修改 steering 的 message_end payload 不污染内部历史", async () => {
    let steeringCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "中途消息" }] : [];
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("完成")]);
    let mutated = false;
    // 消费者收到 message_end 后篡改事件 payload（payload 是浅拷贝快照）
    const sink: AgentEventSink = (event) => {
      if (event.type === "message_end" && event.message.role === "user" && event.message.text === "中途消息") {
        event.message.text = "MUTATED";
        mutated = true;
      }
    };
    const messages = await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, sink);

    // 篡改确实发生在事件侧
    expect(mutated).toBe(true);
    // 内部历史（下一轮 LLM input）未被污染
    expect(textsAt(llm, 1)).toContain("中途消息");
    expect(textsAt(llm, 1)).not.toContain("MUTATED");
    // 返回的 newMessages 未被污染
    expect(messages.some((m) => m.text === "中途消息")).toBe(true);
    expect(messages.some((m) => m.text === "MUTATED")).toBe(false);
  });

  it("单次取点返回多条：数组顺序保持、逐条消息事件（steering + follow-up）", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2
          ? [{ role: "user", text: "S1" }, { role: "user", text: "S2" }]
          : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1
          ? [{ role: "user", text: "F1" }, { role: "user", text: "F2" }]
          : [];
      },
    };
    const llm = new ScriptedLlm([textStream("A"), textStream("B"), textStream("C")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, recorder.sink);

    // 同一次数组内顺序保持：下一次 LLM input 按同序看到（S1→S2、F1→F2）
    expect(textsAt(llm, 1)).toEqual(["任务", "S1", "S2"]);
    expect(textsAt(llm, 2)).toEqual(["任务", "S1", "S2", "F1", "F2"]);
    // 每条消息分别产生 message_start / message_end，不合并成一条
    const dynTexts = ["S1", "S2", "F1", "F2"];
    const startTexts = recorder.events.flatMap((e) =>
      e.type === "message_start" && e.message.role === "user" && dynTexts.includes(e.message.text ?? "")
        ? [e.message.text]
        : [],
    );
    const endTexts = recorder.events.flatMap((e) =>
      e.type === "message_end" && e.message.role === "user" && dynTexts.includes(e.message.text ?? "")
        ? [e.message.text]
        : [],
    );
    expect(startTexts).toEqual(["S1", "S2", "F1", "F2"]);
    expect(endTexts).toEqual(["S1", "S2", "F1", "F2"]);
    // newMessages 最终顺序：initial → S1 → S2 → F1 → F2
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["任务", "S1", "S2", "F1", "F2"]);
  });
});
