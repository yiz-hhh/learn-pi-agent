/**
 * 03 章增量：Agent Runtime + Tool Runtime。
 *
 * 相对 02 章的变化（全部锚定 Pi）：
 * - 工具执行从「找到就调用」升级为五步流水线（见 tool-runtime.ts）
 * - `tool_execution_start/update/end` 事件：四类事件模型补全（L441-450/L767-775）
 * - **Batch Termination**：工具结果携带 `terminate` 提示，循环在整批**全部** terminate 时才停
 *   （Pi `shouldTerminateToolBatch` L582-584，语义：terminate 是「建议停止」而非「命令停止」）
 * - 钩子：`beforeToolCall`（L619-647）/`afterToolCall`（L724-751），钩子即边界（Philosophy 3）
 *
 * 剪裁（章节归属）：并行执行→04、steering/follow-up→05、变换/停止钩子→06。
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";
import { executeToolCall, type ToolExecutionOutcome } from "./tool-runtime.ts";

/** 事件输出（同前章）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 顶层入口：EventStream 封装（同 02 章，Pi L31-54 + L145-150）。 */
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

/** 启动一次 agent run（同 02 章）。 */
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
        // 串行执行流水线（并行在 04 章）：每个 tool call 走五步 + 钩子 + tool 事件
        const outcomes: ToolExecutionOutcome[] = [];
        for (const toolCall of toolCalls) {
          outcomes.push(await executeToolCall(context, assistantMessage, toolCall, config, emit, signal));
          // Pi L478-480：abort 后 break，不再执行剩余工具
          if (signal?.aborted) {
            break;
          }
        }
        for (const outcome of outcomes) {
          toolResults.push(outcome.message);  // Pi L216-221：工具结果进入 toolResults（统一写入 + turn_end 携带）
        }
        // 批终止：整批全部 terminate 才停（Pi L582-584）
        hasMoreToolCalls = !shouldTerminateToolBatch(outcomes);
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

/** 流式 assistant 响应（同 02 章，Pi L281-372）。 */
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

/**
 * 批终止判定（Pi `shouldTerminateToolBatch` L582-584）：
 * 仅当批次非空且**所有**结果 terminate === true 时才停。
 * 语义：terminate 是每个工具对「该停了」的建议，不是命令；一个批里不能因为某个工具建议停就打断其他工具。
 */
function shouldTerminateToolBatch(outcomes: ToolExecutionOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((outcome) => outcome.terminate === true);
}

/** 截断保护的错误结果（同 02 章）。 */
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
