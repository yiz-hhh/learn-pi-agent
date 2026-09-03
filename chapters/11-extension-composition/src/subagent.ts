/**
 * 案例三：Subagent（官方 No sub-agents 的 extension 版）。
 * Pi 锚点：examples/extensions/subagent/（index.ts 1038 行：spawn 独立 pi 进程 L346、
 * registerTool L472；agents/ planner/reviewer/scout/worker + prompts/ implement 等）。
 *
 * 官方 No 清单原话（coding-agent README L501）：
 * "No sub-agents. There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions."
 *
 * Pi 机制：每次 subagent 调用 spawn 一个独立 pi 进程（独立上下文窗口），支持
 * Single/Parallel/Chain 三种模式（L346 spawn、L472 registerTool）；child 失败（exitCode/
 * stopReason 异常）→ 父收到 isError ToolResult（L701-708）。
 * 教学子集：同一进程内用 07 章 Agent + 独立 TreeSession 模拟「另一个 agent」（独立上下文），
 * 结果回传主 agent。进程管理（spawn/tmux/JSON 模式/并行与链式）不教，只简述。
 * 教学简化：llm/systemPrompt/tools 挂到 ctx.config（Reconfigure 可扩展域）；
 * child 失败经 07 AgentState.errorMessage 检测后 throw → isError（与 Pi 语义对齐）；
 * abort 无公开 seam，只在进入与完成边界检测 signal.aborted（Pi 为子进程 SIGTERM/SIGKILL）。
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import type { ExtensionAPI } from "../../10-extension-runtime/src/extension-api.ts";

/** 子 agent 配置：挂到 ctx.config 的可扩展域（Reconfigure 能力；教学简化）。 */
export interface SubagentConfig {
  llm?: LLMAdapter;
  systemPrompt?: string;
  tools?: Tool[];
}

/** 扩展工厂：注册 subagent 委托工具。 */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    description: "把任务委托给子 agent 独立执行（独立上下文窗口），返回其最终回复",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "委托给子 agent 的任务" } },
      required: ["task"],
    },
    async execute(args, ctx, _onUpdate, signal) {
      if (signal?.aborted) throw new Error("子 agent 执行被中止");
      const task = String(args.task);
      const config = ctx.config as unknown as SubagentConfig;
      const llm = config.llm ?? new AnthropicLlmAdapter();

      // 独立会话树：子 agent 的上下文与主会话完全隔离（Pi：独立 pi 进程）
      const subSession = new TreeSession();
      const subAgent = new Agent({
        systemPrompt: config.systemPrompt ?? "你是子 agent，专注完成委托任务，回答要简洁。",
        tools: config.tools ?? [createCalculatorTool()],
        llm,
        config: { model: ctx.config.model },
      });
      subAgent.subscribe((event) => {
        if (event.type === "message_end") {
          subSession.appendMessage(event.message);
        }
      });

      await subAgent.prompt(task);
      // Pi：child exitCode/stopReason 异常 → 父收到 isError ToolResult（index.ts L701-708）。
      // 教学：07 Agent 无公开 abort seam，运行中取消不传播到子 run，
      // 只在进入与完成边界检测 signal.aborted；child 失败经 07 AgentState.errorMessage
      // 检测后 throw，走错误结果路径（00 基座 ToolResult 无 isError 字段，throw 是唯一 isError 通道）。
      if (signal?.aborted) throw new Error("子 agent 执行被中止");
      const failure = subAgent.state.errorMessage;
      if (failure) {
        throw new Error(`子 agent 执行失败: ${failure}`);
      }
      const reply = subAgent.state.messages.at(-1)?.text ?? "(无回复)";
      return {
        content: `子 agent 回复：${reply}`,
        details: { task, subMessages: subSession.getEntries().length, subLeaf: subSession.getLeafId() },
      };
    },
  });
}
