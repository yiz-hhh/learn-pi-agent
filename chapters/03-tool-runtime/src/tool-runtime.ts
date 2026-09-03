/**
 * 03 章核心：工具执行流水线（Tool Runtime）。
 *
 * 一次工具调用从「找到就调用」（01/02 章）升级为五步流水线，全部锚定 Pi：
 *   lookup    → 查找工具（Pi L607；未找到 → 错误结果 L608-614）
 *   prepare   → 参数兼容层（Pi `prepareToolCallArguments` L586-598）
 *   validate  → schema 校验（Pi `validateToolArguments` L618）
 *   execute   → 执行 + onUpdate 增量回调（Pi L670-711 + L683-697）
 *   normalize → 结果规范化：details/usage/terminate/addedToolNames/isError（Pi `createToolResultMessage` L777-791）
 *
 * 两个钩子（Pi 的边界设计，Philosophy 3）：
 *   beforeToolCall  → 执行前可 block（L619-647）
 *   afterToolCall   → 执行后字段级改写（L724-751）
 *
 * tool_execution_* 三类事件补全 Pi 的四类事件模型（L441-450/L767-775）。
 */
import { validateToolArguments } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  Message,
  ToolCall,
  ToolResult,
} from "../../00-minimal-llm-call/src/index.ts";

/** 事件输出（同前章）。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** 一次工具执行的结果：规范化后的消息 + 是否建议停止。 */
export interface ToolExecutionOutcome {
  message: Message;
  /** 该结果是否建议本轮后停止（Pi `result.terminate`，types.ts L374）。 */
  terminate: boolean;
}

/**
 * 执行单个工具调用，走完五步流水线。
 * 对应 Pi `prepareToolCall`（L600-668）+ `executePreparedToolCall`（L670-711）
 * + `finalizeExecutedToolCall`（L713-758）+ `createToolResultMessage`（L777-791）的串行路径。
 */
export async function executeToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolExecutionOutcome> {
  // tool_execution_start：Pi L445-450 在 prepare 之前发出，携带原始参数（未找到也有 start，保证 end 配对）
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

  // 0. lookup：Pi L607
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    // Pi L608-614：未找到 → 立即错误结果（错误是数据）
    return immediateOutcome(toolCall, `Tool ${toolCall.name} not found`, false, emit);
  }

  // 1. prepare：参数兼容层（Pi L586-598）。转换失败也走错误结果，不中断循环。
  let args: unknown = toolCall.arguments;
  if (tool.prepareArguments) {
    try {
      args = tool.prepareArguments(toolCall.arguments);
    } catch (error) {
      return immediateOutcome(toolCall, `参数转换失败: ${messageOf(error)}`, false, emit);
    }
  }

  // 2. validate：schema 校验（Pi L618）。校验失败在 execute 之前被发现，不会把脏参数塞进工具。
  const validation = validateToolArguments(tool, args);
  if (!validation.ok) {
    return immediateOutcome(toolCall, `参数校验失败: ${validation.error}`, false, emit);
  }

  // Pi L629-635：abort 后不再继续 prepare（Operation aborted 语义）
  if (signal?.aborted) {
    return immediateOutcome(toolCall, "Operation aborted", false, emit);
  }

  // 3. beforeToolCall 钩子（Pi L619-647）：可 block（附 reason），block 时也可参与批终止判定
  if (config.beforeToolCall) {
    let before;
    try {
      before = await config.beforeToolCall({ assistantMessage, toolCall, args, context });
    } catch (error) {
      // Pi L616-667：钩子抛错 → immediate 错误结果，不击穿批次
      return immediateOutcome(toolCall, `beforeToolCall 钩子抛错: ${messageOf(error)}`, false, emit);
    }
    if (before?.block) {
      return immediateOutcome(toolCall, before.reason || "工具执行被阻止", before.terminate === true, emit);
    }
  }

  // Pi L648-654：beforeToolCall 之后再次检查 abort
  if (signal?.aborted) {
    return immediateOutcome(toolCall, "Operation aborted", false, emit);
  }

  // 5. execute + onUpdate（Pi L670-711；partial 更新经 tool_execution_update 事件流出 L683-697）
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
    // Pi L701-707：异常 → 错误结果（延续）
    result = { content: messageOf(error) };
    isError = true;
  } finally {
    acceptingUpdates = false;  // Pi L708-710
  }

  // 6. afterToolCall 钩子（Pi L724-751）：字段级改写，不做深合并
  if (config.afterToolCall) {
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

  // 7. normalize（Pi L777-791）+ tool_execution_end（L767-775）+ 消息事件（L793-796）
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text: result.content ?? "",  // Pi L782-784：content ?? []，null 不进历史/provider
    isError,
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
    ...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
  };
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return { message, terminate: result.terminate === true };
}

/** 未找到工具 / prepare / validate 失败：错误结果 + 事件（Pi L608-614 路径；end 与消息事件必发）。 */
async function immediateOutcome(
  toolCall: ToolCall,
  text: string,
  terminate: boolean,
  emit: AgentEventSink,
): Promise<ToolExecutionOutcome> {
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text,
    isError: true,
    ...(terminate ? { terminate: true } : {}),
  };
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: text }, isError: true });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return { message, terminate };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
