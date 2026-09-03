/**
 * 05 章 abort/error 语义测试：锁定 Pi 现有 interaction + abort 组合行为（不重新设计取消语义）。
 * runLoop 不直接检查 signal（Pi L155-275 同款）——取消经 Tool Runtime（工具结果落地）
 * 与 LLM stream（stopReason="aborted"）间接传播。
 * 流式 mock LLM 驱动（离线）。
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  AssistantMessageEvent,
  LLMAdapter,
  Message,
  Tool,
} from "../../00-minimal-llm-call/src/index.ts";

class ScriptedLlm implements LLMAdapter {
  private next = 0;
  readonly seenHistories: Message[][] = [];
  constructor(private steps: (AssistantMessageEvent[])[]) {}
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

/** stopReason = aborted / error 的最终流（适配器契约：失败编码进流，不 throw）。 */
function failedStream(stopReason: "aborted" | "error"): AssistantMessageEvent[] {
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

class EventRecorder {
  readonly events: AgentEvent[] = [];
  readonly sink = (event: AgentEvent): void => {
    this.events.push(event);
  };
  get types(): string[] {
    return this.events.map((e) => e.type);
  }
  indexOf(predicate: (e: AgentEvent) => boolean): number {
    const i = this.events.findIndex(predicate);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function baseContext(tools: Tool[]): AgentContext {
  return { systemPrompt: "助手", messages: [], tools: [createEchoTool(), ...tools] };
}

function userTextsAt(llm: ScriptedLlm, callIndex: number): string[] {
  return llm.seenHistories[callIndex]?.filter((m) => m.role === "user").map((m) => m.text ?? "") ?? [];
}

describe("error / aborted stopReason 早退（Pi L196-200）", () => {
  it.each([
    { stopReason: "aborted" as const, label: "aborted" },
    { stopReason: "error" as const, label: "error" },
  ])("stopReason=$label：turn_end + agent_end，跳过轮末 steering 与 follow-up", async ({ stopReason }) => {
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringPolls++;
        return [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [{ role: "user", text: "不应被查询" }];
      },
    };
    const llm = new ScriptedLlm([failedStream(stopReason)]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "任务" }], baseContext([]), config, llm, recorder.sink);

    // LLM 只调用一次；无额外 turn
    expect(llm.callCount).toBe(1);
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(1);
    // 初始 steering poll 是现有机制（保留）；轮末取点与 follow-up 被跳过
    expect(steeringPolls).toBe(1);
    expect(followUpPolls).toBe(0);
    // 当前 turn 正常收尾：turn_end 之后 agent_end，且 agent_end 恰一次
    expect(recorder.types).toContain("turn_end");
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
  });
});

describe("工具执行中 abort 后的 steering 语义", () => {
  it("steering 不打断当前工具；轮末取点照常；下一 LLM 以 aborted 收尾；follow-up 不再查询", async () => {
    const controller = new AbortController();
    const abortingTool: Tool = {
      name: "slow-abort",
      description: "慢工具",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _onUpdate, signal) => {
        // 模拟外部 abort 在工具执行期间到达（确定性：工具自身观察 signal）
        controller.abort();
        await sleep(10);
        if (signal?.aborted) throw new Error("Operation aborted");
        return { content: "done" };
      },
    };
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringPolls++;
        return steeringPolls === 2 ? [{ role: "user", text: "改查 D" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [{ role: "user", text: "不应被查询" }];
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "slow-abort", args: {} }]),
      failedStream("aborted"), // signal 已 aborted，适配器契约 → stopReason="aborted"
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "查 A" }],
      baseContext([abortingTool]),
      config,
      llm,
      recorder.sink,
      controller.signal,
    );

    // 1. 工具执行未被打断：错误 toolResult 落地（end + 消息事件均在 steering 消息事件之前）
    const toolEnd = recorder.indexOf((e) => e.type === "tool_execution_end");
    const toolResultMsg = recorder.indexOf((e) => e.type === "message_start" && e.message.role === "toolResult");
    // 2. turn_end 在 steering 消息事件之前
    const firstTurnEnd = recorder.indexOf((e) => e.type === "turn_end");
    const steeringMsg = recorder.indexOf((e) => e.type === "message_start" && e.message.text === "改查 D");
    expect(toolEnd).toBeLessThan(steeringMsg);
    expect(toolResultMsg).toBeLessThan(firstTurnEnd);
    expect(firstTurnEnd).toBeLessThan(steeringMsg);
    // 3. steering 进入下一次 LLM input
    expect(userTextsAt(llm, 1)).toContain("改查 D");
    // 4. 轮末 steering poll 照常发生（初始 + 回合 1 轮末）；follow-up 不再查询
    expect(steeringPolls).toBe(2);
    expect(followUpPolls).toBe(0);
    // 5. 下一 LLM 以 aborted 收尾：两次调用、两个 turn、agent_end 恰一次
    expect(llm.callCount).toBe(2);
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(2);
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });
});

describe("abort + inner 正常退出后的 follow-up", () => {
  it("follow-up 被查询并注入新 turn，但 aborted run 不能被复活", async () => {
    const controller = new AbortController();
    const terminateTool: Tool = {
      name: "term-on-abort",
      description: "工具",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _onUpdate, signal) => {
        controller.abort();
        await sleep(10);
        // abort 后正常返回并终止批次 → inner 以「无更多工具」方式正常退出，到达 follow-up 检查点
        if (signal?.aborted) return { content: "aborted-but-complete", terminate: true };
        return { content: "done", terminate: true };
      },
    };
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringPolls++;
        return [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return followUpPolls === 1 ? [{ role: "user", text: "再总结" }] : [];
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "term-on-abort", args: {} }]),
      failedStream("aborted"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "跑" }],
      baseContext([terminateTool]),
      config,
      llm,
      recorder.sink,
      controller.signal,
    );

    // 1. follow-up 确实被查询（恰好一次）
    expect(followUpPolls).toBe(1);
    // 2. agent_end 尚未发出：follow-up 消息事件在 agent_end 之前
    const followUpMsg = recorder.indexOf((e) => e.type === "message_start" && e.message.text === "再总结");
    const agentEnd = recorder.indexOf((e) => e.type === "agent_end");
    expect(followUpMsg).toBeLessThan(agentEnd);
    // 3+4. follow-up 注入新 turn，下一次 LLM input 能看到
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(2);
    expect(userTextsAt(llm, 1)).toContain("再总结");
    // 5. signal 已 aborted → 下一 LLM 以 aborted 收尾
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    // 6. agent_end 恰一次
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
    // 7. 两次 LLM；轮末 steering 取点（返回空）也照常发生
    expect(llm.callCount).toBe(2);
    expect(steeringPolls).toBe(2);
  });
});
