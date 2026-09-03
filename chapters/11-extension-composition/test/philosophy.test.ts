/**
 * 11 章测试：三个案例（permission-gate / plan-mode / subagent）的纯函数与集成。
 * 核心断言：三个工作流全部走 10 章 Extension Runtime，循环与 Agent 零改动；
 * plan-mode 的 /plan 经 10 章 ctx.setActiveTools 动作对 running Agent 立即生效
 * （provider 可见工具列表变化，不重建 Agent）；subagent 的 child 失败走 isError。
 * 流式 mock LLM 驱动（离线）。
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { ExtensionRunner } from "../../10-extension-runtime/src/runner.ts";
import { createExtensionAwareConfig } from "../../10-extension-runtime/src/index.ts";
import type { ExtensionFactory, RuntimeConfig } from "../../10-extension-runtime/src/extension-api.ts";
import type { LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import permissionGate, { decidePermission, isDangerousCommand } from "../src/permission-gate.ts";
import planMode, { isSafeCommand } from "../src/plan-mode.ts";
import subagent from "../src/subagent.ts";
import { createBashTool } from "../src/bash-tool.ts";

/** 演示环境工具集（真实存在的工具名：内置 bash/calculator + 注册 subagent）。 */
const DEMO_ACTIVE_TOOLS = ["bash", "calculator", "subagent"];

/** 流式 mock LLM：步骤用尽后重复最后一步；记录每轮请求的 provider 可见工具名与末条消息文本。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  /** 每轮 complete 请求的快照（setActiveTools 全链路与 context 注入的验证依据）。 */
  calls: { tools: string[]; lastMessage?: string }[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(request: { tools?: { name: string }[]; messages?: { text?: string }[] }): AsyncIterable<AssistantMessageEvent> {
    this.calls.push({
      tools: (request.tools ?? []).map((t) => t.name),
      lastMessage: request.messages?.at(-1)?.text,
    });
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

/** 流式 mock LLM：complete 直接抛错（child provider failure 用）。 */
class ThrowingLlm implements LLMAdapter {
  async *complete(): AsyncIterable<AssistantMessageEvent> {
    throw new Error("child failed");
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

/** 教学 fixture 工具工厂：read/write 占位（只出现在测试；11 章不做真编码工具，12 章才做）。 */
function fixturesFactory(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "read_fixture",
      description: "只读占位",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "r" };
      },
    });
    pi.registerTool({
      name: "write_fixture",
      description: "写入占位",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "w" };
      },
    });
  };
}

/** plan-mode 测试包装：禁用 write_fixture（Pi 硬编码 PLAN_MODE_DISABLED_TOOLS 的 fixture 注入形）。 */
function planModeWithFixtures(): ExtensionFactory {
  return (pi) => planMode(pi, { disabledToolNames: ["write_fixture"] });
}

/** 建 runner 并加载工厂（activeTools 默认演示工具集）。 */
async function makeRunner(factories: ExtensionFactory[]): Promise<ExtensionRunner> {
  const config: RuntimeConfig = { model: "m", activeTools: [...DEMO_ACTIVE_TOOLS] };
  const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
  await runner.load(factories);
  return runner;
}

/** 组装：07 Agent + 完整工具宇宙 + bindToolRuntime 绑定 + 扩展钩子（三个案例统一的组装层）。 */
function makeBoundAgent(runner: ExtensionRunner, builtins: Tool[], llm: LLMAdapter): Agent {
  const allTools = [...builtins, ...runner.getRegisteredTools()];
  const agent = new Agent({
    systemPrompt: "助手",
    tools: allTools,
    llm,
    config: { model: "m", ...createExtensionAwareConfig(runner) },
  });
  runner.bindToolRuntime({
    resolve: (names) => allTools.filter((t) => names.includes(t.name)),
    apply: (tools) => {
      agent.state.tools = tools;
    },
  });
  return agent;
}

describe("permission-gate（11 章案例一，No permission popups → extension）", () => {
  it("纯函数：危险模式匹配（Pi permission-gate.ts L11 三个正则）", () => {
    expect(isDangerousCommand("rm -rf /tmp/x")).toBe(true);
    expect(isDangerousCommand("sudo apt install x")).toBe(true);
    expect(isDangerousCommand("chmod 777 /tmp/x")).toBe(true);
    expect(isDangerousCommand("echo hello")).toBe(false);
    expect(isDangerousCommand("ls -la")).toBe(false);
  });

  it("纯函数：决策（无 UI 默认拒绝；allow 模拟用户确认；安全命令放行）", () => {
    expect(decidePermission("rm -rf /tmp/x", false)).toMatchObject({ block: true });
    expect(decidePermission("rm -rf /tmp/x", false).reason).toContain("危险命令");
    expect(decidePermission("rm -rf /tmp/x", true)).toEqual({ block: false }); // 用户允许
    expect(decidePermission("echo hello", false)).toEqual({ block: false }); // 安全命令
  });

  it("集成：bash 危险命令被拦成错误结果（Intercept 全链路），安全命令真实执行", async () => {
    const runner = await makeRunner([permissionGate]);
    const agent = new Agent({
      systemPrompt: "助手",
      tools: [createBashTool(), ...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "bash", args: { command: "rm -rf /tmp/lpia-11-nonexistent" } }]),
        toolStream([{ id: "c2", name: "bash", args: { command: "echo hello" } }]),
        textStream("完成"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("执行");
    // 拦截证明 = reason 文本：若 execute 真发生过，结果会是 rm 的 stderr 而非拦截原因
    const rmResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("危险命令"));
    expect(rmResult?.isError).toBe(true);
    const echoResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text === "hello");
    expect(echoResult?.isError).toBe(false);
  });
});

describe("plan-mode（11 章案例二，No plan mode → extension）", () => {
  it("纯函数：bash 白名单判定（Pi plan-mode/utils.ts isSafeCommand L97-101）", () => {
    expect(isSafeCommand("cat file.txt")).toBe(true);
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("echo hello")).toBe(true);
    expect(isSafeCommand("rm file.txt")).toBe(false);
    expect(isSafeCommand("mv a b")).toBe(false);
    expect(isSafeCommand("ls > out.txt")).toBe(false); // 重定向
    expect(isSafeCommand("git add .")).toBe(false);
  });

  it("集成：/plan 对 running Agent 立即生效——provider 可见工具变化、context 注入、退出恢复（10 章 Reconfigure seam 验证）", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: [...DEMO_ACTIVE_TOOLS, "read_fixture", "write_fixture"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent, fixturesFactory(), planModeWithFixtures()]);

    // 1-2. 构造 running Agent（工具快照 = 全部 5 个），初始 provider 可见 read + write
    const llm = new ScriptedLlm([textStream("初始轮"), textStream("只读轮"), textStream("恢复轮")]);
    const agent = makeBoundAgent(runner, [createBashTool(), createCalculatorTool()], llm);
    await agent.prompt("初始");
    expect(llm.calls[0].tools).toEqual(["bash", "calculator", "subagent", "read_fixture", "write_fixture"]);

    // 3-4. /plan：不重建 Agent，动作经 ctx.setActiveTools 写 running agent.state.tools
    await runner.runCommand("plan");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["bash", "calculator", "subagent", "read_fixture"]);
    expect(config.activeTools).toEqual(["bash", "calculator", "subagent", "read_fixture"]); // 配置同步

    // 5-7. 下一次 provider call：write_fixture 消失、PLAN MODE context 注入存在
    await agent.prompt("只读探索");
    expect(llm.calls[1].tools).toEqual(["bash", "calculator", "subagent", "read_fixture"]);
    expect(llm.calls[1].lastMessage).toContain("[PLAN MODE ACTIVE]");

    // 8-10. /plan 退出：进入前工具集完整恢复，下一次 provider call 看到 write_fixture 回归
    await runner.runCommand("plan");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["bash", "calculator", "subagent", "read_fixture", "write_fixture"]);
    await agent.prompt("恢复");
    expect(llm.calls[2].tools).toEqual(["bash", "calculator", "subagent", "read_fixture", "write_fixture"]);
  });

  it("集成：plan 模式 bash 白名单拦截（非白名单 block、白名单放行），同一 Agent 全程零重建", async () => {
    const runner = await makeRunner([planMode, subagent]);
    const agent = makeBoundAgent(
      runner,
      [createBashTool(), createCalculatorTool()],
      new ScriptedLlm([
        toolStream([{ id: "c1", name: "bash", args: { command: "rm file.txt" } }]), // 非白名单 → 拦
        toolStream([{ id: "c2", name: "bash", args: { command: "echo ok" } }]), // 白名单 → 放行
        textStream("完成"),
      ]),
    );
    await runner.runCommand("plan"); // 先构造 Agent 后 /plan（与 demo 同序）
    await agent.prompt("探索");
    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("白名单"));
    expect(blocked?.isError).toBe(true);
    expect(agent.state.messages.some((m) => m.role === "toolResult" && m.toolName === "bash" && m.text === "ok")).toBe(true);

    // /plan 关闭：同一 Agent 的工具集恢复（不重建）
    await runner.runCommand("plan");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(DEMO_ACTIVE_TOOLS);
  });

  it("Inject：/plan 开启后 context 注入只读提示（[PLAN MODE ACTIVE]）", async () => {
    const runner = await makeRunner([planMode]);
    const ctx = runner.createContext();
    expect(await runner.emitContext([{ role: "user", text: "任务" }])).toHaveLength(1); // 未开启不注入
    await runner.runCommand("plan", ctx);
    const out = await runner.emitContext([{ role: "user", text: "任务" }]);
    expect(out.at(-1)?.text).toContain("[PLAN MODE ACTIVE]");
  });
});

describe("subagent（11 章案例三，No sub-agents → extension）", () => {
  it("委托：子 agent 独立运行（独立上下文），结果回传主历史；子内部消息不进父历史", async () => {
    const config = { model: "m", activeTools: ["subagent", "calculator"], llm: new ScriptedLlm([textStream("子任务完成")]) } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);

    const agent = new Agent({
      systemPrompt: "助手",
      tools: [createCalculatorTool(), ...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "subagent", args: { task: "调研项目结构" } }]),
        textStream("主完成"),
      ]),
      config: { model: "m" },
    });
    await agent.prompt("委托");

    // 父历史 = user → assistant(tool call) → toolResult → assistant（子内部消息一条都不进父历史）
    expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const result = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain("子 agent 回复：子任务完成");
    // 隔离证据：父只能经 ToolResult 看到子 agent 最终回答，子历史只有计数投影
    expect(agent.state.messages.filter((m) => m.text?.includes("子任务完成"))).toHaveLength(1);
    expect(result?.details).toMatchObject({ subMessages: 2 }); // 子侧：task + assistant 回复
  });

  it("child failure：子 LLM 抛错 → 父收到 isError ToolResult（Pi exitCode/stopReason → isError；教学经 07 errorMessage + throw），父继续", async () => {
    const config = { model: "m", activeTools: ["subagent"], llm: new ThrowingLlm() } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);

    const agent = new Agent({
      systemPrompt: "助手",
      tools: [...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "subagent", args: { task: "任务" } }]),
        textStream("主继续"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("委托");
    const result = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("子 agent 执行失败");
    expect(result?.text).toContain("child failed");
    // 父 loop 收到错误结果后仍继续下一轮
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "主继续" });
  });

  it("abort 边界：parent signal 中止 → 子执行完成后经检测抛错（07 Agent 无公开 abort seam；Pi 子进程 SIGTERM/SIGKILL）", async () => {
    const config = { model: "m", activeTools: ["subagent"], llm: new ScriptedLlm([textStream("子完成")]) } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);
    const tool = runner.getRegisteredTools().find((t) => t.name === "subagent");
    if (!tool) throw new Error("subagent 未注册");
    const aborted = new AbortController();
    aborted.abort();
    await expect(tool.execute({ task: "任务" }, undefined, aborted.signal)).rejects.toThrow("中止");
  });

  it("并行：同一批两个 subagent 调用各建独立子 Agent，结果互不污染（Pi parallel mode 的教学等价：per-execute 隔离）", async () => {
    const config = {
      model: "m",
      activeTools: ["subagent"],
      llm: new ScriptedLlm([textStream("A 结果"), textStream("B 结果")]),
    } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);

    const agent = new Agent({
      systemPrompt: "助手",
      tools: [...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([
          { id: "c1", name: "subagent", args: { task: "任务 A" } },
          { id: "c2", name: "subagent", args: { task: "任务 B" } },
        ]),
        textStream("全部完成"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("并行委托");
    const results = agent.state.messages.filter((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(results).toHaveLength(2);
    const texts = results.map((r) => r.text);
    expect(texts.some((t) => t?.includes("A 结果"))).toBe(true);
    expect(texts.some((t) => t?.includes("B 结果"))).toBe(true);
    // 互不污染：每个结果只含自己子 agent 的回复
    expect(texts.filter((t) => t?.includes("A 结果"))[0]).not.toContain("B 结果");
    expect(texts.filter((t) => t?.includes("B 结果"))[0]).not.toContain("A 结果");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "全部完成" });
  });
});

describe("扩展组合（三案例共存验证）", () => {
  it("三个工作流一次 run 共存：permission-gate 拦 rm + plan-mode 拦 + subagent 委托，循环零改动", async () => {
    const config = {
      model: "m",
      activeTools: [...DEMO_ACTIVE_TOOLS],
      llm: new ScriptedLlm([textStream("子完成")]),
    } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([permissionGate, planMode, subagent]);
    // 先构造 + 绑定，再 /plan：与 demo 同序，锁定「运行中切换」语义
    const agent = makeBoundAgent(
      runner,
      [createBashTool(), createCalculatorTool()],
      new ScriptedLlm([
        toolStream([{ id: "c1", name: "bash", args: { command: "rm -rf /tmp/lpia-11-x" } }]), // permission-gate 拦（plan 也拦，先到先得）
        toolStream([{ id: "c2", name: "bash", args: { command: "echo safe" } }]), // plan 白名单放行
        toolStream([{ id: "c3", name: "subagent", args: { task: "子任务" } }]), // subagent 委托
        textStream("全部完成"),
      ]),
    );
    await runner.runCommand("plan");
    await agent.prompt("执行");
    const msgs = agent.state.messages;
    // permission-gate 拦截优先命中（first-block 短路）
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "bash" && m.isError && m.text?.includes("危险命令"))).toBe(true);
    // plan 白名单放行
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "bash" && m.text === "safe")).toBe(true);
    // subagent 委托成功
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "subagent" && m.text?.includes("子完成"))).toBe(true);
    // 收尾断言：末条 assistant 正常（循环未被任何扩展破坏）
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", text: "全部完成" });
  });
});
