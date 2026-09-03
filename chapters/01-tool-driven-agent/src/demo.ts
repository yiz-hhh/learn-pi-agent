/**
 * 真实 API 演示：Tool Calling 闭环（00 基座 + 01 循环）。
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

  const messages = await agentLoop({
    model,
    systemPrompt: "你是一个计算助手，只能使用提供的工具回答问题，回答要简洁。",
    messages: [{ role: "user", text: "请计算 12 + 30 等于多少？" }],
    tools: createDemoTools(),
    llm: new AnthropicLlmAdapter(),
  });

  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          console.log(`[assistant] 请求工具: ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
      }
      if (m.text) {
        console.log(`[assistant] ${m.text}`);
      }
    } else if (m.role === "toolResult") {
      console.log(`[toolResult] ${m.toolName}: ${m.text}${m.isError ? "（错误）" : ""}`);
    } else {
      console.log(`[user] ${m.text}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
