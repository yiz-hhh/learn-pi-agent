/**
 * 01 章测试：Tool Calling 循环（流式 mock 驱动，离线）。
 * mock 事件序列构造参考 00 基座的 AssistantMessageEvent（start + done，可含 delta）。
 */
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { LLMAdapter, LLMRequest } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：按脚本步骤逐轮返回事件序列，并记录每次输入。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly inputs: LLMRequest[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    this.inputs.push(input);
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

/** 构造文本回复的事件序列。 */
function textStream(text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason } },
    { type: "done", partial: { role: "assistant", stopReason, text: text || undefined } },
  ];
}

/** 构造工具调用的事件序列。 */
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

const echo = createEchoTool();
const calculator = createCalculatorTool();

function lastMessage(messages: Message[]): Message {
  return messages[messages.length - 1];
}

describe("agentLoop（01：Tool Calling，流式接口）", () => {
  it("终止：无工具调用即结束（一次 LLM 调用返回最终文本）", async () => {
    const llm = new ScriptedLlm([textStream("你好！")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "你是助手",
      messages: [{ role: "user", text: "打个招呼" }],
      tools: [echo, calculator],
      llm,
    });

    expect(llm.callCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].text).toBe("你好！");
  });

  it("工具闭环：tool_call → toolResult → LLM 再次调用 → 最终文本", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "echo", { text: "hi" }), textStream("已回显")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "你是助手",
      messages: [{ role: "user", text: "回显 hi" }],
      tools: [echo, calculator],
      llm,
    });

    expect(llm.callCount).toBe(2);
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1", text: "hi", isError: false });
    expect(lastMessage(messages).text).toBe("已回显");
  });

  it("关键闭环：第二次 LLM 调用收到的历史必须包含 toolResult（结果回传）", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "calculator", { a: 12, b: 30 }), textStream("42")]);
    await agentLoop({
      model: "m",
      systemPrompt: "计算助手",
      messages: [{ role: "user", text: "12+30=?" }],
      tools: [echo, calculator],
      llm,
    });

    // 内部消息模型：toolResult 保持独立角色（convertToLlm 的合并发生在 adapter 内部，provider 侧）
    const secondInput = llm.inputs[1].messages;
    expect(secondInput[1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "calculator" }] });
    expect(secondInput[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1", text: "42", isError: false });
  });

  it("多轮工具调用（echo → calculator → 文本）", async () => {
    const llm = new ScriptedLlm([
      toolStream("call_1", "echo", { text: "开始" }),
      toolStream("call_2", "calculator", { a: 1, b: 2 }),
      textStream("完成"),
    ]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "助手",
      messages: [{ role: "user", text: "依次执行" }],
      tools: [echo, calculator],
      llm,
    });

    expect(llm.callCount).toBe(3);
    expect(messages[4].text).toBe("3");
    expect(lastMessage(messages).text).toBe("完成");
  });

  it("工具未找到 → 错误 toolResult（Pi prepareToolCall L608-614），循环不中断", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "unknown_tool", {}), textStream("没有这个工具")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "助手",
      messages: [{ role: "user", text: "调用 unknown_tool" }],
      tools: [echo, calculator],
      llm,
    });

    expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "unknown_tool", isError: true });
    expect(messages[2].text).toContain("not found");
    expect(lastMessage(messages).role).toBe("assistant");
  });

  it("工具执行抛异常 → 错误 toolResult（Pi executePreparedToolCall L701-707）", async () => {
    const broken: Tool = {
      name: "boom",
      description: "总是失败",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("炸弹工具执行失败");
      },
    };
    const llm = new ScriptedLlm([toolStream("call_1", "boom", {}), textStream("收到错误")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "助手",
      messages: [{ role: "user", text: "调用 boom" }],
      tools: [echo, calculator, broken],
      llm,
    });

    expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "boom", isError: true });
    expect(messages[2].text).toBe("炸弹工具执行失败");
  });
});
