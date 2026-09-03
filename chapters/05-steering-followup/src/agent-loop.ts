/**
 * 05 章增量：Steering & Follow-up——双层循环（Two-phase Interaction）。
 *
 * 相对 04 章的变化（全部锚定 Pi，runLoop L155-275）：
 * - **外层循环**（L170）：agent 本应停止后，若 follow-up 到达则继续
 * - **内层循环**（L174）：`while (hasMoreToolCalls || pendingMessages.length > 0)`——
 *   条件含 pending，steering 消息也能驱动内层继续
 * - **steering（运行中注入）**：三个取点
 *   初始（L167）、注入（L182-190：进历史 + 消息事件）、轮末重取（L259）
 * - **follow-up（停止后注入）**：一个取点（L263-268），内层退出后检查，非空则回外层
 *
 * 两种生命周期的区分（教学主线）：
 *   steering   = 当前工作流内的打断（回合之间插入，模型下一轮看到）
 *   follow-up  = 当前工作流结束后的新开始（完整回合之后，agent 本应停止时）
 *
 * 剪裁（章节归属）：prepareNextTurn/shouldStopAfterTurn/transformContext/getApiKey→06。
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";
import { emitToolResultMessage, executeAndFinalize, prepareToolCall, type FinalizedToolOutcome, type ToolResultMessage } from "./tool-runtime.ts";

/** 事件输出（同前章）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 顶层入口：EventStream 封装（同前章）。 */
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
    // message 事件 payload 统一浅拷贝（Pi 此处为原引用，教学 deliberate divergence）
    await emit({ type: "message_start", message: { ...prompt } });
    await emit({ type: "message_end", message: { ...prompt } });
  }

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  return newMessages;
}

/**
 * 主循环：双层结构（Pi L155-275）。
 * 外层（L170）：follow-up 生命周期。内层（L174）：回合 + 工具 + steering 注入。
 */
async function runLoop(
  context: AgentContext,
  newMessages: Message[],
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<void> {
  // steering 初始取点（Pi L167：用户可能在你等待时输入）
  let pendingMessages: Message[] = (await config.getSteeringMessages?.()) || [];

  // 外层循环：Pi L170
  let firstTurn = true;  // Pi L175-179：首轮 turn_start 由 runAgentLoop 发出
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环：Pi L174。pending 非空也能驱动继续（steering 注入后需要新一轮 LLM 调用）
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (firstTurn) {
        firstTurn = false;
      } else {
        await emit({ type: "turn_start" });
      }

      // 注入 steering 消息（Pi L182-190）：进历史 + 消息事件
      // 事件 payload 浅拷贝（Pi 此处为原引用，教学 deliberate divergence）；内部历史保存原对象
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message: { ...message } });
          await emit({ type: "message_end", message: { ...message } });
          context.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
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
          // 工具执行沿用 04 章分流（默认并行）
          const executed = await executeToolCalls(context, assistantMessage, toolCalls, config, emit, signal);
          for (const result of executed) {
            toolResults.push(result.message);  // Pi L216-221：工具结果进入 toolResults（统一写入 + turn_end 携带）
          }
          hasMoreToolCalls = !shouldTerminateToolBatch(executed);
        }
      }
      // 统一写入历史（Pi L218-221）：正常执行与截断保护的结果都进 context/newMessages
      for (const result of toolResults) {
        context.messages.push(result);
        newMessages.push(result);
      }

      await emit({ type: "turn_end", message: assistantMessage, toolResults });

      // steering 轮末重取（Pi L259）
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 内层退出：agent 本应停止。检查 follow-up（Pi L263-268）
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      // 设为 pending，回到外层继续（L266-267）
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/** 工具批次执行：分流（同 04 章，Pi L411-426）。 */
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

/** 串行路径（同 04 章，Pi L433-487）。 */
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

/** 并行路径（同 04 章，Pi L489-554）。 */
async function executeToolCallsParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
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

  const ordered = await Promise.all(
    entries.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(null))),
  );

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

/** 批终止判定（同前章，Pi L582-584）。 */
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
        // message_end 同样快照（Pi 此处为原引用，教学 deliberate divergence）
        await emit({ type: "message_end", message: { ...finalMessage } });
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
