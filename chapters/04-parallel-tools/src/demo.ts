/**
 * 真实 API 演示：Parallel Tool Execution——两阶段并行与事件双顺序。
 * 输出层级：agent（==）/ turn（--）/ tool（·，缩进 4 格）/ toolResult 消息（缩进 6 格）。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

/** 慢工具：演示并发（延迟 800ms，与快工具并行时总耗时约等于最慢者）。 */
function slowTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `${delayMs}ms 后完成`,
    parameters: { type: "object", properties: {} },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: `${name} 完成（${delayMs}ms）` };
    },
  };
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  const stream = agentLoop(
    [
      {
        role: "user",
        text: "请依次执行三个任务：1) 计算 12+30；2) 回显「并行」；3) 用 slow 工具（它会延迟）。然后总结结果。",
      },
    ],
    {
      systemPrompt: "你是一个计算助手，回答要简洁。",
      messages: [],
      tools: [createEchoTool(), createCalculatorTool(), slowTool("slow", 800)],
    },
    { model },
    new AnthropicLlmAdapter(),
  );

  const startTime = Date.now();
  let sawMultiToolBatch = false; // 是否有任何一轮出现 >1 个工具调用（并行批次）
  for await (const event of stream) {
    switch (event.type) {
      case "turn_start":
        console.log("  -- 回合开始");
        break;
      case "tool_execution_start":
        console.log(`    · 开始: ${event.toolName}`);
        break;
      case "tool_execution_end":
        console.log(`    · 结束: ${event.toolName} → ${event.isError ? "（错误）" : event.result.content}（+${Date.now() - startTime}ms）`);
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "toolResult") {
          console.log(`      · toolResult 消息: ${m.toolName}`);
        }
        break;
      }
      case "turn_end":
        if (event.toolResults.length > 1) {
          sawMultiToolBatch = true;
        }
        console.log(`  -- 回合结束（toolResults: ${event.toolResults.length}）`);
        break;
      case "agent_end":
        console.log("\n== agent_end");
        break;
      default:
        break;
    }
  }

  const messages = await stream.result();
  console.log(`\n=== 最终回复: ${messages.at(-1)?.text ?? "(无)"}`);
  console.log(`总耗时: ${Date.now() - startTime}ms`);
  // 只有真实出现 multi-tool batch 时才给出并行说明；双顺序的稳定证据由测试提供
  if (sawMultiToolBatch) {
    console.log("本轮出现了并行批次：总耗时应接近最慢工具而非累加（双顺序见测试）。");
  } else {
    console.log("本次模型未在同一轮生成多个工具调用，未触发并行批次（双顺序由测试锁定）。");
  }
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
