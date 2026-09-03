/**
 * 00 章共享基座：LLM 适配器（全链路流式，Pi 形状）。
 *
 * 对应 Pi 的 `StreamFn`（agent 包 types.ts L28-32）——Pi 没有非流式路径：
 * `Models.streamSimple` 恒返回 `AssistantMessageEventStream`，循环统一消费流事件
 * （agent-loop.ts L317-361）。本章接口即按此设计：`complete()` 返回 AsyncIterable 事件流。
 *
 * 契约（同 Pi StreamFn 注释）：失败不 throw，编码进流——error 时 `done` 事件的
 * partial 带 `stopReason: "error"` 与 `errorMessage` 文本（pi-ai L439）。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, AssistantMessageEvent, Message, StopReason, Tool } from "./types.ts";

/** 一次 LLM 调用的输入：Pi `Context`（agent-loop.ts L298-302）的 V0 形状。 */
export interface LLMRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  /** 每次调用动态解析的 API key（06 章 getApiKey 钩子的落点；Pi L304-306）。 */
  apiKey?: string;
}

/** LLM 适配器接口：`complete()` 返回流式事件序列（全链路流式）。 */
export interface LLMAdapter {
  complete(input: LLMRequest, signal?: AbortSignal): AsyncIterable<AssistantMessageEvent>;
}

/**
 * 模型 ID 由运行环境注入（CLAUDE_MODEL），未设置时经 complete 参数显式传入；本章不讨论模型选择。
 */
const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "";

/** Anthropic 实现：SDK `client.messages.stream()` 事件映射为统一流事件。 */
export class AnthropicLlmAdapter implements LLMAdapter {
  private client: Anthropic;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string; baseURL?: string }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey, baseURL: opts?.baseURL });
    this.model = opts?.model ?? DEFAULT_MODEL;
  }

  async *complete({ model, systemPrompt, messages, tools, apiKey }: LLMRequest, signal?: AbortSignal): AsyncIterable<AssistantMessageEvent> {
    const resolvedModel = model || this.model;
    if (!resolvedModel) {
      throw new Error("未指定模型：请通过 CLAUDE_MODEL 环境变量或 complete 参数传入模型 ID");
    }
    let textAcc = "";
    let thinkingAcc = "";
    let thinkingSignature: string | undefined;
    // blockIndex：SDK 的 content block 索引（含 text 块，不能当数组下标用）
    let toolCalls: { id: string; name: string; argsJson: string; blockIndex: number }[] = [];
    let stopReason: StopReason = "end_turn";
    let errorMessage: string | undefined;
    let sawStopReason = false;  // 流是否收到 message_delta 的 stop_reason（Pi L775-777 无则报错）

    const snapshot = (): AssistantMessage => ({
      role: "assistant",
      text: textAcc || undefined,
      thinking: thinkingAcc || undefined,
      thinkingSignature,
      toolCalls: toolCalls.map(({ id, name, argsJson }) => ({ id, name, arguments: parseArgs(argsJson) })),
      stopReason,
      errorMessage,
    });

    try {
      const stream = this.client.messages.stream(
        {
          model: resolvedModel,
          max_tokens: 16000,
          system: systemPrompt,
          messages: convertToLlm(messages),
          tools: tools.map(toAnthropicTool),
        },
        // apiKey：每次调用动态解析（06 章 getApiKey 钩子的落点）。
        // SDK 0.121 的 RequestOptions 无 apiKey 字段，per-request 覆盖走 x-api-key 请求头。
        { signal, ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}) },
      );

      // 契约（Pi L319-324）：流开始即发 start。必须在 stream() 建立之后 yield——
      // 请求体在 stream() 调用时已快照，消费方把 start 的 partial 推入 context 不再影响已发出的请求
      yield { type: "start", partial: snapshot() };

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "thinking") {
              thinkingSignature = event.content_block.signature;
            } else if (event.content_block.type === "redacted_thinking") {
              // 审核重写：Pi L629-638 映射为 [Reasoning redacted] thinking 块 + signature=data
              // （data 是不透明载荷，原样作为签名回传，协议要求）
              thinkingAcc = "[Reasoning redacted]";
              thinkingSignature = event.content_block.data;
            } else if (event.content_block.type === "tool_use") {
              toolCalls.push({
                id: event.content_block.id,
                name: event.content_block.name,
                argsJson: "",
                blockIndex: event.index,
              });
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              textAcc += event.delta.text;
              yield { type: "text_delta", partial: snapshot() };
            } else if (event.delta.type === "thinking_delta") {
              // 推理增量：块级累积（不做流式 thinking 事件）
              thinkingAcc += event.delta.thinking;
            } else if (event.delta.type === "input_json_delta") {
              const tc = toolCalls.find((t) => t.blockIndex === event.index);
              if (tc) {
                tc.argsJson += event.delta.partial_json;
              }
            } else if (event.delta.type === "signature_delta") {
              // thinking 签名经流式 signature_delta 分片送达（Pi anthropic-messages.ts L691-697 累积），
              // content_block_start 中的 signature 通常为空；不累积则签名回传守卫永不满足
              thinkingSignature = (thinkingSignature ?? "") + event.delta.signature;
            }
            break;
          case "message_delta":
            if (event.delta.stop_reason) {
              sawStopReason = true;
              const mapped = mapStopReason(event.delta.stop_reason);
              stopReason = mapped.reason;
              errorMessage = mapped.errorMessage ?? errorMessage;
            }
            break;
        }
      }

      // Pi L775-777：流结束无 stop_reason → 显式报错（教学编码进 done 的 stopReason）
      if (!sawStopReason) {
        stopReason = "error";
        errorMessage = "流结束但未收到 stop_reason";
      }
    } catch (error) {
      // 契约：失败不 throw，全部编码进流（Pi L784-794 所有错误 → error 事件）；中止 → aborted
      if (signal?.aborted) {
        stopReason = "aborted";
        errorMessage = "操作已中止";
      } else {
        stopReason = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    yield { type: "done", partial: snapshot() };
  }
}

/** provider stop_reason → 统一 StopReason（附错误文本，供 refusal 等场景）。 */
function mapStopReason(reason: Anthropic.Message["stop_reason"]): { reason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "tool_use":
      return { reason: "tool_use" };
    case "max_tokens":
      return { reason: "length" };
    case "end_turn":
      return { reason: "end_turn" };
    case "refusal":
      // 安全拒绝是真实返回（HTTP 200），与 API 硬错误区分：error + 明确文本
      return { reason: "error", errorMessage: "模型拒绝了请求（refusal）" };
    case "pause_turn":
    case "stop_sequence":
      // Pi L1365-1390：两者视为正常结束（pause_turn 注释 "Stop is good enough -> resubmit"），
      // 不得误报 error（长输出场景 pause_turn 会出现）
      return { reason: "end_turn" };
    default:
      return { reason: "error" };
  }
}

/** 解析失败降级为空对象：参数语义校验属于后续 Tool Runtime 章节，本章只恢复 provider 解码。 */
function parseArgs(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * ★ 边界转换（Pi 设计点 1）：统一 `Message[]` → provider `MessageParam[]`
 * （Pi 调用点 agent-loop.ts L295；定义在 agent.ts L33-37）。
 *
 * 连续 toolResult 合并为一条 user 消息：Pi 在 provider 层 convertMessages 做同样的事
 * （anthropic-messages.ts L1266-1291，注释 "needed for z.ai Anthropic endpoint"）。
 * 教学把这段 provider 归一化收进本函数，属于教学简化，并非 Pi 在
 * convertToLlm 里合并。协议理由：Anthropic 建议所有工具结果放在同一条 user 消息
 * （拆开多条会干扰模型对并行工具调用的理解）；真实端点实测：拆开时第二轮调用会得到
 * error（见 05 章 demo 诊断）。
 */
export function convertToLlm(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    // UI 专用消息过滤（Pi 注释示例：Filter out UI-only messages，types.ts L170-172）
    if (m.uiOnly) {
      continue;
    }
    switch (m.role) {
      case "toolResult":
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.text ?? "",
          is_error: m.isError ?? false,
        });
        break;
      case "user":
        flushToolResults();
        // Pi convertMessages L1169-1176：空/空白文本 user 消息被过滤（协议卫生），不得发 content:""
        if (m.text?.trim()) {
          result.push({ role: "user", content: m.text });
        }
        break;
      case "assistant": {
        flushToolResults();
        const blocks: Anthropic.ContentBlockParam[] = [];
        // thinking 回传（协议要求：模型返回的 thinking 块必须原样传回，否则 400；
        // SDK 类型要求 signature 与文本一起。回传条件（满足才发 thinking 块）：
        // 1) 文本与签名都存在（缺失签名如 JSON 往返丢失 → 丢弃 thinking 只发 text）
        // 2) 消息同时有 text 或 toolCalls（协议要求 thinking 后必须跟 text/tool_use；
        //    仅 thinking 块（如中途 error/aborted 的 partial）→ 跳过 thinking，避免 400）
        const assistant = m as AssistantMessage;
        if (assistant.thinking) {
          if (assistant.thinkingSignature && (assistant.text || (assistant.toolCalls?.length ?? 0) > 0)) {
            // 回传条件：文本与签名都存在，且消息有 text 或 toolCalls（教学守卫，避免 400）
            blocks.push({ type: "thinking", thinking: assistant.thinking, signature: assistant.thinkingSignature });
          } else if (!assistant.thinkingSignature) {
            // 无签名（aborted/JSON 往返丢失）：Pi L1232-1243 转 text 块保留推理内容，不丢弃
            blocks.push({ type: "text", text: assistant.thinking });
          }
        }
        if (m.text) {
          blocks.push({ type: "text", text: m.text });
        }
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        }
        // 空 assistant（无任何块）：Pi L1261 语义为丢弃整条（不产生 content: []，协议 400 风险同消）
        if (blocks.length === 0) {
          break;
        }
        result.push({ role: "assistant", content: blocks });
        break;
      }
    }
  }
  flushToolResults();
  return result;
}

function toAnthropicTool(tool: Tool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
