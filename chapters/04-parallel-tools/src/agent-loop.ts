/**
 * 04 章增量：Parallel Tool Execution。
 *
 * 相对 03 章的变化（全部锚定 Pi）：
 * - 工具批次执行模式：config.toolExecution 默认 "parallel"（Pi types.ts L266-268），
 *   分流判定 executeToolCalls L411-426：显式 sequential 或任一工具 executionMode="sequential" → 串行
 * - **两阶段并行** executeToolCallsParallel（L489-554）：
 *   阶段 1 逐个 prepare（串行，立即失败先收尾，L499-538）
 *   阶段 2 并发执行（thunk + Promise.all，L540-542）
 * - **Ordered Concurrency**：tool_execution_end 按完成顺序发（thunk 内），
 *   toolResult 消息按 assistant 源顺序生成（ordered 遍历）——Pi 的双顺序协议
 * - 批终止延续：并行下同样整批全部 terminate 才停（L550-553）
 *
 * 剪裁（章节归属）：steering/follow-up→05、变换/停止钩子→06。
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";
import {
  emitToolResultMessage,
  executeAndFinalize,
  prepareToolCall,
  type FinalizedToolOutcome,
  type ImmediateToolOutcome,
  type PreparedToolCall,
  type ToolResultMessage,
} from "./tool-runtime.ts";

/** 事件输出（同前章）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 顶层入口：EventStream 封装（同 02/03 章）。 */
export function agentLoop(
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  signal?: AbortSignal,
): EventStream<AgentEvent, Message[]> {
  const stream = new EventStream<AgentEvent, Message[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );

  void runAgentLoop(prompts, context, config, llm, (event) => stream.push(event), signal)
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      console.error("agent 运行失败:", error instanceof Error ? error.message : String(error));
      stream.end([]);
    });

  return stream;
}

/** 启动一次 agent run（同前章）。 */
export async function runAgentLoop(
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Message[]> {
  // 空 prompts 守卫——继续请用 runAgentLoopContinue（Pi L120-143），空数组会让 LLM 无提示续写或 400
  if (prompts.length === 0) {
    throw new Error("prompts 不能为空：继续已有会话请用 continue 语义（07 章 runAgentLoopContinue）");
  }
  const newMessages: Message[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    // 快照：message 事件 payload 统一浅拷贝，消费者改动不影响内部 history
    await emit({ type: "message_start", message: { ...prompt } });
    await emit({ type: "message_end", message: { ...prompt } });
  }

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  return newMessages;
}

/** 主循环：单层循环（Pi 内层 L174-260，剪裁 steering）。 */
async function runLoop(
  context: AgentContext,
  newMessages: Message[],
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<void> {
  let hasMoreToolCalls = true;
  let firstTurn = true;  // Pi L175-179：首轮 turn_start 由 runAgentLoop 发出

  while (hasMoreToolCalls) {
    if (firstTurn) {
      firstTurn = false;
    } else {
      await emit({ type: "turn_start" });
    }

    const assistantMessage = await streamAssistantResponse(context, config, llm, emit, signal);
    newMessages.push(assistantMessage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      await emit({ type: "turn_end", message: assistantMessage, toolResults: [] });
      await emit({ type: "agent_end", messages: newMessages });
      return;
    }

    const toolCalls = assistantMessage.toolCalls ?? [];
    const toolResults: Message[] = [];
    hasMoreToolCalls = false;

    if (toolCalls.length > 0) {
      if (assistantMessage.stopReason === "length") {
        for (const toolCall of toolCalls) {
          toolResults.push(await truncatedToolResult(toolCall, emit));
        }
        // Pi L216：截断批 terminate=false → 继续循环，模型基于错误结果重发完整参数
        hasMoreToolCalls = true;
      } else {
        // 分流：Pi executeToolCalls L411-426
        const executed = await executeToolCalls(context, assistantMessage, toolCalls, config, emit, signal);
        for (const result of executed) {
          toolResults.push(result.message); // Pi L216-221：工具结果进入 toolResults（统一写入 + turn_end 携带）
        }
        // 批终止：整批全部 terminate 才停（L550-553）
        hasMoreToolCalls = !shouldTerminateToolBatch(executed);
      }
    }
    // 统一写入历史（Pi L218-221）：正常执行与截断保护的结果都进 context/newMessages
    for (const result of toolResults) {
      context.messages.push(result);
      newMessages.push(result);
    }

    await emit({ type: "turn_end", message: assistantMessage, toolResults });
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 工具批次执行：分流（Pi L411-426）。
 * 显式 sequential，或批次中任一工具的 executionMode === "sequential" → 串行；否则并行（默认）。
 */
async function executeToolCalls(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const hasSequentialTool = toolCalls.some(
    (tc) => context.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialTool) {
    return executeToolCallsSequential(context, assistantMessage, toolCalls, config, emit, signal);
  }
  return executeToolCallsParallel(context, assistantMessage, toolCalls, config, emit, signal);
}

/** 串行路径（Pi L433-487）：逐个 prepare → 执行 → 消息，立即失败就地收尾。 */
async function executeToolCallsSequential(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    const prepared = await prepareToolCall(context, assistantMessage, toolCall, config, emit, signal);
    if (prepared.kind === "immediate") {
      // Pi 串行 L472-474：end 已由 immediate 发，消息事件随执行顺序立即发
      await emit({ type: "message_start", message: { ...prepared.message } });
      await emit({ type: "message_end", message: { ...prepared.message } });
      results.push({ message: prepared.message, terminate: prepared.terminate });
    } else {
      const finalized = await executeAndFinalize(prepared, config, emit, context, assistantMessage, signal);
      results.push(await emitToolResultMessage(finalized, emit));
    }
    // Pi L478-480：abort 后 break，不再执行剩余工具
    if (signal?.aborted) {
      break;
    }
  }
  return results;
}

/**
 * 并行路径（Pi L489-554）。
 * 阶段 1：逐个 prepare（串行，L499-538），立即失败就地收尾进 entries；
 * 阶段 2：已备好的包装为 thunk，Promise.all 并发执行（L540-542），
 *         tool_execution_end 在 thunk 内按完成顺序发（L532）；
 * 收尾：按 assistant 源顺序生成 toolResult 消息（L543-548）——Ordered Concurrency。
 */
async function executeToolCallsParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  // 阶段 1：prepare 串行
  const entries: ({ kind: "immediate"; message: Message; terminate: boolean } | (() => Promise<FinalizedToolOutcome>))[] = [];
  for (const toolCall of toolCalls) {
    const prepared = await prepareToolCall(context, assistantMessage, toolCall, config, emit, signal);
    if (prepared.kind === "immediate") {
      entries.push({ kind: "immediate", message: prepared.message, terminate: prepared.terminate });
    } else {
      entries.push(() => executeAndFinalize(prepared, config, emit, context, assistantMessage, signal));
    }
    // Pi L516-518/L535-537：abort 后 break，不再 prepare 剩余工具
    if (signal?.aborted) {
      break;
    }
  }

  // 阶段 2：并发执行 thunk（immediate entry 原地 resolve 为 null，位置保持与 entries 一致）
  const ordered = await Promise.all(
    entries.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(null))),
  );

  // 收尾：按 assistant 源顺序生成消息（消息顺序 ≠ 完成顺序）
  const results: ToolResultMessage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "function") {
      // immediate：消息事件按源序在收尾统一发（Pi L543-548，与正常结果同序）
      await emit({ type: "message_start", message: { ...entry.message } });
      await emit({ type: "message_end", message: { ...entry.message } });
      results.push({ message: entry.message, terminate: entry.terminate });
    } else {
      results.push(await emitToolResultMessage(ordered[i] as FinalizedToolOutcome, emit));
    }
  }
  return results;
}

/** 批终止判定（Pi L582-584）：整批全部 terminate 才停。 */
function shouldTerminateToolBatch(results: ToolResultMessage[]): boolean {
  return results.length > 0 && results.every((r) => r.terminate === true);
}

/** 流式 assistant 响应（同前章，Pi L281-372）。 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of llm.complete(
    { model: config.model, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools ?? [] },
    signal,
  )) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "toolcall_start":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage },
            assistantMessageEvent: event,
          });
        }
        break;

      case "done": {
        const finalMessage = event.partial;
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: { ...finalMessage } });  // 快照：message 事件 payload 统一浅拷贝
        return finalMessage;
      }
    }
  }

  throw new Error("LLM 流未以 done 事件结束");
}

/** 截断保护的错误结果（同前章）。 */
async function truncatedToolResult(toolCall: ToolCall, emit: AgentEventSink): Promise<Message> {
  // Pi L387-392：tool_execution_start 携带原始参数
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text: `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
    isError: true,
  };
  // Pi L400-403：tool_execution_end + 消息事件（浅拷贝，消费者改动不污染内部历史）
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: message.text ?? "" }, isError: true });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return message;
}
