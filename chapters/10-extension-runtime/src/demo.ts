/**
 * 真实 API 演示：Extension Runtime。
 * 流程：加载 extensions/ 目录四个扩展 → 打印注册的工具/命令 → 组装（07 Agent + TreeSession
 * + createExtensionAwareConfig + 事件转发）→ 模型使用 hello/todo 工具、delete_file 被 guard
 * 拦截 → /todos 命令查看待办。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { fileURLToPath } from "node:url";
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import { ExtensionRunner } from "./runner.ts";
import { loadExtensionsFromDir } from "./loader.ts";
import { createExtensionAwareConfig, forwardAgentEvents } from "./index.ts";

const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  // 1. 加载扩展（loader：目录发现 + default export 工厂）
  const factories = await loadExtensionsFromDir(EXTENSIONS_DIR);
  const runner = new ExtensionRunner({
    cwd: process.cwd(),
    config: { model, activeTools: [] },
    session: new TreeSession(),
  });
  await runner.load(factories);

  // 2. 激活全部注册工具（Reconfigure 动作：ctx.setActiveTools，与 11 章 plan-mode 同一 seam）
  const ctx = runner.createContext();
  ctx.setActiveTools(runner.getRegisteredTools().map((t) => t.name));

  console.log("=== 扩展加载完成 ===");
  console.log("· 工具:", runner.getVisibleTools().map((t) => t.name).join(", "));
  console.log("· 命令:", runner.getCommands().map((c) => `/${c.name}`).join(", "));
  console.log(`· tool_call 拦截已注册: ${runner.hasHandlers("tool_call")}`);

  // 3. 组装：07 Agent + 扩展钩子（beforeToolCall → Intercept、transformContext → Inject、loadTools 联动）
  //    + 事件转发（Observe）+ 消息写会话树（Persist 的落点）
  const agent = new Agent({
    systemPrompt: "你是一个助手。可用工具：calculator（计算）、hello（问候）、todo（待办）、delete_file（删除文件）。",
    tools: [createCalculatorTool(), ...runner.getVisibleTools()],
    llm: new AnthropicLlmAdapter(),
    config: { model, ...createExtensionAwareConfig(runner) },
  });
  agent.subscribe(forwardAgentEvents(runner));
  agent.subscribe((event) => {
    if (event.type === "message_end") {
      ctx.session.appendMessage(event.message);
    }
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      const tag = event.isError ? "（被拦截）" : "";
      console.log(`· 工具: ${event.toolName} → ${event.result.content}${tag}`);
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.text) {
      console.log(`· 回复: ${event.message.text}`);
    }
  });

  console.log("\n=== 运行（hello + todo + delete_file 被拦）===");
  await agent.prompt(
    "先用 hello 工具问候 Alice，然后用 todo 工具添加两条待办：写代码 review、修复 bug，最后尝试用 delete_file 删除 /tmp/learn-pi-agent-demo-remove-me.txt。",
  );

  // 4. 命令演示：/todos 查看当前分支的待办（Persist：状态从会话树推导）
  console.log("\n=== /todos 命令（状态从会话树分支推导）===");
  await runner.runCommand("todos", ctx);
  console.log(`会话树 leaf: ${ctx.session.getLeafId()}`);
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
