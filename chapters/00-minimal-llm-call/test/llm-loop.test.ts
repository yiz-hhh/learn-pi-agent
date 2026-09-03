/**
 * 00 章测试：LLM 边界转换（convertToLlm）与 EventStream 生产-消费解耦。
 * 基座层的测试不依赖真实 API（离线）；真实端点验证见 demo.ts。
 */
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/llm.ts";
import { EventStream } from "../src/stream.ts";
import type { AssistantMessage, Message } from "../src/types.ts";

describe("convertToLlm（★ 设计点 1：唯一边界转换，agent-loop.ts L295）", () => {
  it("user 消息 → Anthropic MessageParam", () => {
    const messages: Message[] = [{ role: "user", text: "你好" }];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([{ role: "user", content: "你好" }]);
  });

  it("assistant 消息（text + toolCalls）→ 块数组", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      text: "我需要计算",
      toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 1, b: 2 } }],
      stopReason: "tool_use",
    };
    const messages: Message[] = [assistant];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "我需要计算" },
          { type: "tool_use", id: "call_1", name: "calculator", input: { a: 1, b: 2 } },
        ],
      },
    ]);
  });

  it("toolResult 消息 → 连续的合并为一条 user 消息（协议要求，多个 tool_result 块）", () => {
    const messages: Message[] = [
      { role: "toolResult", toolCallId: "call_1", toolName: "calculator", text: "3", isError: false },
      { role: "toolResult", toolCallId: "call_2", toolName: "boom", text: "失败", isError: true },
    ];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "3", is_error: false },
          { type: "tool_result", tool_use_id: "call_2", content: "失败", is_error: true },
        ],
      },
    ]);
  });

  it("toolResult 被其他角色分隔时各自成组（只合并连续的）", () => {
    const messages: Message[] = [
      { role: "user", text: "hi" },
      { role: "toolResult", toolCallId: "call_1", toolName: "calculator", text: "3", isError: false },
      { role: "user", text: "继续" },
      { role: "toolResult", toolCallId: "call_2", toolName: "boom", text: "失败", isError: true },
    ];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "3", is_error: false }] },
      { role: "user", content: "继续" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "失败", is_error: true }] },
    ]);
  });
});

describe("EventStream（生产-消费解耦，pi-ai event-stream.ts）", () => {
  const endWhen = (e: { type: string; messages?: Message[] }) => e.type === "end";
  const extract = (e: { type: string; messages?: Message[] }) => e.messages ?? [];

  it("先生产后消费：事件不丢不重复", async () => {
    const stream = new EventStream<{ type: string; messages?: Message[] }, Message[]>(endWhen, extract);
    stream.push({ type: "a" });
    stream.push({ type: "b" });
    stream.push({ type: "end", messages: [] });

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    expect(types).toEqual(["a", "b", "end"]);
  });

  it("消费者先挂起等待，事件到达后唤醒交付", async () => {
    const stream = new EventStream<{ type: string }, Message[]>(endWhen, extract);
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    stream.push({ type: "a" });
    expect((await first).value).toMatchObject({ type: "a" });
    stream.end([]);
    expect((await iterator.next()).done).toBe(true);
  });

  it("结束信号自动提取结果；end() 显式结束", async () => {
    const stream = new EventStream<{ type: string; messages?: Message[] }, Message[]>(endWhen, extract);
    stream.push({ type: "end", messages: [{ role: "user", text: "x" }] });
    expect(await stream.result()).toEqual([{ role: "user", text: "x" }]);
    stream.push({ type: "end", messages: [] }); // done 后 push 无效
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    expect(types).toEqual(["end"]);
  });
});
