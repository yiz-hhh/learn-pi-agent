/**
 * 12 章真实端点演示：把 00-11 组装成能跑的 Coding Agent，追踪一个真实编码请求穿过完整系统。
 *
 * 流程：
 *  1. 复制 fixture 临时项目（src/calculator.ts 含故意 bug + tests/ + skills/）
 *  2. 组装（07 Agent + 09 技能 + 10 扩展 runtime + 11 permission-gate + 产品工具集；08 压缩可选）
 *  3. 请求一：修复 calculator.ts 的 bug，运行测试确认修复结果
 *     （Skill 按需加载 → read/grep 定位 → edit 修复 → bash npm test → 失败重试 → 最终回复）
 *  4. 请求二：bash rm -rf 删除依赖目录 → 被 permission-gate 扩展拦截（真实产品链路）
 *  5. 会话持久化（07 树）：保存 → 从会话文件恢复 → 继续对话
 *
 * 前置条件：可用的 LLM API 凭据；模型经环境变量 CLAUDE_MODEL 指定。
 * 运行：npm run demo
 */
import { join } from "node:path";
import { AnthropicLlmAdapter } from "../../00-minimal-llm-call/src/index.ts";
import permissionGate from "../../11-extension-composition/src/permission-gate.ts";
import { createCodingAgent } from "./assembly.ts";
import { loadSkillFromFile } from "./extensions.ts";
import { copyFixtureToTemp } from "./fixture.ts";

/** 组装层轨迹（12 章核心教学产物：每层对应 Pi 位置与章节）。 */
function assemblyLayer(name: string, pi: string, chapter: string): void {
  console.log(`[组装] ${name}`);
  console.log(`        Pi: ${pi} / learn-pi-agent: ${chapter}`);
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("请设置 CLAUDE_MODEL 环境变量指定要使用的模型");
  }

  // 1. 临时项目（fixture 复制品，修改不污染仓库）
  const projectDir = copyFixtureToTemp();
  const sessionFile = join(projectDir, ".lpia-session.jsonl");
  console.log("=== learn-pi-agent Chapter 12：真编码工具集与组装（真实端点）===\n");
  console.log(`临时项目: ${projectDir}`);
  console.log(`fixture 内容: src/calculator.ts（含 bug）+ src/index.ts + tests/ + skills/\n`);

  // 2. 组装 00-11
  assemblyLayer("00 基座（类型/适配器/EventStream）", "pi-ai + agent 包 types.ts", "00 Minimal LLM Call");
  assemblyLayer("07 Agent 封装 + TreeSession 会话树", "agent-core agent.ts L173 + harness/session/", "07 Session Tree");
  assemblyLayer("08 压缩（可选，本演示不启用）", "coding-agent core/compaction/compaction.ts（compactSession）", "08 Context Compaction");
  assemblyLayer("09 技能目录（content 按需读取）", "agent-session.ts L963 buildSystemPrompt", "09 Skills");
  assemblyLayer("10 扩展 runtime 接线", "sdk.ts L362-367 + _installAgentToolHooks L486-522", "10 Extension Runtime");
  assemblyLayer("11 permission-gate 扩展", "examples/extensions/permission-gate.ts", "11 Extension Composition");
  assemblyLayer("产品工具集（read_file/write_file/edit/grep/bash）", "harness/tools/ + coding-agent core/tools/", "12 本文件");

  const { agent, saveSession } = await createCodingAgent({
    cwd: projectDir,
    model,
    llm: new AnthropicLlmAdapter(),
    skills: [loadSkillFromFile(join(projectDir, "skills", "verify.md"), "verify", "验证修复：修复后运行 npm test 确认")],
    extensions: [permissionGate],
    sessionFile,
    systemPromptPrefix: "你是一个编码助手。完成任务时先读取匹配的 verify 技能文件，按其中流程操作。",
  });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      const mark = event.isError ? "（错误结果）" : "";
      const preview = event.result.content.replace(/\n/g, " ").slice(0, 140);
      console.log(`  · 工具: ${event.toolName}${mark} → ${preview}`);
    }
  });

  // 3. 请求一：真实编码任务（Skill 按需加载 → 定位 → 修复 → 验证 → 最终回复）
  console.log("\n[请求一] 修复 src/calculator.ts 中的 bug，运行测试确认修复结果");
  await agent.prompt("修复 src/calculator.ts 中的 bug。先读 verify 技能文件了解验证流程，再定位问题、修复并运行测试确认。");
  const finalReply = agent.state.messages.at(-1);
  console.log(`\n=== 最终回复: ${finalReply?.text ?? "(无)"}`);

  // 4. 请求二：危险命令拦截（permission-gate 在真实产品链路中拦截 rm -rf）
  console.log("\n[请求二] 尝试用 bash 执行 rm -rf node_modules（应由 permission-gate 拦截）");
  await agent.prompt("用 bash 执行 rm -rf node_modules 清理依赖目录。");
  const blocked = agent.state.messages.at(-1);
  console.log(`拦截结果: ${blocked?.text ?? "(无)"}`);

  // 5. 会话持久化（07 树）→ 恢复 → 继续
  await saveSession();
  console.log(`\n会话已保存: ${sessionFile}`);
  const resumed = await createCodingAgent({
    cwd: projectDir,
    model,
    llm: new AnthropicLlmAdapter(),
    skills: [loadSkillFromFile(join(projectDir, "skills", "verify.md"), "verify", "验证修复：修复后运行 npm test 确认")],
    extensions: [permissionGate],
    sessionFile,
    systemPromptPrefix: "你是一个编码助手。完成任务时先读取匹配的 verify 技能文件，按其中流程操作。",
  });
  console.log(`恢复后消息数: ${resumed.agent.state.messages.length}（leaf = 最后一条 entry）`);
  await resumed.agent.prompt("基于当前会话，再运行一次 npm test 确认项目仍然通过。");
  console.log(`继续对话后消息数: ${resumed.agent.state.messages.length}`);
  console.log(`继续后最终回复: ${resumed.agent.state.messages.at(-1)?.text ?? "(无)"}`);

  console.log("\n=== 收束 ===");
  console.log("00-11 的机制第一次全部处于同一条真实执行链中：工具是真实的（fs/child_process），");
  console.log("权限策略在扩展里（10/11 章机制），循环与 Agent 无需感知产品策略。");
  console.log(`\nDemo workspace kept at: ${projectDir}`);
  console.log("（临时项目保留：可直接查看修复后的 src/calculator.ts 与会话文件 .lpia-session.jsonl）");
}

main().catch((error: unknown) => {
  console.error("\n演示失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
