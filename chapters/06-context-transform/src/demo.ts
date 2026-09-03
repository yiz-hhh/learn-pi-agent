/**
 * 真实 API 演示：Context Transformation——canonical context 与 LLM view 的投影关系（核心）。
 * 旧历史保留在 canonical context 中；transformContext 只把当前任务需要的消息投影给 LLM。
 * 不依赖模型恰好产生第 2 个回合：无论模型走工具还是直接作答，投影关系都会稳定展示。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentLoopConfig, AssistantMessage, Message } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  // canonical 历史：一段与当前任务无关的旧对话（保留在 Runtime，不进入本次 LLM view）
  const oldReply: AssistantMessage = { role: "assistant", text: "昨天是晴天，24 度。", stopReason: "end_turn" };
  const oldHistory: Message[] = [
    { role: "user", text: "昨天天气怎么样？" },
    oldReply,
  ];

  const config: AgentLoopConfig = {
    model,
    // 核心：输入是完整 canonical；view 从最后一条 user 消息开始投影给 LLM。
    // 协议约束：toolResult 之前必须有对应的 assistant tool_use 块，否则真实端点 400——
    // 所以不能简单 slice(-N)，从「最后一条 user」起截取是协议安全的窗口。
    // 返回值只作为本次 LLM 请求的 messages，不自动写回 canonical
    transformContext: async (messages) => {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const view = messages.slice(lastUserIdx);
      console.log(`[transformContext] canonical=${messages.length} 条 → llmView=${view.length} 条`);
      return view;
    },
    // getApiKey：每次 LLM 调用前解析（OAuth 过期场景）；本 demo 用环境凭据，返回 undefined
    getApiKey: () => {
      console.log("[getApiKey] 每次调用前解析（本 demo 返回 undefined，使用环境凭据）");
      return undefined;
    },
    // shouldStopAfterTurn：展示回合后检查点；本 demo 不依赖它叫停（模型路径不定），仅记录调用
    shouldStopAfterTurn: async () => {
      console.log("[shouldStopAfterTurn] 回合后检查 → 不停止");
      return false;
    },
  };

  const stream = agentLoop(
    [{ role: "user", text: "请计算 12 + 30 等于多少？" }],
    { systemPrompt: "你是一个计算助手，回答要简洁。", messages: oldHistory, tools: [createCalculatorTool()] },
    config,
    new AnthropicLlmAdapter(),
  );

  for await (const event of stream) {
    switch (event.type) {
      case "tool_execution_end":
        console.log(`· 工具: ${event.toolName} → ${event.result.content}`);
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
  console.log(`本 run newMessages: ${messages.length} 条（canonical 中的 ${oldHistory.length} 条旧历史未被自动裁掉）`);
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
