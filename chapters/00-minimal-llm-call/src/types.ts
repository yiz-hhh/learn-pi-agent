/**
 * 00 章共享基座：完整类型定义（一次到位，后续章节只做实现演进，不再改类型）。
 *
 * 对应 Pi 的 `packages/agent/src/types.ts` 与 pi-ai 基础类型：
 * - `Message`/`Tool`/`AgentContext`：Pi `AgentMessage`（types.ts L325）/`AgentTool`（L386-409）/`AgentContext`（L412-419）的简化
 * - `errorMessage`：Pi 错误消息文本字段（pi-ai L439）
 * - `StopReason`：教学五值（Pi 七值含 pending/deferred，教学裁剪）
 * - `AssistantMessageEvent`：Pi 流事件（pi-ai L535-556）简化（toolcall_delta/thinking/error 独立事件未复刻）
 * - `AgentEvent`：Pi `AgentEvent`（types.ts L428-443）子集（message_update 含流式事件引用）
 * - `AgentLoopConfig`：Pi `AgentLoopConfig`（types.ts L149-293）的 V0 子集——后续章节按需扩展此接口
 */

/** 消息角色：与 Pi 的基础 `Message` 三角色一致。 */
export type MessageRole = "user" | "assistant" | "toolResult";

/** 模型请求的工具调用块：对应 Pi 的 `AgentToolCall`（types.ts L53）。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 统一消息模型：对应 Pi 的 `AgentMessage`（types.ts L325）。 */
export interface Message {
  role: MessageRole;
  text?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** 错误文本：`stopReason === "error"` 时携带（Pi pi-ai types.ts L439）。 */
  errorMessage?: string;
  /** toolResult 专用：结构化结果细节（Pi `AgentToolResult.details`，types.ts L365）。 */
  details?: unknown;
  /** toolResult 专用：工具执行用量（Pi types.ts L366-367；不参与主上下文计费）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** toolResult 专用：提示本批工具执行后应停止（Pi types.ts L374；批终止语义）。 */
  terminate?: boolean;
  /** toolResult 专用：本结果引入、此后可用的工具名（Pi types.ts L368-369；09 章动态工具）。 */
  addedToolNames?: string[];
  /** UI 专用消息标记：convertToLlm 过滤（Pi 注释示例：Filter out UI-only messages，types.ts L170-172）。 */
  uiOnly?: boolean;
}

/** 停止原因（教学五值）。 */
export type StopReason = "end_turn" | "tool_use" | "length" | "error" | "aborted";

/** assistant 消息：`stopReason` 是循环的分支依据（02 章起显式使用）。 */
export interface AssistantMessage extends Message {
  role: "assistant";
  stopReason: StopReason;
  /**
   * 推理过程文本（块级，非流式事件）。
   * 真实端点会返回 thinking 块，Anthropic 协议要求原样回传（否则 400）——
   * 教学剪裁：不做流式 thinking 事件，但 adapter 保留并回传文本。
   */
  thinking?: string;
  /** thinking 块的签名（协议要求与文本一起回传，SDK 类型必填）。 */
  thinkingSignature?: string;
}

/**
 * LLM 流式事件（Pi `AssistantMessageEvent` 简化，pi-ai L535-556）。
 * 每个事件带 `partial`：当前完整的 assistant 消息快照（agent-loop.ts L335-343 的替换机制依赖此）。
 * - start：流开始（Pi L319-324 消费点）；注意 partial.toolCalls 此时为空数组
 *   （工具调用块在流中间才到达，start 快照不含；done 时完整，见 adapter 实现）
 * - text_* / toolcall_*：增量事件（toolcall_delta 独立事件未复刻；adapter 只对
 *   text_delta 产出事件，纯工具调用轮无增量事件，消费方以 done 快照为准）
 * - done：流完成，partial 为最终消息（error 编码进 done 的 stopReason）
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; partial: AssistantMessage }
  | { type: "toolcall_start" | "toolcall_end"; partial: AssistantMessage }
  | { type: "done"; partial: AssistantMessage };

/** 极简 JSON Schema（校验器见 validate.ts；索引签名满足 Anthropic SDK InputSchema）。 */
export interface ToolParameters {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * 工具执行结果：对应 Pi `AgentToolResult`（types.ts L361-375）。
 * 03 章起工具返回结构化结果，不再只有 content 字符串。
 */
export interface ToolResult {
  /** 回传给模型的内容（Pi `content`，types.ts L363）。 */
  content: string;
  /** 供日志/UI 的结构化数据（types.ts L365）。 */
  details?: unknown;
  /** 工具执行用量（types.ts L366-367）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 提示本批工具执行后应停止（types.ts L374；批终止语义）。 */
  terminate?: boolean;
  /** 本结果引入、此后可用的工具名（types.ts L368-369）。 */
  addedToolNames?: string[];
}

/**
 * 工具定义：对应 Pi `AgentTool`（types.ts L386-409）。
 * - `prepareArguments`：兼容层，把模型原始参数转为工具期望的格式（Pi L393-394）
 * - `execute`：失败抛异常；`onUpdate` 为 partial 更新回调；`signal` 为中止信号
 *   （Pi L395-400：execute(toolCallId, params, signal, onUpdate)；教学剪裁 toolCallId，signal 保留）
 * - `executionMode`：单工具执行模式覆盖（Pi L402-408；04 章使用）
 */
export interface Tool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ToolParameters;
  prepareArguments?: (args: unknown) => TArgs;
  execute(args: TArgs, onUpdate?: (partial: ToolResult) => void, signal?: AbortSignal): Promise<ToolResult>;
  executionMode?: "sequential" | "parallel";
}

/** 循环输入上下文：对应 Pi `AgentContext`（types.ts L412-419）。 */
export interface AgentContext {
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
}

/** `beforeToolCall` 的返回：可阻止执行（Pi `BeforeToolCallResult`，types.ts L61-69）。 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /** 阻止时也参与批终止判定。 */
  terminate?: boolean;
}

/** `beforeToolCall` 的输入（Pi types.ts L98-107）。 */
export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  context: AgentContext;
}

/** `afterToolCall` 的返回：字段级改写（Pi `AfterToolCallResult`，types.ts L84-95，不做深合并）。 */
export interface AfterToolCallResult {
  content?: string;
  details?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  terminate?: boolean;
  addedToolNames?: string[];
  isError?: boolean;
}

/** `afterToolCall` 的输入（Pi types.ts L110-123）。 */
export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  result: ToolResult;
  isError: boolean;
  context: AgentContext;
}

/** 工具执行模式：Pi `ToolExecutionMode`（types.ts L37-42）。默认 "parallel"。 */
export type ToolExecutionMode = "sequential" | "parallel";

/** `prepareNextTurn` 的返回：替换下一轮的 context/model/thinkingLevel（Pi `AgentLoopTurnUpdate`，types.ts L138-145）。 */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: string;
}

/**
 * 循环配置：Pi `AgentLoopConfig`（types.ts L149-293）子集。
 * 类型面集中声明于此；对应运行时机制在后续章节逐步实现
 * （transformContext/prepareNextTurn/shouldStopAfterTurn/getApiKey → 06 章）。
 */
export interface AgentLoopConfig {
  model: string;
  /** 工具执行前钩子：可 block（Pi L619-647）。 */
  beforeToolCall?: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
  /** 工具执行后钩子：字段级改写结果（Pi L724-751）。 */
  afterToolCall?: (context: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
  /** 工具批次执行模式：默认并行（Pi types.ts L266-268；分流判定 L411-426）。 */
  toolExecution?: ToolExecutionMode;
  /**
   * 运行中注入（steering）：每个回合结束后取一次（Pi L259，初始取点 L167）。
   * 返回的消息在下一个 LLM 调用前进入历史（L182-190）——「当前工作流内的打断」。
   * 契约（Pi types.ts L242-243/L255-256）：无消息必须返回 []，不得返回 undefined 或抛错——
   * 否则内层循环条件（pendingMessages.length > 0）永不满足会死循环。
   */
  getSteeringMessages?: () => Promise<Message[]>;
  /**
   * 停止后注入（follow-up）：内层循环退出（无工具、无 steering）后取一次（Pi L263-268）。
   * 非空则回到外层循环继续——「当前工作流结束后的新开始」。
   * 契约同 steering：无消息返回 []。
   */
  getFollowUpMessages?: () => Promise<Message[]>;
  /**
   * LLM 调用前的上下文变换（Pi L289-292）：AgentMessage[] → AgentMessage[]。
   * 用于上下文窗口管理（裁剪旧消息）、注入外部资料（types.ts L180-200）。
   * 发生在 convertToLlm 之前，变换的是内部消息（Context as a Hook）。
   */
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;
  /**
   * 每次 LLM 调用前动态解析 API key（Pi L304-306，OAuth 过期场景 types.ts L202-210）。
   * 未设置时返回 undefined。
   */
  getApiKey?: () => Promise<string | undefined> | string | undefined;
  /**
   * turn_end 后调用：返回替换的 context/model 用于下一轮（Pi L232-245 + types.ts L138-145）。
   * 返回 undefined 则沿用当前。
   */
  prepareNextTurn?: (context: { message: AssistantMessage; toolResults: Message[]; context: AgentContext; newMessages: Message[] }) => Promise<AgentLoopTurnUpdate | undefined>;
  /**
   * turn_end 后调用：返回 true 则优雅停止（Pi L247-257，如 context 将满 types.ts L218）。
   * 与终止①（error 立即停）不同：当前回合的工具结果已正常落盘。
   */
  shouldStopAfterTurn?: (context: { message: AssistantMessage; toolResults: Message[]; context: AgentContext; newMessages: Message[] }) => boolean | Promise<boolean>;
  /**
   * 动态工具加载：工具结果带 addedToolNames 时调用，把新工具加入后续轮次的 context.tools
   * （Pi ToolResultMessage 注释：Names from Context.tools that became available after this result）。
   */
  loadTools?: (names: string[]) => Tool[];
}

/**
 * 事件模型：Pi `AgentEvent`（types.ts L428-443）全部四类。
 * 03 章补全 `tool_execution_*`（工具执行生命周期，L441-450/L767-775）。
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: Message; toolResults: Message[] }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: Message; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: ToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean };
