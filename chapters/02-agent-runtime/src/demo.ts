/**
 * 真实 API 演示：完整 Agent Runtime——事件流 + 流式逐字输出。
 * 输出层级：agent（==）/ turn（--）/ message（·，缩进 4 格）。
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

  const llm = new AnthropicLlmAdapter();
  const stream = agentLoop(
    [{ role: "user", text: "请计算 12 + 30 等于多少？" }],
    { systemPrompt: "你是一个计算助手，只能使用提供的工具回答问题，回答要简洁。", messages: [], tools: createDemoTools() },
    { model },
    llm,
  );

  // Pi 的消费方式：EventStream 是 AsyncIterable，for await 逐事件取（pi-ai event-stream.ts）
  for await (const event of stream) {
    switch (event.type) {
      case "agent_start":
      case "agent_end":
        console.log(`\n== ${event.type}`);
        break;
      case "turn_start":
        console.log("  -- 回合开始");
        break;
      case "message_update":
        // 真实 adapter 只对 text_delta 产出 update（工具调用轮无增量事件，到达以 toolResult 消息为准）
        if (event.message.text) {
          process.stdout.write(`\r    · ${event.message.text}`);
        }
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "user") console.log(`    · user: ${m.text}`);
        if (m.role === "toolResult") console.log(`    · toolResult: ${m.toolName}: ${m.text}${m.isError ? "（错误）" : ""}`);
        break;
      }
      case "message_end":
        if (event.message.role === "assistant" && event.message.text) console.log("");
        break;
      case "turn_end":
        console.log(`  -- 回合结束（toolResults: ${event.toolResults.length}）`);
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
