/**
 * 10 章核心：ExtensionAPI 教学子集（Reduce it，精读 Pi coding-agent extensions/types.ts）。
 *
 * Pi 的 ExtensionAPI（types.ts L1237-1261 起）有 70+ API：on() 约 35 个事件、registerTool、
 * registerCommand/registerShortcut/registerFlag、registerProvider、getCommands、UI 域等。
 * 教学只取六类能力的最小骨架（全部锚定 Pi）：
 *
 * | 能力 | Pi 锚点 | 教学子集 |
 * |---|---|---|
 * | Observe（订阅） | on() 事件族 L1237-1261 | on("message_end"/"turn_end") |
 * | Intercept（拦截） | on("tool_call") → ToolCallEventResult | on("tool_call") → { block, reason } |
 * | Extend（扩展） | registerTool（ToolDefinition 类型 L449、方法签名 L1286）/ registerCommand L1295 | 同左 |
 * | Reconfigure（配置） | ExtensionAPI 配置域（setActiveTools L1384） | ctx.getActiveTools/setActiveTools 动作（bindToolRuntime 写 running Agent；config.activeTools 为同步数据） |
 * | Inject（注入） | on("context") → ContextEventResult；sdk.ts transformContext → emitContext | on("context") → 返回 Message[] |
 * | Persist（持久化） | ctx.sessionManager + appendCustomEntry | ctx.session（07 章 TreeSession） |
 *
 * 教学简化：事件 35+ → 4、ExtensionMode 多模式 → "cli"、
 * registerProvider/UI 域（theme/keybindings/statusline）/getArgumentCompletions 不教。
 */
import type { AssistantMessage, Message, Tool, ToolCall, ToolParameters, ToolResult } from "../../00-minimal-llm-call/src/index.ts";
import type { TreeSession } from "../../07-session-tree/src/session-tree.ts";

/** 事件集合：Pi on() 事件族（types.ts L1237-1261）的教学子集。 */
export interface ExtensionEvents {
  /** Intercept：工具调用前（Pi ToolCallEvent，L932 emitToolCall）。 */
  tool_call: { assistantMessage: AssistantMessage; toolCall: ToolCall; args: unknown };
  /** Inject：LLM 调用前的上下文变换（Pi ContextEvent + sdk.ts L362-367 emitContext）。 */
  context: { messages: Message[] };
  /** Observe：单条消息结束（Pi MessageEndEvent）。 */
  message_end: { message: Message };
  /** Observe：回合结束（Pi TurnEndEvent）。 */
  turn_end: { message: Message; toolResults: Message[] };
}

/** tool_call 事件的返回：拦截语义（Pi ToolCallEventResult 教学子集：block/reason）。 */
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

/** context 事件的返回：注入后的消息（Pi ContextEventResult 教学简化：返回 Message[] 或不返回）。 */
export type ContextEventResult = Message[] | void;

/** 事件处理函数：Pi ExtensionHandler（types.ts L1225-1227，event + ctx）。 */
export type ExtensionHandler<K extends keyof ExtensionEvents> = (
  event: ExtensionEvents[K],
  ctx: ExtensionContext,
) => unknown;

/**
 * 工具运行时绑定：组装层（demo/测试）把「名字 → Tool」的解析与「写入 running Agent」交给 runner
 * （Pi bindCore 的 setActiveTools 动作，agent-session.ts L2583 → setActiveToolsByName L950-972）。
 * invariant：Extension 只调用 ctx.setActiveTools 动作，永远不拿到 Agent 实例。
 */
export interface ToolRuntimeBinding {
  /** 按名字解析为 Tool（组装层持有完整工具宇宙：内置工具 + 扩展注册表）；未知名忽略。 */
  resolve(toolNames: string[]): Tool[];
  /** 把解析结果立即写入 running Agent 的 state.tools（下一次 provider call 可见）。 */
  apply(tools: Tool[]): void;
}

/** 扩展上下文：Pi ExtensionContext（types.ts L310 起；L307-309 是 ExtensionMode）教学子集。 */
export interface ExtensionContext {
  /** 当前工作目录（Pi ctx.cwd）。 */
  cwd: string;
  /** 运行模式（Pi ExtensionMode L307 多模式，教学只教 "cli"）。 */
  mode: "cli";
  /** Reconfigure 最小域：运行配置（activeTools 为动作同步的数据，切换必须走 setActiveTools）。 */
  config: RuntimeConfig;
  /** Persist 最小域：07 章会话树（Pi ctx.sessionManager 只读访问的教学简化）。 */
  session: TreeSession;
  /** Reconfigure 动作：当前活跃工具名（Pi ExtensionAPI getActiveTools L1378）。 */
  getActiveTools(): string[];
  /**
   * Reconfigure 动作：切换活跃工具集（Pi ExtensionAPI setActiveTools L1384 →
   * setActiveToolsByName：按名解析、未知名忽略、立即写 agent.state.tools、同步 config.activeTools。
   * Pi 附带 system prompt 重建，教学不教）。
   */
  setActiveTools(toolNames: string[]): void;
}

/** 最小运行配置（Reconfigure 能力）。 */
export interface RuntimeConfig {
  /** 当前模型。 */
  model: string;
  /**
   * 当前对模型可见的工具名（查询接口：组装层初始声明，setActiveTools 动作同步写回；
   * 扩展不得直接 mutation——切换必须走 ctx.setActiveTools）。
   */
  activeTools: string[];
}

/** 扩展工具：Pi ToolDefinition.execute(..., ctx)（types.ts L449 起 ToolDefinition 类型）教学简化，ctx 由 wrapper 注入。 */
export interface ExtensionTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(
    args: Record<string, unknown>,
    ctx: ExtensionContext,
    onUpdate?: (partial: ToolResult) => void,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

/** 注册的命令：Pi RegisteredCommand（L1295 registerCommand）教学子集。 */
export interface RegisteredCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

/** 扩展工厂：default export 收 ExtensionAPI（Pi loader：模块 default export 即扩展入口）。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** 扩展 API：传给扩展工厂的界面（Pi ExtensionAPI 教学子集）。 */
export interface ExtensionAPI {
  /** 订阅事件（Observe / Intercept / Inject 的统一入口）。 */
  on<K extends keyof ExtensionEvents>(event: K, handler: ExtensionHandler<K>): void;
  /** 注册工具（Extend）：LLM 可调用的工具，wrapper 注入 ctx。 */
  registerTool(tool: ExtensionTool): void;
  /** 注册命令（Extend）：用户命令。 */
  registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void;
}
