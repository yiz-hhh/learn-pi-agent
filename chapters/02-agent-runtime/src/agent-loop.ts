/**
 * 02 章增量：完整 Agent Runtime——在 01 最小循环上补全 Pi `runLoop` + `streamAssistantResponse` 的全部核心机制。
 *
 * 相对 01 章的变化（全部锚定 Pi，行号基于 pinned commit）：
 * - 事件模型：agent/turn/message 三类事件，含流式专用 `message_update`（Pi `AgentEvent` types.ts L428-443）
 * - **流式增量消费**：partial 快照替换 context 末条（L335-343）+ message_update（L438）——
 *   01 章「只取 done」升级为完整消费（start → 增量 → done）
 * - stopReason 显式化（end_turn/tool_use/length/error/aborted）+ errorMessage 文本
 * - 终止①②：error/aborted 立即停（L196-200）/ 无 tool call 结束（L216+L274）
 * - newMessages 增量语义与 context 快照隔离（L103/L104-107）
 * - 截断保护：length 时工具全部判错不执行（L208-213+L381-406）
 * - `agentLoop` 顶层入口：EventStream 封装（L31-54 + createAgentStream L145-150）
 * - AbortSignal：中断 → stopReason aborted → 终止①
 *
 * 剪裁（章节归属）：steering/follow-up→05、并行→04、tool 事件与参数校验→03、
 * shouldStopAfterTurn/prepareNextTurn/transformContext/getApiKey→06。
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";

/** 事件输出：Pi `AgentEventSink`（agent-loop.ts L25）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 顶层入口：创建 EventStream 并后台启动 runAgentLoop。
 * 对应 Pi `agentLoop`（L31-54）+ `createAgentStream`（L145-150）：
 * 结束信号 = agent_end 事件；结果 = 事件携带的 newMessages。
 */
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

  // Pi L40-51：后台运行，结束时 stream.end(messages) 传递结果；
  // agent_end 事件本身由 runLoop 内 emit 发出（不会重复）
  void runAgentLoop(prompts, context, config, llm, (event) => stream.push(event), signal)
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      // 循环内钩子/流异常不应让消费者永久挂起：结束流并留痕（错误编码进流的契约不覆盖钩子）
      console.error("agent 运行失败:", error instanceof Error ? error.message : String(error));
      stream.end([]);
    });

  return stream;
}

/** 启动一次 agent run：newMessages 只含本轮新增；context 快照隔离（Pi L103-107）。 */
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

  // Pi L109-114：agent 生命周期开始 + 首个 turn + prompts 消息事件
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

    // 流式完整消费：Pi L193 streamAssistantResponse（L281-372）
    const assistantMessage = await streamAssistantResponse(context, config, llm, emit, signal);
    newMessages.push(assistantMessage);

    // 终止①：Pi L196-200（error/aborted → turn_end + agent_end 立即返回）
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
        // 截断保护：Pi L208-213 + L381-406（流式参数可能残缺，全部判错）
        for (const toolCall of toolCalls) {
          toolResults.push(await truncatedToolResult(toolCall, emit));
        }
        // Pi L216：截断批 terminate=false → 继续循环，模型基于错误结果重发完整参数
        hasMoreToolCalls = true;
      } else {
        // 串行执行：Pi executeToolCallsSequential（L433-487）
        for (const toolCall of toolCalls) {
          toolResults.push(await executeToolCall(context, toolCall, emit, signal));
          // Pi L478-480：abort 后 break，不再执行剩余工具
          if (signal?.aborted) {
            break;
          }
        }
        hasMoreToolCalls = true;
      }

      for (const result of toolResults) {
        context.messages.push(result);
        newMessages.push(result);
      }
    }

    // Pi L224：turn 结束
    await emit({ type: "turn_end", message: assistantMessage, toolResults });
  }

  // 终止②：无工具调用 → agent_end（Pi L274；Pi 在退出前检查 follow-up，05 章引入）
  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 流式 assistant 响应：完整消费流事件，维护 partial 快照。
 * 对应 Pi `streamAssistantResponse`（L281-372）：
 * - start：partial 入 context + message_start（L319-324）
 * - 增量（text/toolcall）：partial **替换** context 末条 + message_update（L335-343）——01 章只取 done，本章开始处理增量
 * - done：最终消息落定 + message_end（L346-359）
 */
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

/** 执行单个工具调用并构造 toolResult 消息（Pi L600-668/L670-711/L777-791；消息事件对应 emitToolResultMessage L793-796）。 */
async function executeToolCall(context: AgentContext, toolCall: ToolCall, emit: AgentEventSink, signal?: AbortSignal): Promise<Message> {
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  let resultMessage: Message;
  if (!tool) {
    resultMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Tool ${toolCall.name} not found`,
      isError: true,
    };
  } else {
    try {
      // Pi L679-682：signal 透传给工具 execute（长任务可自行中止）
      const result = await tool.execute(toolCall.arguments as never, undefined, signal);
      resultMessage = { role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, text: result.content, isError: false };
    } catch (error) {
      resultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
  // 快照：message 事件 payload 统一浅拷贝（resultMessage 随后进入 context，共享引用会让消费者改动污染历史）
  await emit({ type: "message_start", message: { ...resultMessage } });
  await emit({ type: "message_end", message: { ...resultMessage } });
  return resultMessage;
}

/** 截断保护的错误结果（Pi failToolCallsFromTruncatedMessage L381-406 的消息形状）。 */
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
