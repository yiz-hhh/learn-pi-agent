/**
 * 07 章核心：最小 Agent 封装（Reduce it——精读 Pi `Agent` class（agent.ts L173）后的最小复刻）。
 *
 * 复刻的设计（全部锚定 Pi）：
 * - `subscribe`（L250）：事件订阅，返回退订函数
 * - `state` getter（L260，JSDoc 起 L255）：公开 AgentState（messages/isStreaming/streamingMessage/pendingToolCalls/errorMessage）
 * - `processEvents`（L540-580）：事件 → 状态机的唯一入口
 *   message_start/update → streamingMessage；message_end → streamingMessage=undefined + messages.push
 *   tool_execution_start/end → pendingToolCalls 增减；turn_end + errorMessage → errorMessage；agent_end → streamingMessage=undefined
 * - `prompt`（L350-356）：并发保护（activeRun 检查）+ runAgentLoop 接线
 * - `continue`（L361-410）：末条必须是 user/toolResult（Pi L74-76 语义）
 *
 * 剪裁（教学简化）：steering/followUp 队列与 QueueMode、abort/waitForIdle、thinkingLevel 替换。
 * session 持久化见 session.ts（对应 Pi harness/session 的 JsonlSessionRepo 最小版）。
 */
import { runAgentLoop, runAgentLoopContinue, type AgentEventSink } from "./agent-loop.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, Message } from "../../00-minimal-llm-call/src/index.ts";

/** 公开状态：Pi `AgentState`（types.ts L333-358）的教学子集。 */
export interface AgentState {
  systemPrompt: string;
  model: string;
  tools: unknown[];
  messages: Message[];
  isStreaming: boolean;
  streamingMessage?: Message;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

/** Agent 构造选项。 */
export interface AgentOptions {
  systemPrompt: string;
  tools: unknown[];
  llm: LLMAdapter;
  config: AgentLoopConfig;
  /** 会话初始消息（如从 session 恢复）。 */
  initialMessages?: Message[];
}

export class Agent {
  private listeners = new Set<AgentEventSink>();
  private _state: AgentState;  // Pi 同款：字段下划线，state 为 getter（agent.ts L260）
  private llm: LLMAdapter;
  private config: AgentLoopConfig;
  private activeRun: Promise<Message[]> | null = null;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this._state = {
      systemPrompt: options.systemPrompt,
      model: options.config.model,
      tools: [...options.tools],
      messages: [...(options.initialMessages ?? [])],
      isStreaming: false,
      pendingToolCalls: new Set<string>(),
    };
  }

  /** 订阅事件（Pi L250-253）；返回退订函数。 */
  subscribe(listener: AgentEventSink): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 公开状态（Pi L260，getter 本体；JSDoc 起 L255）。 */
  get state(): AgentState {
    return this._state;
  }

  /** 发起一次 prompt（Pi L350-356：并发保护 + runAgentLoop 接线）。 */
  async prompt(input: string | Message): Promise<Message[]> {
    if (this.activeRun) {
      throw new Error("Agent 正在处理中，请等待完成（Pi：Already processing a prompt）");
    }
    const message: Message = typeof input === "string" ? { role: "user", text: input } : input;

    const run = this.runWithLifecycle((emit) =>
      runAgentLoop([message], this.createContext(), this.config, this.llm, emit),
    );
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }

  /** 从当前会话继续（Pi L361-410：末条必须是 user/toolResult，否则抛错）。 */
  async continue(): Promise<Message[]> {
    if (this.activeRun) {
      throw new Error("Agent 正在处理中，请等待完成");
    }
    const last = this._state.messages[this._state.messages.length - 1];
    if (!last) {
      throw new Error("无消息可继续（Pi：No messages to continue from）");
    }
    if (last.role === "assistant") {
      throw new Error("不能从 assistant 消息继续（Pi：Cannot continue from message role: assistant）");
    }

    const run = this.runWithLifecycle((emit) =>
      runAgentLoopContinue(this.createContext(), this.config, this.llm, emit),
    );
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }

  /** 状态 → 循环输入上下文（Pi `createContextSnapshot`）。 */
  private createContext(): AgentContext {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: [...this._state.messages],
      tools: this._state.tools as never,
    };
  }

  /** 运行生命周期：事件 → processEvents + 订阅者；isStreaming 由 run 边界控制。 */
  private async runWithLifecycle(
    start: (emit: AgentEventSink) => Promise<Message[]>,
  ): Promise<Message[]> {
    this._state.isStreaming = true;
    // 每次 run 开始时清理上一轮的运行时状态（errorMessage 泄漏、幽灵 pendingToolCalls）
    this._state.errorMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    try {
      return await start(async (event: AgentEvent) => {
        await this.processEvents(event);
        for (const listener of this.listeners) {
          await listener(event);
        }
      });
    } catch (error) {
      // Pi handleRunFailure（agent.ts L512-526）：异常不静默吞掉也不外抛，
      // 失败消息入历史 + errorMessage 设置（错误可观测、末条 assistant 使 continue 约束生效）
      await this.handleRunFailure(error);
      return [];
    } finally {
      this._state.isStreaming = false;
      this._state.streamingMessage = undefined;
      // Pi finishRun（L528-536）：finally 清空 pendingToolCalls（run 异常击穿后无幽灵残留）
      this._state.pendingToolCalls = new Set<string>();
    }
  }

  /** 运行失败 → 失败消息 + 事件（Pi handleRunFailure L512-526；直接走 processEvents，不经 listeners）。 */
  private async handleRunFailure(error: unknown): Promise<void> {
    const failureMessage: AssistantMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  /**
   * 事件 → 状态机（Pi L540-580 精简）。
   * 唯一入口：所有状态变化都在这里发生，外部只能读 state。
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this._state.streamingMessage = event.message;
        break;

      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pending = new Set(this._state.pendingToolCalls);
        pending.add(event.toolCallId);
        this._state.pendingToolCalls = pending;
        break;
      }

      case "tool_execution_end": {
        const pending = new Set(this._state.pendingToolCalls);
        pending.delete(event.toolCallId);
        this._state.pendingToolCalls = pending;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._state.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._state.streamingMessage = undefined;
        break;
    }
  }
}
