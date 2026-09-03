/**
 * 10 章接线：把 ExtensionRunner 接入 Core 的 moments（Pi 桥接的教学版）。
 *
 * Pi 的桥接分两处：sdk.ts 把 transformContext → emitContext（L362-367）；
 * agent-session.ts `_installAgentToolHooks`（L486-522）把 beforeToolCall → emitToolCall（L487-494）、
 * afterToolCall → emitToolResult（L508-511）接上；AgentSession 把 agent 事件转发给 runner（Observe）。
 * 教学版只接三个钩子：
 *
 * - beforeToolCall → emitToolCall（Intercept：block 即拦截，批终止语义由 03 章处理）
 * - transformContext → emitContext（Inject：扩展可改写发给模型的上下文）
 * - loadTools → 从 runner 的注册表动态加载（addedToolNames 协议字段由 wrapper 声明；
 *   07 章 loop 基线不消费该字段）
 *
 * Observe（事件转发）在 demo/测试中经 agent.subscribe 手动接（Pi 也是组装层做的）。
 */
import type { AgentLoopConfig } from "../../00-minimal-llm-call/src/index.ts";
import type { ExtensionRunner } from "./runner.ts";

/** 扩展感知的循环配置（返回的钩子可直接放进 AgentLoopConfig）。 */
export function createExtensionAwareConfig(runner: ExtensionRunner): {
  beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
  transformContext: NonNullable<AgentLoopConfig["transformContext"]>;
  loadTools: NonNullable<AgentLoopConfig["loadTools"]>;
} {
  return {
    beforeToolCall: async (ctx) => {
      const verdict = await runner.emitToolCall({
        assistantMessage: ctx.assistantMessage,
        toolCall: ctx.toolCall,
        args: ctx.args,
      });
      return verdict?.block ? { block: true, reason: verdict.reason } : undefined;
    },
    transformContext: async (messages) => runner.emitContext(messages),
    loadTools: (names) => runner.getRegisteredTools().filter((t) => names.includes(t.name)),
  };
}

/** 事件转发：Agent 事件 → runner（Observe 能力；Pi AgentSession._handleAgentEvent 的教学版）。 */
export function forwardAgentEvents(runner: ExtensionRunner): (event: { type: string; [key: string]: unknown }) => void {
  return (event) => {
    switch (event.type) {
      case "message_end":
        void runner.emit("message_end", { message: event.message as never });
        break;
      case "turn_end":
        void runner.emit("turn_end", { message: event.message as never, toolResults: event.toolResults as never });
        break;
      default:
        break;
    }
  };
}
