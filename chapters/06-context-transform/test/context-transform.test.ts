/**
 * 06 章测试：Context Transformation——transformContext/getApiKey/prepareNextTurn/shouldStopAfterTurn。
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

/** 流式 mock LLM：记录每次调用的输入（消息、apiKey、model、systemPrompt）。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenInputs: { messages: Message[]; apiKey?: string; model: string; systemPrompt: string }[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push({ messages: [...input.messages], apiKey: input.apiKey, model: input.model, systemPrompt: input.systemPrompt });
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

/** stopReason = error / aborted 的最终流（适配器契约：失败编码进流，不 throw）。 */
function failStream(stopReason: "error" | "aborted"): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason } },
    {
      type: "done",
      partial: {
        role: "assistant",
        stopReason,
        errorMessage: stopReason === "error" ? "请求失败" : "请求已中止",
      },
    },
  ];
}

/** 消息标签：用于断言 LLM/transform 输入序列。 */
function labelOf(m: Message): string {
  if (m.role === "user") return `U:${m.text}`;
  if (m.role === "toolResult") return `T:${m.toolName}`;
  return "A";
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

describe("Context Transformation（06 章）", () => {
  it("transformContext：LLM 调用前的消息被变换（裁剪/注入，Pi L289-292）", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => [
        ...messages,
        { role: "user", text: "【系统背景】当前时间 12:00" },
      ],
    };
    const llm = new ScriptedLlm([textStream("完成")]);
    await runAgentLoop([{ role: "user", text: "几点了" }], baseContext(), config, llm, () => {});

    // 模型收到的消息包含变换注入的背景（但 context 本身不被修改）
    const seen = llm.seenInputs[0].messages;
    expect(seen.some((m) => m.text === "【系统背景】当前时间 12:00")).toBe(true);
  });

  it("transformContext 时机：每次 LLM 调用前都执行（含工具后的下一轮）", async () => {
    let transformCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformCalls++;
        return messages;
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, () => {});

    expect(transformCalls).toBe(2); // 两轮 LLM 调用各一次
  });

  it("transformContext 只影响发给 LLM 的消息，不改写 context 历史", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => messages.slice(0, 1), // 只留第一条
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, () => {});

    // 第二轮发给 LLM 的消息被裁剪（只有第一条）
    expect(llm.seenInputs[1].messages).toHaveLength(1);
  });

  it("getApiKey：每次 LLM 调用前解析并传给 complete（Pi L304-306）", async () => {
    let apiKeyCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getApiKey: () => {
        apiKeyCalls++;
        return "sk-dynamic-key";
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, () => {});

    expect(apiKeyCalls).toBe(2);
    expect(llm.seenInputs[0].apiKey).toBe("sk-dynamic-key");
    expect(llm.seenInputs[1].apiKey).toBe("sk-dynamic-key");
  });

  it("prepareNextTurn：替换 context 与 model，下一轮生效（Pi L232-245）", async () => {
    let nextTurnCalls = 0;
    const config: AgentLoopConfig = {
      model: "model-a",
      prepareNextTurn: async ({ context }) => {
        nextTurnCalls++;
        if (nextTurnCalls === 1) {
          return {
            model: "model-b",
            context: { ...context, systemPrompt: "替换后的系统提示" },
          };
        }
        return undefined;
      },
    };
    // 第 1 轮带工具 → hasMoreToolCalls=true → 第 2 轮（model-b 生效）
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("第二轮"),
    ]);
    await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, () => {});

    expect(llm.callCount).toBe(2);
    expect(llm.seenInputs[1]).toMatchObject({ model: "model-b" });
    // context replacement 真正生效：下一轮 LLM 请求看到替换后的 systemPrompt（不只是 model 切换）
    expect(llm.seenInputs[1].systemPrompt).toBe("替换后的系统提示");
    // 第 2 轮输入历史：prompt + assistant(tool_use) + toolResult
    expect(llm.seenInputs[1].messages).toHaveLength(3);
  });

  it("shouldStopAfterTurn：true → 优雅停止（当前回合正常结束，工具结果已落盘）", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      shouldStopAfterTurn: async ({ toolResults }) => toolResults.length > 0, // 有工具结果就停
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }])]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, recorder.sink);

    expect(llm.callCount).toBe(1); // 工具回合后立即停，不再调用 LLM
    expect(recorder.types.at(-1)).toBe("agent_end");
    // 工具结果已落盘（优雅停止的保证）
    expect(messages.some((m) => m.role === "toolResult" && m.text === "3")).toBe(true);
  });

  it("组合：transformContext + prepareNextTurn + shouldStopAfterTurn 全链路 + 回归", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => messages,
      getApiKey: () => "key",
      shouldStopAfterTurn: async ({ message }) => message.text === "完成",
    };
    const llm = new ScriptedLlm([textStream("完成")]);
    const messages = await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, () => {});

    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "完成" });
  });

  it("canonical vs LLM view：transform 输入是完整 canonical，返回值只进本次 LLM 请求（不自动写回）", async () => {
    // canonical 预置历史：U1 / A1 / U2（与本次任务无关）
    const oldReply: AssistantMessage = { role: "assistant", text: "A1", stopReason: "end_turn" };
    const history: Message[] = [
      { role: "user", text: "U1" },
      oldReply,
      { role: "user", text: "U2" },
    ];
    const transformInputs: Message[][] = [];
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformInputs.push([...messages]); // 记录输入快照（输入是 canonical 原引用）
        return messages.slice(-1);           // 只把最后一条投影给 LLM
      },
    };
    // 两个 LLM 调用：工具回合 + 最终回复，用于验证第二轮 transform 仍从完整 canonical 出发
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    const messages = await runAgentLoop(
      [{ role: "user", text: "U3" }],
      { systemPrompt: "SYS", messages: history, tools: [echo, calculator] },
      config,
      llm,
      () => {},
    );

    // 1. transform 输入 = 完整 canonical（旧历史 + 本轮 prompt）
    expect(transformInputs[0].map(labelOf)).toEqual(["U:U1", "A", "U:U2", "U:U3"]);
    // 2. LLM 第 1 次请求只看到投影（最后一条）
    expect(llm.seenInputs[0].messages.map(labelOf)).toEqual(["U:U3"]);
    // 3. 第 2 轮 transform 输入仍来自完整 canonical（6 条：历史 + 本轮 prompt + assistant + toolResult），
    //    不是第 1 次 slice(-1) 的残留——transform return value 不自动写回 canonical
    expect(transformInputs[1]).toHaveLength(6);
    expect(transformInputs[1].at(-1)).toMatchObject({ role: "toolResult" });
    // 4. 第 2 次 LLM 请求同样只看到该轮投影（最后一条 toolResult）
    expect(llm.seenInputs[1].messages.map(labelOf)).toEqual(["T:calculator"]);
    // 5. newMessages 只含本 run 新增消息（U3/A/T/A），不含预置历史 U1/A1/U2
    expect(messages.map(labelOf)).toEqual(["U:U3", "A", "T:calculator", "A"]);
  });

  it("copy policy + 动态消息可见性：篡改 steering 的 message_end payload 不污染 canonical/transform/LLM；follow-up 轮 transform 可见", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const transformInputs: Message[][] = [];
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformInputs.push([...messages]);
        return messages;
      },
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "S-回合间" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "F-停止后" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("A"), textStream("B"), textStream("C")]);
    let mutated = false;
    const sink: AgentEventSink = (event) => {
      // 消费者收到 steering 的 message_end 后篡改事件 payload（payload 是浅拷贝快照）
      if (event.type === "message_end" && event.message.role === "user" && event.message.text === "S-回合间") {
        event.message.text = "MUTATED";
        mutated = true;
      }
    };
    const messages = await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, sink);

    // 篡改确实发生在事件侧
    expect(mutated).toBe(true);
    // steering 轮的 transform 输入（canonical 原引用内容）与 LLM input 未被污染
    expect(transformInputs[1].some((m) => m.text === "S-回合间")).toBe(true);
    expect(transformInputs[1].some((m) => m.text === "MUTATED")).toBe(false);
    expect(llm.seenInputs[1].messages.some((m) => m.text === "S-回合间")).toBe(true);
    expect(llm.seenInputs[1].messages.some((m) => m.text === "MUTATED")).toBe(false);
    // newMessages 未被污染
    expect(messages.some((m) => m.text === "S-回合间")).toBe(true);
    expect(messages.some((m) => m.text === "MUTATED")).toBe(false);
    // follow-up 轮的 transform 输入同时包含 steering 与 follow-up（transform 永远发生在注入之后）
    const thirdUsers = transformInputs[2].filter((m) => m.role === "user").map((m) => m.text);
    expect(thirdUsers).toEqual(["任务", "S-回合间", "F-停止后"]);
  });

  it("turn 边界顺序：turn_end → prepareNextTurn → shouldStopAfterTurn → steeringPoll（含替换语义）", async () => {
    const order: string[] = [];
    let shouldStopContextSystemPrompt = "";
    const config: AgentLoopConfig = {
      model: "m",
      prepareNextTurn: async ({ context }) => {
        order.push("prepareNextTurn");
        return { context: { ...context, systemPrompt: "v2" } };
      },
      shouldStopAfterTurn: async ({ context }) => {
        order.push("shouldStopAfterTurn");
        shouldStopContextSystemPrompt = context.systemPrompt;
        return false;
      },
      getSteeringMessages: async () => {
        order.push("steeringPoll");
        return [];
      },
      getFollowUpMessages: async () => {
        order.push("followUpPoll");
        return [];
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    const sink: AgentEventSink = (event) => {
      if (event.type === "turn_start" || event.type === "turn_end") order.push(event.type);
    };
    await runAgentLoop([{ role: "user", text: "算" }], baseContext(), config, llm, sink);

    // 每个正常 turn 后严格满足：turn_end → prepareNextTurn → shouldStopAfterTurn → steeringPoll；
    // 初始 steeringPoll（Chapter 05 既有机制）位于首个 turn_start 之后、首轮 LLM 之前
    expect(order).toEqual([
      "turn_start",
      "steeringPoll",
      "turn_end",
      "prepareNextTurn",
      "shouldStopAfterTurn",
      "steeringPoll",
      "turn_start",
      "turn_end",
      "prepareNextTurn",
      "shouldStopAfterTurn",
      "steeringPoll",
      "followUpPoll",
    ]);
    // shouldStopAfterTurn 收到的是 prepareNextTurn 替换后的 context
    expect(shouldStopContextSystemPrompt).toBe("v2");
    // 下一轮 LLM 请求看到替换后的 canonical systemPrompt
    expect(llm.seenInputs[1].systemPrompt).toBe("v2");
  });

  it("shouldStopAfterTurn=true：跳过 turn-end steering poll 与 follow-up（agent_end 直接发出）", async () => {
    let steeringPolls = 0;
    let followUpPolls = 0;
    let prepareCalls = 0;
    let shouldStopCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      prepareNextTurn: async () => {
        prepareCalls++;
        return undefined;
      },
      shouldStopAfterTurn: async () => {
        shouldStopCalls++;
        return true;
      },
      getSteeringMessages: async () => {
        steeringPolls++;
        return [{ role: "user", text: "不应进入" }];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [{ role: "user", text: "不应进入" }];
      },
    };
    const llm = new ScriptedLlm([textStream("完成")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, recorder.sink);

    // 当前 turn 正常落盘：turn_end 已发、结果进 newMessages
    expect(recorder.types).toContain("turn_end");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "完成" });
    // prepareNextTurn 与 shouldStopAfterTurn 都被调用
    expect(prepareCalls).toBe(1);
    expect(shouldStopCalls).toBe(1);
    // steering 总轮询 = 仅初始（turn-end poll 被跳过）；follow-up 0；无新 turn
    expect(steeringPolls).toBe(1);
    expect(followUpPolls).toBe(0);
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(1);
    // agent_end 收尾
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it.each([
    { stopReason: "aborted" as const, label: "aborted" },
    { stopReason: "error" as const, label: "error" },
  ])("stopReason=$label：早退跳过 prepareNextTurn/shouldStopAfterTurn/turn-end steering/follow-up", async ({ stopReason }) => {
    let transformCalls = 0;
    let apiKeyCalls = 0;
    let prepareCalls = 0;
    let shouldStopCalls = 0;
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformCalls++;
        return messages;
      },
      getApiKey: () => {
        apiKeyCalls++;
        return "k";
      },
      prepareNextTurn: async () => {
        prepareCalls++;
        return undefined;
      },
      shouldStopAfterTurn: async () => {
        shouldStopCalls++;
        return false;
      },
      getSteeringMessages: async () => {
        steeringPolls++;
        return [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [];
      },
    };
    const llm = new ScriptedLlm([failStream(stopReason)]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, recorder.sink);

    // 调用前钩子已执行（LLM 请求确实发出）
    expect(transformCalls).toBe(1);
    expect(apiKeyCalls).toBe(1);
    // 早退边界：turn 后钩子全部跳过（Pi L196-200 return 在 L226/L247/L259/L263 之前）
    expect(prepareCalls).toBe(0);
    expect(shouldStopCalls).toBe(0);
    expect(steeringPolls).toBe(1); // 仅初始 poll
    expect(followUpPolls).toBe(0);
    // 事件收尾：turn_end → agent_end
    expect(recorder.types).toContain("turn_end");
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("transformContext 抛错：不被 runLoop catch，LLM 不被调用（顶层兜底）", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async () => {
        throw new Error("transform 爆炸");
      },
    };
    const llm = new ScriptedLlm([textStream("不应到达")]);
    await expect(
      runAgentLoop([{ role: "user", text: "任务" }], baseContext(), config, llm, () => {}),
    ).rejects.toThrow("transform 爆炸");
    expect(llm.callCount).toBe(0);
  });
});
