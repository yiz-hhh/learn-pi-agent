/**
 * 04 章工具运行时：03 章合并版流水线拆分为两阶段（忠实 Pi 的函数结构）。
 *
 * Pi 中本来就是两个函数：
 * - `prepareToolCall`（L600-668）：lookup → prepareArguments → validate → beforeToolCall
 *   返回 PreparedToolCall（可执行）或 ImmediateToolCallOutcome（未找到/校验失败/blocked）
 * - `executePreparedToolCall`（L670-711）+ `finalizeExecutedToolCall`（L713-758）：
 *   执行 + onUpdate + afterToolCall，产出 FinalizedToolCallOutcome
 *
 * 两阶段拆分是并行的前置条件（Pi L489-554）：prepare 串行（副作用安全、立即失败先收尾），
 * execute 并发。消息事件与 end 事件的分离见 agent-loop.ts 的 executeToolCallsParallel。
 */
import { validateToolArguments } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  Message,
  Tool,
  ToolCall,
  ToolResult,
} from "../../00-minimal-llm-call/src/index.ts";

/** 事件输出（同前章）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 已准备好、可执行的工具调用（Pi `PreparedToolCall`，agent-loop.ts L556-561）。 */
export interface PreparedToolCall {
  kind: "prepared";
  tool: Tool;
  args: unknown;
  toolCall: ToolCall;
}

/** 立即收尾的结果：未找到 / 校验失败 / 钩子 block（Pi `ImmediateToolCallOutcome` L563-567）。 */
export interface ImmediateToolOutcome {
  kind: "immediate";
  message: Message;
  terminate: boolean;
}

/** 执行并最终化后的结果（Pi `FinalizedToolCallOutcome` L574-578）。 */
export interface FinalizedToolOutcome {
  toolCall: ToolCall;
  result: ToolResult;
  isError: boolean;
}

/** 规范化后的工具结果消息（Pi `createToolResultMessage` L777-791）。 */
export interface ToolResultMessage {
  message: Message;
  terminate: boolean;
}

/**
 * 阶段 1：prepare（Pi L600-668）。
 * 串行执行（无论最终是否并行）：lookup → 参数兼容 → 校验 → beforeToolCall。
 * 立即失败（未找到/校验失败/blocked）在此收尾，不需要进入并发阶段。
 */
export async function prepareToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<PreparedToolCall | ImmediateToolOutcome> {
  // tool_execution_start：Pi L445-450 在 prepare 之前发出，携带原始参数（未找到也有 start，保证 end 配对）
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

  // lookup（Pi L607）
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return immediate(toolCall, `Tool ${toolCall.name} not found`, false, emit);
  }

  // 参数兼容层（Pi L586-598）
  let args: unknown = toolCall.arguments;
  if (tool.prepareArguments) {
    try {
      args = tool.prepareArguments(toolCall.arguments);
    } catch (error) {
      return immediate(toolCall, `参数转换失败: ${messageOf(error)}`, false, emit);
    }
  }

  // schema 校验（Pi L618）
  const validation = validateToolArguments(tool, args);
  if (!validation.ok) {
    return immediate(toolCall, `参数校验失败: ${validation.error}`, false, emit);
  }

  // Pi L629-635：abort 后不再继续 prepare（Operation aborted 语义）
  if (signal?.aborted) {
    return immediate(toolCall, "Operation aborted", false, emit);
  }

  // beforeToolCall（Pi L619-647）
  if (config.beforeToolCall) {
    let before;
    try {
      before = await config.beforeToolCall({ assistantMessage, toolCall, args, context });
    } catch (error) {
      // Pi L616-667：钩子抛错 → immediate 错误结果，不击穿批次
      return immediate(toolCall, `beforeToolCall 钩子抛错: ${messageOf(error)}`, false, emit);
    }
    if (before?.block) {
      return immediate(toolCall, before.reason || "工具执行被阻止", before.terminate === true, emit);
    }
  }

  // Pi L648-654：beforeToolCall 之后再次检查 abort
  if (signal?.aborted) {
    return immediate(toolCall, "Operation aborted", false, emit);
  }

  return { kind: "prepared", tool, args, toolCall };
}

/**
 * 阶段 2a：执行 + finalize（Pi `executePreparedToolCall` L670-711 + `finalizeExecutedToolCall` L713-758）。
 * 并发执行时放入 thunk：只发 tool_execution_end（完成顺序），不产生消息事件（消息统一按源顺序生成）。
 */
export async function executeAndFinalize(
  prepared: PreparedToolCall,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  context: AgentContext,
  assistantMessage: AssistantMessage,
  signal?: AbortSignal,
): Promise<FinalizedToolOutcome> {
  const { tool, args, toolCall } = prepared;
  let result: ToolResult;
  let isError = false;
  let acceptingUpdates = true;  // Pi L676/L684：execute settle 后忽略迟到的 onUpdate

  try {
    // Pi L679-682：signal 透传给工具 execute（长任务可自行中止）
    result = await tool.execute(args as never, (partial) => {
      if (!acceptingUpdates) return;  // Pi L684：settle 后忽略
      void emit({
        type: "tool_execution_update",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,  // Pi L691：原始参数（prepare 前的模型参数）
        partialResult: partial,
      });
    }, signal);
  } catch (error) {
    result = { content: messageOf(error) };
    isError = true;
  } finally {
    acceptingUpdates = false;  // Pi L708-710
  }

  if (config.afterToolCall) {
    // Pi L726-736：afterToolCall 接收当前 context 与 assistantMessage
    let after;
    try {
      after = await config.afterToolCall({ assistantMessage, toolCall, args, result, isError, context });
    } catch (error) {
      // Pi L747-750：钩子抛错 → 错误结果，不击穿整个批次
      result = { content: messageOf(error) };
      isError = true;
    }
    if (after) {
      result = {
        content: after.content ?? result.content,
        details: after.details ?? result.details,
        usage: after.usage ?? result.usage,
        terminate: after.terminate ?? result.terminate,
        addedToolNames: after.addedToolNames ?? result.addedToolNames,
      };
      if (after.isError !== undefined) {
        isError = after.isError;
      }
    }
  }

  // Pi L767-775：tool_execution_end 在 finalize 后立即发（完成顺序）
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
  return { toolCall, result, isError };
}

/** 阶段 2b：规范化 + 消息事件（Pi `createToolResultMessage` L777-791 + `emitToolResultMessage` L793-796）。按 assistant 源顺序调用。 */
export async function emitToolResultMessage(
  finalized: FinalizedToolOutcome,
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  const message: Message = {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    text: finalized.result.content ?? "",  // Pi L782-784：content ?? []，null 不进历史/provider
    isError: finalized.isError,
    ...(finalized.result.details !== undefined ? { details: finalized.result.details } : {}),
    ...(finalized.result.usage !== undefined ? { usage: finalized.result.usage } : {}),
    ...(finalized.result.terminate !== undefined ? { terminate: finalized.result.terminate } : {}),
    ...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
  };
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return { message, terminate: finalized.result.terminate === true };
}

/** 立即失败收尾：end 事件 + 消息事件（Pi L454-459 串行路径 / L508-519 并行路径）。 */
async function immediate(toolCall: ToolCall, text: string, terminate: boolean, emit: AgentEventSink): Promise<ImmediateToolOutcome> {
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text,
    isError: true,
    ...(terminate ? { terminate: true } : {}),
  };
  // Pi 并行 L508-519：immediate 只发 end（完成顺序）；消息事件由执行路径按序发
  // （串行：随执行顺序立即发 L472-474；并行：收尾按源序统一发 L543-548）
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: text }, isError: true });
  return { kind: "immediate", message, terminate };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
