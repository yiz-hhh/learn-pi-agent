/**
 * 真实 API 演示：Tool Runtime——工具执行流水线与 tool_execution_* 事件。
 * 输出层级：agent（==）/ turn（--）/ tool 与消息（·，缩进 4 格）。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter, createDemoTools } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  const stream = agentLoop(
    [{ role: "user", text: "请计算 12 + 30 等于多少？" }],
    { systemPrompt: "你是一个计算助手，只能使用提供的工具回答问题，回答要简洁。", messages: [], tools: createDemoTools() },
    { model },
    new AnthropicLlmAdapter(),
  );

  for await (const event of stream) {
    switch (event.type) {
      case "turn_start":
        console.log("  -- 回合开始");
        break;
      case "tool_execution_start":
        console.log(`    · 工具开始: ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool_execution_end":
        console.log(`    · 工具结束: ${event.toolName} → ${event.isError ? "（错误）" : event.result.content}`);
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "toolResult") {
          console.log(`    · toolResult: ${m.text}${m.terminate ? "（建议停止）" : ""}`);
        }
        break;
      }
      case "turn_end":
        console.log(`  -- 回合结束（toolResults: ${event.toolResults.length}）`);
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
