/**
 * 真实 API 演示：Skills & Extensions，三种扩展形态的组合。
 * 流程：技能目录进系统提示词（content 不在其中）→ 模型按需读取技能文件（read_skill）
 * → 按技能指令执行 → 工具结果 addedToolNames 动态解锁 echo 工具，模型后续轮次使用。
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { fileURLToPath } from "node:url";
import { AnthropicLlmAdapter, createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { createToolRegistry, formatSkillsForSystemPrompt, loadSkillFromFile, readSkillContent } from "./extensions.ts";

/** 技能文件：content 只存在这里，不进系统提示词（Pi：技能是文件）。 */
const SKILL_FILE = fileURLToPath(new URL("../skills/calc.md", import.meta.url));

/** 动态工具：解锁 echo。 */
function unlockTool(): Tool {
  return {
    name: "unlock_echo",
    description: "解锁 echo 工具（解锁后可用）",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "echo 已解锁", addedToolNames: ["echo"] };
    },
  };
}

/** 按需读取工具：模型匹配技能描述后调用，返回技能文件完整指令（Pi：模型用 read 工具读技能文件）。 */
function readSkillTool(): Tool {
  return {
    name: "read_skill",
    description: "读取技能文件（参数为技能目录中的 location）",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "技能文件路径" } },
      required: ["path"],
    },
    async execute(args: { path: string }) {
      return { content: readSkillContent(args.path) };
    },
  };
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  const llm = new AnthropicLlmAdapter();
  const registry = createToolRegistry([createEchoTool()]);

  // 技能目录进系统提示词（Pi formatSkillsForSystemPrompt：只列 name/description/location）
  const calcSkill = loadSkillFromFile(SKILL_FILE, "calc", "处理算术计算");
  const skillsBlock = formatSkillsForSystemPrompt([calcSkill]);
  const systemPrompt = `你是一个计算助手。\n${skillsBlock}`;

  console.log("=== 系统提示词（技能目录，content 不在其中）===");
  console.log(skillsBlock + "\n");

  const messages = await runAgentLoop(
    [
      {
        role: "user",
        text: "先用 unlock_echo 解锁 echo，然后回显「你好」，再计算 12 + 30。计算前请先读取 calc 技能文件。",
      },
    ],
    { systemPrompt, messages: [], tools: [createCalculatorTool(), unlockTool(), readSkillTool()] },
    {
      model,
      loadTools: (names) => registry.load(names),
    },
    llm,
    (event) => {
      if (event.type === "tool_execution_end") {
        const tag = event.result.addedToolNames?.length ? `（解锁了 ${event.result.addedToolNames.join(",")}）` : "";
        console.log(`· 工具: ${event.toolName} → ${event.result.content}${tag}`);
      }
    },
  );

  console.log(`\n=== 最终回复: ${messages.at(-1)?.text ?? "(无)"}`);
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
