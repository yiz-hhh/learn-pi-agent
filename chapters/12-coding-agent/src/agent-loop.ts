/**
 * 12 章 runtime：06 章增量 Context Transformation + runAgentLoopContinue，与 09 章最终版一致。
 * 09 章增量（保留）：addedToolNames 动态工具合并（loadTools 钩子，Pi types.ts L368-369）
 * 与跨 run 工具回写（runAgentLoop 与 runAgentLoopContinue 末尾）。
 *
 * 相对 05 章的变化（全部锚定 Pi）：
 * - `transformContext`（L289-292）：LLM 调用前，AgentMessage[] → AgentMessage[]（上下文变换）
 * - `getApiKey`（L304-306）：每次 LLM 调用前动态解析 API key（OAuth 过期场景）
 * - `prepareNextTurn`（L232-245）：turn_end 后替换下一轮的 context/model
 * - `shouldStopAfterTurn`（L247-257）：turn_end 后优雅停止（工具结果已正常落盘）
 *
 * 一轮的时间线（钩子位置）：
 *   turn_start → [steering 注入] → transformContext → convertToLlm → getApiKey → LLM
 *   → 工具执行 → turn_end → prepareNextTurn → shouldStopAfterTurn → [轮末重取 steering]
 *
 * Context as a Hook：上下文变换不在循环内置，而是 AgentMessage 层的钩子。
 * 注意（08 章修正）：compaction 不经过这条接缝（Pi sdk.ts L362-366 只接 extension
 * emitContext）；loop 对 compaction 零感知——Session Compaction 在 08 层完成：
 *   Session Tree → buildSessionContext（重建投影）→ canonical state.messages
 *   → transformContext（extension 注入接缝）→ call-time messages
 * Product Assembly 直接复用现有 loop，产品工具通过组装层接入。
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
      stream.push({ type: "agent_end", messages: [] });  // 发 agent_end，消费者可区分崩溃与空结果
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
    throw new Error("prompts 不能为空：继续已有会话请用 runAgentLoopContinue");
  }
  const newMessages: Message[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  // 回写调用方持有的 context.tools（动态加载的工具跨 run 保留；currentContext 可能被
  // prepareNextTurn 替换，以最终 currentContext 为准）
  context.tools = currentContext.tools;
  return newMessages;
}

/** 继续入口（Pi `runAgentLoopContinue` L120-143）：不注入新消息，从当前 context 继续。 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Message[]> {
  if (context.messages.length === 0) {
    throw new Error("无消息可继续（Pi：Cannot continue: no messages in context）");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("不能从 assistant 消息继续（Pi：Cannot continue from message role: assistant）");
  }

  // Pi L135-136：newMessages 从空开始（不重复已有消息）；context 原样使用
  const newMessages: Message[] = [];
  const currentContext: AgentContext = { ...context, messages: [...context.messages] };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  // 动态加载的工具同样回写调用方 context
  context.tools = currentContext.tools;
  return newMessages;
}

/** 主循环：双层结构（05 章）+ 四个新钩子。 */
async function runLoop(
  context: AgentContext,
  newMessages: Message[],
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<void> {
  let currentContext = context;
  let currentConfig = config;
  let pendingMessages: Message[] = (await currentConfig.getSteeringMessages?.()) || [];

  let firstTurn = true;  // Pi L175-179：首轮 turn_start 由 runAgentLoop 发出
  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (firstTurn) {
        firstTurn = false;
      } else {
        await emit({ type: "turn_start" });
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const assistantMessage = await streamAssistantResponse(currentContext, currentConfig, llm, emit, signal);
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
            // Pi L386-403：截断结果事件齐全（tool_execution_start/end + 消息事件，浅拷贝）
            toolResults.push(await truncatedToolResult(toolCall, emit));
          }
          // Pi L216：截断批 terminate=false → 继续循环，模型基于错误结果重发完整参数
          hasMoreToolCalls = true;
        } else {
          const executed = await executeToolCalls(currentContext, assistantMessage, toolCalls, currentConfig, emit, signal);
          for (const result of executed) {
            toolResults.push(result.message);  // Pi L216-221：工具结果进入 toolResults（统一写入 + turn_end 携带）
          }
          hasMoreToolCalls = !shouldTerminateToolBatch(executed);
        }
      }
      // 统一写入历史（Pi L218-221）：正常执行与截断保护的结果都进 context/newMessages
      for (const result of toolResults) {
        currentContext.messages.push(result);
        newMessages.push(result);
      }
      // 动态工具（09 章）：结果带 addedToolNames → loadTools 引入新工具（Pi types.ts L368-369）
      const addedNames = toolResults.flatMap((r) => r.addedToolNames ?? []);
      if (addedNames.length > 0 && currentConfig.loadTools) {
        const loaded = currentConfig.loadTools([...new Set(addedNames)]);
        const existing = new Set(currentContext.tools?.map((t) => t.name) ?? []);
        const fresh = loaded.filter((t) => !existing.has(t.name));
        if (fresh.length > 0) {
          currentContext.tools = [...(currentContext.tools ?? []), ...fresh];
          // 动态加载的工具写入 currentContext；跨 run 回写调用方 context.tools 在
          // runAgentLoop 层完成（此处 runLoop 的 context 参数即其局部 currentContext，自我赋值无效）
        }
      }

      await emit({ type: "turn_end", message: assistantMessage, toolResults });

      // prepareNextTurn（Pi L232-245）：turn_end 后替换下一轮的 context/model
      const turnContext = { message: assistantMessage, toolResults, context: currentContext, newMessages };
      const nextTurn = await currentConfig.prepareNextTurn?.(turnContext);
      if (nextTurn) {
        currentContext = nextTurn.context ?? currentContext;
        if (nextTurn.model) {
          currentConfig = { ...currentConfig, model: nextTurn.model };
        }
      }

      // shouldStopAfterTurn（Pi L247-257）：优雅停止，当前回合已正常结束。
      // 用 prepareNextTurn 替换后的 context（不能拿替换前的旧引用做停止判定）
      if (await currentConfig.shouldStopAfterTurn?.({ ...turnContext, context: currentContext })) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await currentConfig.getSteeringMessages?.()) || [];
    }

    const followUpMessages = (await currentConfig.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/** 流式 assistant 响应：transformContext + getApiKey 在此生效（Pi L281-372 的 L289-306 区间）。 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  // transformContext（Pi L289-292）：AgentMessage[] → AgentMessage[]，发生在 convertToLlm 之前
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // getApiKey（Pi L304-306）：每次调用前动态解析
  const resolvedApiKey = config.getApiKey ? await config.getApiKey() : undefined;

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of llm.complete(
    { model: config.model, systemPrompt: context.systemPrompt, messages, tools: context.tools ?? [], apiKey: resolvedApiKey },
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
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  throw new Error("LLM 流未以 done 事件结束");
}

/** 工具批次执行：分流（同 04/05 章，Pi L411-426）。 */
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

/** 串行路径（同前章，Pi L433-487）。 */
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

/** 并行路径（同前章，Pi L489-554）。 */
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
