/**
 * 12 章测试：E2E 组装集成（离线 scripted LLM 全链路）。
 *
 * 场景：临时项目（fixture 复制品）修复 calculator.ts 的故意 bug，完整链路：
 *   Skill 按需加载（09 目录 + read 工具）→ grep/read 定位 → edit 修复 → bash npm test
 *   → 失败重试 → 最终回复 → 会话持久化（07 树）→ 恢复继续。
 * 危险 bash（rm -rf）由 11 章 permission-gate 扩展在真实产品链路中拦截（边界完整性 E：
 * 判断在扩展层，loop 与工具零改动，文件系统零接触）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { isDangerousCommand } from "../../11-extension-composition/src/permission-gate.ts";
import { createCodingAgent } from "../src/assembly.ts";
import { loadSkillFromFile } from "../src/extensions.ts";
import { copyFixtureToTemp } from "../src/fixture.ts";
import { loadTree } from "../src/jsonl.ts";
import permissionGate from "../../11-extension-composition/src/permission-gate.ts";

/** 流式 mock LLM：按步骤回放（用尽后重复最后一步）。 */
class ScriptedLlm implements LLMAdapter {
  private steps: AssistantMessageEvent[][];
  private next = 0;

  constructor(steps: AssistantMessageEvent[][]) {
    this.steps = steps;
  }

  async *complete(): AsyncIterable<AssistantMessageEvent> {
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  } as const;
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
    { type: "done", partial },
  ];
}

/** 清理本次测试创建的全部临时项目。 */
const projectDirs: string[] = [];
afterAll(() => {
  for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

describe("E2E：修复 calculator.ts 全链路（00-11 同一条真实执行链）", () => {
  it("Skill 按需加载 → grep/read 定位 → edit 修复 → npm test 失败重试 → 最终回复 → 会话持久化", async () => {
    const project = copyFixtureToTemp();
    projectDirs.push(project);
    const sessionFile = join(project, ".lpia-session.jsonl");
    const skillFile = join(project, "skills", "verify.md");
    const calcFile = join(project, "src", "calculator.ts");
    // 危险命令的靶子：真实目录，验证拦截后零接触
    const victimDir = join(project, "keep");
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, "keep.txt"), "不能删除", "utf8");

    const skill = loadSkillFromFile(skillFile, "verify", "验证修复：修复后运行 npm test 确认");
    const script = new ScriptedLlm([
      // 1. 危险命令：rm -rf 应被 permission-gate 拦截（beforeToolCall 钩子，文件零接触）
      toolStream([{ id: "c1", name: "bash", args: { command: `rm -rf ${victimDir}` } }]),
      // 2. Skill 按需加载（09 目录 + read 工具）
      toolStream([{ id: "c2", name: "read_file", args: { path: skillFile } }]),
      // 3. grep 定位（行号与内容）
      toolStream([{ id: "c3", name: "grep", args: { pattern: "function add", path: "src" } }]),
      // 4. read 读源码
      toolStream([{ id: "c4", name: "read_file", args: { path: "src/calculator.ts" } }]),
      // 5. 修复前先跑测试：失败（证明 bug 存在）
      toolStream([{ id: "c5", name: "bash", args: { command: "npm test", timeout: 120 } }]),
      // 6. edit 修复（定位字符串替换）
      toolStream([{ id: "c6", name: "edit", args: { path: "src/calculator.ts", edits: [{ oldText: "a - b", newText: "a + b" }] } }]),
      // 7. 重跑测试：通过
      toolStream([{ id: "c7", name: "bash", args: { command: "npm test", timeout: 120 } }]),
      // 8. 最终回复
      textStream("已修复并验证通过"),
    ]);

    const { agent, runner, saveSession } = await createCodingAgent({
      cwd: project,
      model: "m",
      llm: script,
      skills: [skill],
      extensions: [permissionGate],
      sessionFile,
      systemPromptPrefix: "你是一个编码助手。先读 verify 技能文件了解验证流程。",
    });

    const toolEvents: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") toolEvents.push(event.toolName);
    });

    await agent.prompt("修复 src/calculator.ts 中的 bug，运行测试确认修复结果");

    // 1. 工具调用链完整（read → grep → edit → bash → 重试）
    expect(toolEvents).toEqual(["bash", "read_file", "grep", "read_file", "bash", "edit", "bash"]);

    // 2. Skill 按需加载（09）：目录在系统提示词、content 不在；read_file 把技能内容带回
    expect(agent.state.systemPrompt).toContain("<available_skills>");
    expect(agent.state.systemPrompt).toContain(skillFile);
    expect(agent.state.systemPrompt).not.toContain("修复流程");
    const skillRead = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "read_file" && m.text?.includes("修复流程"));
    expect(skillRead?.text).toContain("npm test");

    // 3. 危险命令被 permission-gate 拦截（边界完整性 E：扩展层决策，零文件接触）
    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.isError);
    expect(blocked?.text).toContain("拦截");
    expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);

    // 4. 修复前测试失败（错误结果）→ edit 修复 → 重跑通过
    const failing = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("命令退出码"));
    expect(failing?.text).toContain("期望 5");
    expect(failing?.text).not.toContain("全部测试通过");
    const passing = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("全部测试通过"));
    expect(passing).toBeDefined();
    expect(await import("node:fs/promises").then((fs) => fs.readFile(calcFile, "utf8"))).toContain("return a + b;");

    // 5. grep 定位输出（行号与内容）
    const grepResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "grep");
    expect(grepResult?.text).toContain("calculator.ts:5: export function add");

    // 6. 最终回复
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "已修复并验证通过" });
    expect(agent.state.isStreaming).toBe(false);

    // 7. 会话持久化（07 树）：保存 → 恢复（leaf = 最后一条 entry）
    await saveSession();
    expect(existsSync(sessionFile)).toBe(true);
    const loaded = loadTree(sessionFile);
    expect(loaded).not.toBeNull();
    expect(loaded!.tree.getMessages()).toHaveLength(agent.state.messages.length);
    expect(loaded!.tree.getLeafId()).toBe(loaded!.tree.getEntries().at(-1)!.id);

    // 8. 恢复继续（跨 run 记忆）
    const script2 = new ScriptedLlm([textStream("继续确认")]);
    const resumed = await createCodingAgent({
      cwd: project,
      model: "m",
      llm: script2,
      skills: [skill],
      extensions: [permissionGate],
      sessionFile,
      systemPromptPrefix: "你是一个编码助手。先读 verify 技能文件了解验证流程。",
    });
    expect(resumed.agent.state.messages[0]).toMatchObject({ role: "user", text: "修复 src/calculator.ts 中的 bug，运行测试确认修复结果" });
    await resumed.agent.prompt("继续");
    expect(resumed.agent.state.messages).toHaveLength(agent.state.messages.length + 2);

    // 9. 边界完整性（E）：拦截决策在扩展层，不在 loop 与工具
    expect(runner.hasHandlers("tool_call")).toBe(true);
    expect(isDangerousCommand(`rm -rf ${victimDir}`)).toBe(true);
  }, 60000);

  it("危险 bash 拦截聚焦：文件零接触，拦截由扩展提供（边界完整性 E 的反向验证）", async () => {
    const project = copyFixtureToTemp();
    projectDirs.push(project);
    const victimDir = join(project, "keep");
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, "keep.txt"), "不能删除", "utf8");

    const skill = loadSkillFromFile(join(project, "skills", "verify.md"), "verify", "验证修复：修复后运行 npm test 确认");
    const script = new ScriptedLlm([
      toolStream([{ id: "c1", name: "bash", args: { command: `rm -rf ${victimDir}` } }]),
      textStream("已拦截"),
    ]);
    const { agent, runner } = await createCodingAgent({
      cwd: project,
      model: "m",
      llm: script,
      skills: [skill],
      extensions: [permissionGate],
    });

    await agent.prompt("用 bash 删除 keep 目录");

    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("permission-gate");
    expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);
    expect(runner.hasHandlers("tool_call")).toBe(true);
  });
});
