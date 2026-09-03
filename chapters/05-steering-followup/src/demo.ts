/**
 * 真实 API 演示：Steering & Follow-up——双层循环。
 * steering 与 follow-up 由脚本化提供者模拟（config 钩子，Pi 的机制就是钩子）。
 * steering 在第 2 次轮询返回（初始取点为空 → 第 1 个回合完整结束后取到）——
 * 展示的是「运行中到达、回合之间生效」的 steering，而非运行前已排队的消息。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentLoopConfig } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  let steeringCalls = 0;
  let followUpCalls = 0;
  const config: AgentLoopConfig = {
    model,
    // 模拟用户在 agent 执行中发来消息（运行中注入）。
    // 第 1 次是初始取点（run 开始前，无消息）；第 2 次在首个回合完整结束后取到——
    // 消息在下一回合开头注入（回合之间生效，不打断当前回合的工具执行）。
    // 契约：无消息时必须返回 []（Pi types.ts L242-243），否则内层循环不停
    getSteeringMessages: async () => {
      steeringCalls++;
      if (steeringCalls === 2) {
        console.log("\n[steering] 首个回合结束后，用户发来: 「顺便回显 hello」（下一回合生效）");
        return [{ role: "user", text: "顺便把 hello 回显给我" }];
      }
      return [];
    },
    // 模拟 agent 即将退出时用户补发任务（停止后注入）。
    // 契约：同样有界（Pi types.ts L255-256），否则外层循环不停
    getFollowUpMessages: async () => {
      followUpCalls++;
      if (followUpCalls === 1) {
        console.log("\n[follow-up] agent 即将退出，用户补发: 「再算 100-40」");
        return [{ role: "user", text: "再算一下 100 减 40 等于多少" }];
      }
      return [];
    },
  };

  const stream = agentLoop(
    [{ role: "user", text: "请计算 12 + 30 等于多少？" }],
    { systemPrompt: "你是一个计算助手，回答要简洁。", messages: [], tools: [createEchoTool(), createCalculatorTool()] },
    config,
    new AnthropicLlmAdapter(),
  );

  for await (const event of stream) {
    switch (event.type) {
      case "turn_start":
        console.log("-- 回合开始");
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "user") console.log(`· user: ${m.text}`);
        break;
      }
      case "tool_execution_end":
        console.log(`· 工具: ${event.toolName} → ${event.result.content}`);
        break;
      case "turn_end":
        console.log(`-- 回合结束`);
        break;
      case "agent_end":
        console.log("== agent_end");
        break;
      default:
        break;
    }
  }

  const messages = await stream.result();
  console.log(`\n=== 最终回复: ${messages.at(-1)?.text ?? "(无)"}`);
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
