/**
 * 00 章演示：一次 LLM 调用（全链路流式接口的第一次使用）。
 * 消费流事件但只关心最终结果——后续章节（01 起）在此基础上加循环。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter } from "./llm.ts";
import { createDemoTools } from "./tools.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  const llm = new AnthropicLlmAdapter();
  let finalText = "";

  for await (const event of llm.complete(
    {
      model,
      systemPrompt: "你是一个简洁的助手。",
      messages: [{ role: "user", text: "用一句话介绍你自己" }],
      tools: createDemoTools(),
    },
  )) {
    if (event.type === "text_delta") {
      process.stdout.write(`\r· ${event.partial.text}`);
    }
    if (event.type === "done") {
      finalText = event.partial.text ?? "";
    }
  }

  console.log(`\n=== 最终回复: ${finalText}`);
  console.log("（00 章：一次请求 → 一次响应；01 章起在此基础上加循环）");
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
