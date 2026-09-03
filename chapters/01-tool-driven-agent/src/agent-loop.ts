/**
 * 01 章增量：Tool Calling——在 00 基座上实现最小 Agent Loop。
 *
 * 全链路流式（Pi 形状）：LLM 接口恒为事件流（00 基座），本章**只关心最终结果**——
 * 消费流事件但忽略增量（start/delta 跳过，done 取快照）；03 章才开始消费增量。
 *
 * 对应 Pi 的 `runLoop`（agent-loop.ts L155-275）内层循环，剪裁清单：
 * - 事件模型（AgentEvent）→ 02 章
 * - 终止① error/aborted、newMessages 语义、截断保护 → 02 章
 * - steering/follow-up、并行、hooks → 06/05/04 章
 * - AbortSignal 透传（loop 不接收 signal）→ 02 章
 *
 * 本章返回**完整历史**（context.messages 拷贝）——Pi 返回本轮新增 newMessages（L103），
 * 该语义在 02 章引入（「返回值该给什么」是 02 章的教学点）。
 */
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AssistantMessage, Message, Tool, ToolCall } from "../../00-minimal-llm-call/src/index.ts";

/** agent_loop 入口参数。 */
export interface AgentLoopOptions {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  llm: LLMAdapter;
}

/**
 * 最小 agent loop：LLM 与工具交替直到模型不再请求工具。
 * 返回完整会话历史（newMessages 语义推迟到 02 章）。
 */
export async function agentLoop({ model, systemPrompt, messages, tools, llm }: AgentLoopOptions): Promise<Message[]> {
  const context: AgentContext = { systemPrompt, messages: [...messages], tools };

  let hasMoreToolCalls = true;
  while (hasMoreToolCalls) {
    // 流式接口消费：只取 done 快照（Pi streamAssistantResponse L317-361 的简化——03 章开始处理增量）
    let assistantMessage: AssistantMessage | null = null;
    for await (const event of llm.complete(
      { model, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools ?? [] },
    )) {
      if (event.type === "done") {
        assistantMessage = event.partial;
        break;
      }
    }
    // 教学守卫：00 基座 adapter 恒以 done 收尾，此分支实际不可达（Pi 无此守卫，靠 response.result() 收尾）
    if (!assistantMessage) {
      throw new Error("LLM stream ended without a done event");
    }
    context.messages.push(assistantMessage);

    const toolCalls = assistantMessage.toolCalls ?? [];
    hasMoreToolCalls = false;

    if (toolCalls.length > 0) {
      // 串行执行（hooks/校验在 03 章；并行在 04 章）
      for (const toolCall of toolCalls) {
        context.messages.push(await executeToolCall(context, toolCall));
      }
      hasMoreToolCalls = true;
    }
  }

  return context.messages;
}

/**
 * 执行单个工具调用并构造 toolResult 消息。
 * 对应 Pi `prepareToolCall`（L600-668，L607 查找 / L608-614 未找到）
 * + `executePreparedToolCall`（L670-711，L701-707 异常转错误结果）
 * + `createToolResultMessage`（L777-791）。
 */
async function executeToolCall(context: AgentContext, toolCall: ToolCall): Promise<Message> {
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Tool ${toolCall.name} not found`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(toolCall.arguments);
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: result.content ?? "",  // Pi createToolResultMessage L782-784：content ?? []，null 不进历史/provider
      isError: false,
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}
