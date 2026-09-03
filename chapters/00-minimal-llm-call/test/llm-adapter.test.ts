/**
 * 00 章测试：AnthropicLlmAdapter 全链路流式事件映射。
 *
 * 基座层关键路径覆盖：start 时序、增量累积、
 * thinking 签名（signature_delta）、apiKey 头、refusal、resolvedModel、
 * redacted_thinking、pause_turn 映射。本文件用 vi.mock 注入 SDK mock，离线验证。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Message, StopReason } from "../src/types.ts";

const asst = (m: Partial<AssistantMessage>): AssistantMessage => ({ role: "assistant", stopReason: "end_turn", ...m });

/** 记录流事件序列的 mock SDK。 */
const streamEvents: (Record<string, unknown>)[] = [];
const calls: { headers?: Record<string, string>; model?: string }[] = [];
/** 模拟请求过程中的 provider 异常：非空时 mock 流在产完预置事件后抛出。 */
let mockFailure: Error | null = null;

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      stream: (opts: { model: string; system?: string; messages?: unknown[]; tools?: unknown[]; max_tokens?: number }, requestOptions?: { headers?: Record<string, string> }) => {
        calls.push({ headers: requestOptions?.headers, model: opts.model });
        const events = [...streamEvents];
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) {
              yield e;
            }
            if (mockFailure) {
              throw mockFailure;
            }
          },
        };
      },
    };
  }
  return { default: MockAnthropic };
});

import { AnthropicLlmAdapter } from "../src/llm.ts";

const req = {
  model: "",
  systemPrompt: "s",
  messages: [{ role: "user" as const, text: "hi" }],
  tools: [],
};

/** 事件构造器：简化事件形状。 */
const textBlockStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const textDelta = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
const thinkingBlockStart = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } };
const thinkingDelta = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } });
const signatureDelta = (s: string) => ({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: s } });
const toolBlockStart = (id: string, name: string) => ({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } });
const inputJsonDelta = (j: string) => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: j } });
const messageDelta = (stop_reason: string) => ({ type: "message_delta", delta: { stop_reason } });

async function drain(iter: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

afterEach(() => {
  streamEvents.length = 0;
  calls.length = 0;
  mockFailure = null;
  vi.clearAllMocks();
});

describe("adapter 全链路（对照 Pi anthropic-messages.ts L575-795）", () => {
  it("start 在 stream() 建立之后 yield（消费方污染 start partial 不影响已发请求）", async () => {
    streamEvents.push(textBlockStart, textDelta("你好"), { type: "content_block_stop", index: 0 }, messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    // AsyncIterable 手动迭代：取第一个事件（start）
    const events: AssistantMessageEvent[] = [];
    for await (const e of llm.complete(req)) {
      events.push(e);
      break;  // 只取 start
    }
    const first = events[0];
    expect(first?.type).toBe("start");
    // 消费方把 start 的 partial 推入自己的 context（教学循环的用法）
    const consumed = first as { type: "start"; partial: { text?: string } };
    consumed.partial.text = "污染";
    // 请求已发出的证据：start 事件到达前 mock 已被调用（请求体已在 stream() 时快照）
    expect(calls.length).toBe(1);
  });

  it("text_delta 累积 + stopReason 映射（end_turn）", async () => {
    streamEvents.push(textBlockStart, textDelta("你"), textDelta("好"), { type: "content_block_stop", index: 0 }, messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "done"]);
    const done = events.at(-1) as { type: "done"; partial: { text?: string; stopReason?: StopReason } };
    expect(done.partial.text).toBe("你好");
    expect(done.partial.stopReason).toBe("end_turn");
  });

  it("signature_delta 累积：thinking 签名经流式分片到达（Pi L691-697）", async () => {
    streamEvents.push(thinkingBlockStart, thinkingDelta("推理中"), signatureDelta("SIG-ABC-123"), messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { thinking?: string; thinkingSignature?: string } };
    expect(done.partial.thinking).toBe("推理中");
    expect(done.partial.thinkingSignature).toBe("SIG-ABC-123");
  });

  it("redacted_thinking 映射为 [Reasoning redacted] + signature=data（Pi L629-638）", async () => {
    streamEvents.push(
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "redacted-payload" } },
      messageDelta("end_turn"),
    );
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { thinking?: string; thinkingSignature?: string } };
    expect(done.partial.thinking).toBe("[Reasoning redacted]");
    expect(done.partial.thinkingSignature).toBe("redacted-payload");
  });

  it("apiKey 走 x-api-key 请求头（SDK 0.121 RequestOptions 无 apiKey 字段）", async () => {
    streamEvents.push(textBlockStart, textDelta("ok"), messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    await drain(llm.complete({ ...req, apiKey: "sk-test-123" }));
    expect(calls[0]?.headers).toEqual({ "x-api-key": "sk-test-123" });
  });

  it("refusal → stopReason=error + 明确文本（Pi L1365-1390）", async () => {
    streamEvents.push(textBlockStart, textDelta("拒绝"), messageDelta("refusal"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { stopReason?: StopReason; errorMessage?: string } };
    expect(done.partial.stopReason).toBe("error");
    expect(done.partial.errorMessage).toContain("refusal");
  });

  it("pause_turn/stop_sequence → end_turn（Pi：Stop is good enough）", async () => {
    streamEvents.push(textBlockStart, textDelta("长输出"), messageDelta("pause_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { stopReason?: StopReason } };
    expect(done.partial.stopReason).toBe("end_turn");
  });

  it("resolvedModel：complete 参数优先于构造参数", async () => {
    streamEvents.push(textBlockStart, textDelta("ok"), messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "constructor-model" });
    await drain(llm.complete({ ...req, model: "complete-model" }));
    expect(calls[0]?.model).toBe("complete-model");
    calls.length = 0;
    await drain(llm.complete(req));
    expect(calls[0]?.model).toBe("constructor-model");
  });

  it("tool_use 块：input_json_delta 按 blockIndex 累积（index 非数组下标）", async () => {
    streamEvents.push(
      textBlockStart,
      textDelta("先"),
      toolBlockStart("call_1", "calculator"),
      inputJsonDelta('{"a":12,"b":30}'),
      messageDelta("tool_use"),
    );
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { text?: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] } };
    expect(done.partial.text).toBe("先");
    expect(done.partial.toolCalls?.[0]).toEqual({ id: "call_1", name: "calculator", arguments: { a: 12, b: 30 } });
  });

  it("请求过程中的 provider 异常编码进最终 done 事件，不 throw（StreamFn 契约）", async () => {
    streamEvents.push(textBlockStart, textDelta("已经收到的部分"));
    mockFailure = new Error("provider stream broken");
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    // 契约断言：消费方完整消费事件流而没有收到任何 throw
    const events = await drain(llm.complete(req));
    // 失败发生在请求建立之后（start 已发出、部分文本已到达）
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    const done = events.at(-1) as { type: "done"; partial: { stopReason?: StopReason; errorMessage?: string } };
    expect(done.type).toBe("done");
    expect(done.partial.stopReason).toBe("error");
    expect(done.partial.errorMessage).toContain("provider stream broken");
  });
});

describe("convertToLlm 边界", () => {
  it("空文本 user 消息被过滤（Pi L1169-1176）", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([{ role: "user", text: "" }, { role: "user", text: "有效" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", content: "有效" });
  });

  it("空 assistant（无文本无工具调用）整条丢弃（Pi L1261）", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([asst({ stopReason: "error", errorMessage: "失败" })]);
    expect(out).toHaveLength(0);
  });

  it("thinking 无签名 → 转 text 块保留推理（Pi L1232-1243）", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([asst({ thinking: "推理过程", text: "答案" })]);
    const blocks = out[0].content as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocks[0].text).toBe("推理过程");
    expect(blocks[1].text).toBe("答案");
  });

  it("thinking 有签名有文本 → thinking 块原样回传（Pi L1246-1250）", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([asst({ thinking: "推理", thinkingSignature: "sig-1", text: "答案" })]);
    const blocks = out[0].content as { type: string; thinking?: string; signature?: string }[];
    expect(blocks).toEqual([
      { type: "thinking", thinking: "推理", signature: "sig-1" },
      { type: "text", text: "答案" },
    ]);
  });
});
