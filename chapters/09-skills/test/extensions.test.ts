/**
 * 09 章测试：三种扩展形态，技能目录 + 按需读取、uiOnly 消息过滤、addedToolNames 动态工具。
 * 流式 mock LLM 驱动（离线）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent-loop.ts";
import {
  createToolRegistry,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSkillFromFile,
  readSkillContent,
  type Skill,
} from "../src/extensions.ts";
import { convertToLlm } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：记录输入（含 tools）。 */
class ChatLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenInputs: { messages: Message[]; tools: unknown[] }[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push({ messages: [...input.messages], tools: [...(input.tools ?? [])] });
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

/** 返回 addedToolNames 的工具：引入 "echo" 工具。 */
function dynamicTool(): Tool {
  return {
    name: "unlock",
    description: "解锁 echo 工具",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "echo 已解锁", addedToolNames: ["echo"] };
    },
  };
}

/** 按需读取工具：read_skill 返回技能文件内容（模型凭 location 调用）。 */
function readSkillTool(filePath: string): Tool {
  return {
    name: "read_skill",
    description: "读取技能文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(args: { path: string }) {
      return { content: readSkillContent(args.path) };
    },
  };
}

/** 临时技能文件（afterEach 统一清理）。 */
let skillCounter = 0;
let tempRoot: string | undefined;
function tempSkillFile(content: string): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "lpia-09-"));
  const file = join(tempRoot, `skill-${skillCounter++}.md`);
  writeFileSync(file, content, "utf8");
  return file;
}

describe("extensions（09 章）", () => {
  it("formatSkillsForSystemPrompt：目录块只含 name/description/location，content 不在其中（Pi system-prompt.ts L3-25）", () => {
    const file = tempSkillFile("用 calculator 工具计算");
    const block = formatSkillsForSystemPrompt([
      { name: "calc", description: "处理计算任务", content: "用 calculator 工具计算", filePath: file },
    ]);
    expect(block).toContain("<available_skills>");
    expect(block).toContain(`<skill name="calc" location="${file}">`);
    expect(block).toContain("处理计算任务");
    // content 不注入系统提示词：模型凭 location 按需读取
    expect(block).not.toContain("用 calculator 工具计算");
    expect(formatSkillsForSystemPrompt([])).toBe("");
  });

  it("readSkillContent / loadSkillFromFile：按需读取技能文件（Pi skills.ts L50-76 最小版）", () => {
    const file = tempSkillFile("使用 calculator 工具计算结果。");
    const skill = loadSkillFromFile(file, "calc", "处理算术计算");
    expect(skill).toMatchObject({ name: "calc", description: "处理算术计算", filePath: file });
    expect(skill.content).toBe("使用 calculator 工具计算结果。");
    expect(readSkillContent(file)).toBe("使用 calculator 工具计算结果。");
  });

  it("formatSkillInvocation：完整技能块（Pi skills.ts L38-41），可追加附加指令", () => {
    const skill: Skill = { name: "calc", description: "计算", content: "用 calculator 计算", filePath: "/tmp/calc.md" };
    const block = formatSkillInvocation(skill);
    expect(block).toContain('<skill name="calc" location="/tmp/calc.md">');
    expect(block).toContain("用 calculator 计算");
    expect(formatSkillInvocation(skill, "回答要简洁")).toContain("回答要简洁");
  });

  it("uiOnly 消息被 convertToLlm 过滤（Pi 注释示例：Filter out UI-only messages）", () => {
    const messages: Message[] = [
      { role: "user", text: "任务" },
      { role: "user", text: "UI 通知：正在连接", uiOnly: true },
      { role: "assistant", text: "回复" },
    ];
    const llm = convertToLlm(messages);
    expect(llm).toHaveLength(2);
    expect(llm.some((m) => m.role === "user" && (m as { content?: unknown }).content === "UI 通知：正在连接")).toBe(false);
  });

  it("addedToolNames 动态工具：结果引入新工具，后续轮次模型可见（Pi types.ts L368-369）", async () => {
    const registry = createToolRegistry([createCalculatorTool(), createEchoTool()]);
    const chat = new ChatLlm([toolStream([{ id: "c1", name: "unlock", args: {} }]), textStream("解锁后完成")]);

    await runAgentLoop(
      [{ role: "user", text: "解锁" }],
      { systemPrompt: "助手", messages: [], tools: [createCalculatorTool(), dynamicTool()] },
      {
        model: "m",
        loadTools: (names) => registry.load(names),
      },
      chat,
      () => {},
    );

    // 第 2 轮 LLM 输入的工具列表包含动态引入的 echo
    expect(chat.seenInputs.length).toBe(2);
    const secondTools = chat.seenInputs[1].tools.map((t) => (t as { name: string }).name);
    expect(secondTools).toContain("echo");
  });

  it("跨 run：动态加载的工具回写调用方 context（Pi transcript point onward 语义）", async () => {
    const registry = createToolRegistry([createCalculatorTool(), createEchoTool()]);
    const context: Parameters<typeof runAgentLoop>[1] = {
      systemPrompt: "助手",
      messages: [],
      tools: [createCalculatorTool(), dynamicTool()],
    };
    // run 1：解锁 echo
    const chat1 = new ChatLlm([toolStream([{ id: "c1", name: "unlock", args: {} }]), textStream("解锁后完成")]);
    await runAgentLoop(
      [{ role: "user", text: "解锁" }],
      context,
      { model: "m", loadTools: (names) => registry.load(names) },
      chat1,
      () => {},
    );
    // 调用方持有的 context.tools 已回写：echo 在 run 2 可用
    expect(context.tools?.map((t) => (t as { name: string }).name)).toContain("echo");
    // run 2：模型直接请求 echo
    const chat2 = new ChatLlm([toolStream([{ id: "c2", name: "echo", args: { text: "你好" } }]), textStream("完成")]);
    const run2 = await runAgentLoop(
      [{ role: "user", text: "回显" }],
      context,
      { model: "m", loadTools: (names) => registry.load(names) },
      chat2,
      () => {},
    );
    const echoResult = run2.find((m) => m.role === "toolResult" && m.toolName === "echo");
    expect(echoResult).toMatchObject({ isError: false, text: "你好" });
  });

  it("组合：技能目录 + uiOnly 过滤 + 动态工具全链路", async () => {
    const skillFile = tempSkillFile("用 calculator 工具计算");
    const skillsBlock = formatSkillsForSystemPrompt([
      { name: "calc", description: "计算任务", content: "用 calculator 工具计算", filePath: skillFile },
    ]);
    const systemPrompt = `你是一个助手。\n${skillsBlock}`;
    const registry = createToolRegistry([createEchoTool()]);
    const chat = new ChatLlm([toolStream([{ id: "c1", name: "unlock", args: {} }]), textStream("完成")]);

    await runAgentLoop(
      [{ role: "user", text: "解锁并计算" }, { role: "user", text: "（连接状态）", uiOnly: true }],
      { systemPrompt, messages: [], tools: [createCalculatorTool(), dynamicTool()] },
      {
        model: "m",
        loadTools: (names) => registry.load(names),
      },
      chat,
      () => {},
    );

    // 第 1 轮输入：内部历史含 uiOnly 消息（过滤发生在 convertToLlm，adapter 内部；独立用例验证）
    expect(chat.seenInputs[0].messages).toHaveLength(2);
    expect(chat.seenInputs[0].messages[0]).toMatchObject({ role: "user", text: "解锁并计算" });
  });

  it("on-demand 链路：模型按需读取技能文件后按指令执行（Pi 目录 + 按需读取机制）", async () => {
    const skillFile = tempSkillFile("使用 calculator 工具计算结果，回答要简洁。");
    const skill: Skill = { name: "calc", description: "计算任务", content: readSkillContent(skillFile), filePath: skillFile };
    const systemPrompt = "你是一个计算助手。\n" + formatSkillsForSystemPrompt([skill]);
    const chat = new ChatLlm([
      toolStream([{ id: "c1", name: "read_skill", args: { path: skillFile } }]),
      toolStream([{ id: "c2", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("结果 3"),
    ]);

    const results = await runAgentLoop(
      [{ role: "user", text: "计算 1+2" }],
      { systemPrompt, messages: [], tools: [createCalculatorTool(), readSkillTool(skillFile)] },
      { model: "m" },
      chat,
      () => {},
    );

    // read_skill 的结果把技能内容带回历史（模型可见）
    const readResult = results.find((m) => m.role === "toolResult" && m.toolName === "read_skill");
    expect(readResult).toMatchObject({ isError: false });
    expect(readResult?.text).toContain("使用 calculator 工具计算结果");
    // 随后模型按技能指令调用 calculator
    expect(results.some((m) => m.role === "toolResult" && m.toolName === "calculator")).toBe(true);
  });

  it("回归：无扩展时行为不变（uiOnly 不存在、无动态工具）", async () => {
    const chat = new ChatLlm([textStream("完成")]);
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      { systemPrompt: "助手", messages: [], tools: [createCalculatorTool()] },
      { model: "m" },
      chat,
      () => {},
    );
    expect(chat.seenInputs[0].messages).toHaveLength(1);
    expect(chat.seenInputs[0].tools.map((t) => (t as { name: string }).name)).toEqual(["calculator"]);
  });
});

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});
