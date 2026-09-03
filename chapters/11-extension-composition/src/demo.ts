/**
 * 真实 API 演示：Extension Composition（零 Core 改动的工作流）。
 * 流程：加载三个案例扩展（permission-gate / plan-mode / subagent）+ 教学 bash 工具 →
 * 组装（07 Agent + 10 章 runtime 钩子 + bindToolRuntime 绑定）→ 三个工作流依次触发：
 * 1. permission-gate：bash rm -rf 被拦（官方 No permission popups 的 extension 版）
 * 2. plan-mode：/plan 开启只读 → 同一个 Agent 的工具列表立即变化（白名单命令放行、
 *    非白名单被拦）→ /plan 关闭恢复
 * 3. subagent：委托独立 agent（官方 No sub-agents 的 extension 版）
 * 收尾：用扩展组合完成三个工作流，核心循环保持不变。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import { ExtensionRunner } from "../../10-extension-runtime/src/runner.ts";
import { createExtensionAwareConfig } from "../../10-extension-runtime/src/index.ts";
import type { RuntimeConfig } from "../../10-extension-runtime/src/extension-api.ts";
import { createBashTool } from "./bash-tool.ts";
import permissionGate from "./permission-gate.ts";
import planMode from "./plan-mode.ts";
import subagent from "./subagent.ts";

/** 演示环境工具集（真实存在的工具名：内置 bash/calculator + 注册 subagent）。 */
const DEMO_TOOLS = ["bash", "calculator", "subagent"];

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  // 1. 加载三个案例扩展（全部走 10 章 runtime，零 Core 改动）
  const config: RuntimeConfig = { model, activeTools: [...DEMO_TOOLS] };
  const runner = new ExtensionRunner({ cwd: process.cwd(), config, session: new TreeSession() });
  await runner.load([permissionGate, planMode, subagent]);
  console.log("=== 三个案例扩展已加载（全部走 10 章 runtime）===");
  console.log("· 命令:", runner.getCommands().map((c) => `/${c.name}`).join(", "));

  // 2. 组装：07 Agent + 扩展钩子 + 工具运行时绑定。组装层持有完整工具宇宙；
  //    Extension 只经 ctx.setActiveTools 动作生效，永远不拿到 Agent 实例。
  const allTools: Tool[] = [createBashTool(), createCalculatorTool(), ...runner.getRegisteredTools()];
  const agent = new Agent({
    systemPrompt: "你是一个助手。可用工具：bash（执行命令）、calculator（计算）、subagent（委托子 agent）。",
    tools: [...allTools],
    llm: new AnthropicLlmAdapter(),
    config: { model, ...createExtensionAwareConfig(runner) },
  });
  runner.bindToolRuntime({
    resolve: (names) => allTools.filter((t) => names.includes(t.name)),
    apply: (tools) => {
      agent.state.tools = tools;
    },
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      console.log(`· 工具: ${event.toolName} → ${event.result.content}${event.isError ? "（被拦截）" : ""}`);
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.text) {
      console.log(`· 回复: ${event.message.text}`);
    }
  });
  console.log("· 初始工具（provider 可见）:", agent.state.tools.map((t) => (t as Tool).name).join(", "));

  // 3. 案例一：permission-gate（No permission popups → extension）
  console.log("\n=== 案例一：permission-gate（No permission popups → extension）===");
  await agent.prompt(
    "先用 bash 执行 rm -rf /tmp/learn-pi-agent-demo-remove-me（permission-gate 会拦截），然后用 bash 执行 echo hello 确认命令仍然可用。",
  );

  // 4. 案例二：plan-mode（No plan mode → extension）
  console.log("\n=== 案例二：plan-mode（No plan mode → extension）===");
  await runner.runCommand("plan");
  console.log(`· 同一 Agent 工具列表（/plan 后）: ${agent.state.tools.map((t) => (t as Tool).name).join(", ")}`);
  await agent.prompt(
    "现在是只读探索模式：先用 bash 执行 ls -la，再尝试用 bash 执行 rm -rf /tmp/learn-pi-agent-demo-remove-me（应该被 plan 模式拦截）。",
  );
  await runner.runCommand("plan");
  console.log(`· 同一 Agent 工具列表（/plan 退出后）: ${agent.state.tools.map((t) => (t as Tool).name).join(", ")}`);

  // 5. 案例三：subagent（No sub-agents → extension）
  console.log("\n=== 案例三：subagent（No sub-agents → extension）===");
  await agent.prompt(
    "把任务委托给 subagent：「调研 learn-pi-agent 项目里 chapters 目录下的章节数量并总结结构」；收到子 agent 回复后转告我。",
  );

  // 6. 结论：策略由扩展组合提供，核心循环保持不变。
  console.log("\n=== 扩展组合完成：核心循环保持不变 ===");
  console.log("三个工作流全部由 10 章 Extension Runtime 提供（on/registerTool/registerCommand/ctx.setActiveTools）。");
  console.log("循环、Agent、会话树零改动。官方 No 清单的每一项都能在 Harness 停止之后构建出来。");
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
