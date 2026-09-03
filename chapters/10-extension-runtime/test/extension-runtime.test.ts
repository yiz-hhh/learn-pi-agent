/**
 * 10 章测试：Extension Runtime 六类能力（Observe / Intercept / Extend / Reconfigure /
 * Inject / Persist）+ loader + wrapper 联动 + 组合全链路。流式 mock LLM 驱动（离线）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionRunner } from "../src/runner.ts";
import { loadExtensionsFromDir } from "../src/loader.ts";
import { createExtensionAwareConfig, forwardAgentEvents } from "../src/index.ts";
import type { ExtensionFactory, ExtensionTool, RuntimeConfig } from "../src/extension-api.ts";
import type { LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";

/** 10 章教学扩展目录（loader 的加载对象）。 */
const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

/** 流式 mock LLM：步骤用尽后重复最后一步。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(): AsyncIterable<AssistantMessageEvent> {
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

/** 记录每次 complete 请求的 provider 可见工具名（setActiveTools 全链路验证用）。 */
class RecordingScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  /** 每轮请求携带的 provider 可见工具名。 */
  calls: string[][] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(request: { tools?: Tool[] }): AsyncIterable<AssistantMessageEvent> {
    this.calls.push((request.tools ?? []).map((t) => t.name));
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
  const partial: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  };
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
    { type: "done", partial },
  ];
}

function assistantMessage(): AssistantMessage {
  return { role: "assistant", stopReason: "tool_use", toolCalls: [] };
}

/** 建 runner 并加载工厂。 */
async function makeRunner(
  factories: ExtensionFactory[],
  config: RuntimeConfig = { model: "m", activeTools: [] },
): Promise<ExtensionRunner> {
  const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
  await runner.load(factories);
  return runner;
}

/** 一个最小 hello 工具工厂。 */
function helloFactory(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "hello",
      description: "问候",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async execute(args) {
        return { content: `Hello, ${String(args.name)}!` };
      },
    });
  };
}

/** 临时目录（afterEach 清理）。 */
let tempRoot: string | undefined;
function tempDir(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "lpia-10-"));
  return tempRoot;
}

describe("extensions 运行时（10 章）", () => {
  it("Extend：registerTool 进注册表，可包装进 context.tools（Pi registerTool：ToolDefinition 类型 L449、方法签名 L1286）", async () => {
    const runner = await makeRunner([helloFactory()]);
    expect(runner.getRegisteredTools().map((t) => t.name)).toEqual(["hello"]);
    // 包装后是 00 基座 Tool 形状（可放进 AgentLoopConfig 的 context.tools）
    const wrapped: Tool = runner.getRegisteredTools()[0];
    expect(wrapped.name).toBe("hello");
    const result = await wrapped.execute({ name: "Alice" });
    expect(result.content).toBe("Hello, Alice!");
  });

  it("Intercept：on(tool_call) 拦截危险工具，block + reason 回传（Pi emitToolCall L932）", async () => {
    const runner = await makeRunner([
      (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolCall.name === "delete_file") return { block: true, reason: "禁止删除" };
          return undefined;
        });
        pi.registerTool({
          name: "delete_file",
          description: "删除",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: "已删除" };
          },
        });
      },
    ]);
    const event = { assistantMessage: assistantMessage(), toolCall: { id: "c1", name: "delete_file", arguments: {} }, args: {} };
    expect(await runner.emitToolCall(event)).toMatchObject({ block: true, reason: "禁止删除" });
    // 非危险工具不拦
    expect(
      await runner.emitToolCall({ assistantMessage: assistantMessage(), toolCall: { id: "c2", name: "hello", arguments: {} }, args: {} }),
    ).toBeUndefined();
  });

  it("Intercept 全链路：被拦工具进错误 toolResult，模型可见拦截原因", async () => {
    const runner = await makeRunner(
      [
        (pi) => pi.on("tool_call", async (e) => (e.toolCall.name === "delete_file" ? { block: true, reason: "guard：禁止删除" } : undefined)),
        (pi) =>
          pi.registerTool({
            name: "delete_file",
            description: "删除",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: "已删除" };
            },
          }),
      ],
      { model: "m", activeTools: ["delete_file"] },
    );
    const deleteTool = runner.getRegisteredTools().find((t) => t.name === "delete_file");
    if (!deleteTool) throw new Error("delete_file 未注册");
    const agent = new Agent({
      systemPrompt: "助手",
      tools: [deleteTool],
      llm: new ScriptedLlm([toolStream([{ id: "c1", name: "delete_file", args: { path: "/tmp/x" } }]), textStream("完成")]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("删");
    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "delete_file");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("guard：禁止删除");
  });

  it("Extend：registerCommand 命令表 + 分发（args 与 ctx 注入，Pi registerCommand L1295）", async () => {
    const calls: { args: string; cwd: string }[] = [];
    const runner = await makeRunner([
      (pi) => {
        pi.registerCommand("greet", {
          description: "问候",
          handler: (args, ctx) => {
            calls.push({ args, cwd: ctx.cwd });
          },
        });
      },
    ]);
    expect(runner.getCommands().map((c) => c.name)).toEqual(["greet"]);
    await runner.runCommand("greet Alice");
    expect(calls).toEqual([{ args: "Alice", cwd: tmpdir() }]);
    await expect(runner.runCommand("nope")).rejects.toThrow("not found");
  });

  it("loader：从目录加载全部教学扩展（default export 工厂，Pi loadExtensions L648）", async () => {
    const factories = await loadExtensionsFromDir(EXTENSIONS_DIR);
    const runner = await makeRunner(factories);
    const names = runner.getRegisteredTools().map((t) => t.name).sort();
    expect(names).toEqual(["delete_file", "hello", "todo"]);
    expect(runner.getCommands().map((c) => c.name)).toEqual(["todos"]);
    expect(runner.hasHandlers("tool_call")).toBe(true);
  });

  it("Inject：on(context) 注入消息 → transformContext 输出变化（Pi sdk.ts L362-367）", async () => {
    const runner = await makeRunner([
      (pi) => {
        pi.on("context", async ({ messages }) => [
          ...messages,
          { role: "user" as const, text: "注入：扩展上下文" },
        ]);
      },
    ]);
    const out = await runner.emitContext([{ role: "user", text: "任务" }]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ text: "注入：扩展上下文" });
  });

  it("wrapper addedToolNames 联动：execute 中激活新工具 → 结果声明（Pi wrapper.ts L22-35）", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: ["echo"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    const echo: ExtensionTool = {
      name: "echo",
      description: "回显",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.setActiveTools([...ctx.getActiveTools(), "secret"]); // 解锁新工具（09 章 addedToolNames 语义的运行时版）
        return { content: "hi" };
      },
    };
    const secret: ExtensionTool = {
      name: "secret",
      description: "秘密",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "s" };
      },
    };
    await runner.load([(pi) => pi.registerTool(echo), (pi) => pi.registerTool(secret)]);
    // execute 后结果带 addedToolNames
    const result = await runner.getRegisteredTools()[0].execute({});
    expect(result.addedToolNames).toContain("secret");
    // loadTools 从注册表动态取出（循环侧动态加载闭环）
    const aware = createExtensionAwareConfig(runner);
    expect(aware.loadTools(["secret"]).map((t) => t.name)).toContain("secret");
  });

  it("Reconfigure 全链路：ctx.setActiveTools 立即更新 running agent.state.tools，下一次 provider call 可见（Pi setActiveToolsByName L950-972）", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: ["read_fixture", "write_fixture"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    const readFixture: ExtensionTool = {
      name: "read_fixture",
      description: "只读占位（测试 fixture，非真编码工具）",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "r" };
      },
    };
    const writeFixture: ExtensionTool = {
      name: "write_fixture",
      description: "写入占位（测试 fixture，非真编码工具）",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "w" };
      },
    };
    await runner.load([
      (pi) => pi.registerTool(readFixture),
      (pi) => pi.registerTool(writeFixture),
      (pi) =>
        pi.registerCommand("readonly", {
          description: "切换到只读工具集",
          handler: async (_args, ctx) => {
            ctx.setActiveTools(["read_fixture"]);
          },
        }),
    ]);

    // 组装：Agent 已构造（工具快照 = 两个 fixture）+ 绑定工具运行时（组装层持有完整宇宙）
    const allTools = runner.getRegisteredTools();
    const llm = new RecordingScriptedLlm([textStream("初始轮"), textStream("只读轮"), textStream("恢复轮")]);
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

    // 切换前：provider 看到全部工具
    await agent.prompt("初始");
    expect(llm.calls[0]).toEqual(["read_fixture", "write_fixture"]);

    // 扩展侧动作：命令 handler 调用 ctx.setActiveTools（extension → ctx → action → Agent，不拿 Agent）
    await runner.runCommand("readonly");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["read_fixture"]);
    expect(config.activeTools).toEqual(["read_fixture"]); // 配置同步

    // 下一次 provider call 立即看到新工具集
    await agent.prompt("只读");
    expect(llm.calls[1]).toEqual(["read_fixture"]);

    // 恢复：全部工具回到下一次 provider call
    runner.createContext().setActiveTools(["read_fixture", "write_fixture"]);
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["read_fixture", "write_fixture"]);
    await agent.prompt("恢复");
    expect(llm.calls[2]).toEqual(["read_fixture", "write_fixture"]);
  });

  it("wrapper 守卫：execute 中同时增删工具时不报 addedToolNames（Pi wrapper.ts L26）", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: ["echo", "drop"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    const echo: ExtensionTool = {
      name: "echo",
      description: "回显",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.setActiveTools(["echo", "secret"]); // 新增 secret、同时移除 drop
        return { content: "hi" };
      },
    };
    const drop: ExtensionTool = {
      name: "drop",
      description: "占位",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "d" };
      },
    };
    await runner.load([(pi) => pi.registerTool(echo), (pi) => pi.registerTool(drop)]);
    const result = await runner.getRegisteredTools()[0].execute({});
    // Pi 守卫：任一工具被移除 → 直接返回原始结果，不报告 addedToolNames
    expect(result.addedToolNames).toBeUndefined();
  });

  it("Observe：on(message_end) 收到事件（Pi on() 事件族）", async () => {
    let seen = 0;
    const runner = await makeRunner([
      (pi) => {
        pi.on("message_end", async () => {
          seen++;
        });
      },
    ]);
    const agent = new Agent({
      systemPrompt: "助手",
      tools: [],
      llm: new ScriptedLlm([textStream("完成")]),
      config: { model: "m" },
    });
    agent.subscribe(forwardAgentEvents(runner));
    await agent.prompt("hi");
    expect(seen).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("Persist：todo 状态存会话树，分支回溯后状态回到历史值（Pi todo.ts L114-133）", async () => {
    const session = new TreeSession();
    const config: RuntimeConfig = { model: "m", activeTools: ["todo"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session });
    await runner.load(await loadExtensionsFromDir(EXTENSIONS_DIR));
    const todoTool = runner.getRegisteredTools().find((t) => t.name === "todo");
    if (!todoTool) throw new Error("todo 未注册");

    // 模拟两轮工具执行 + 消息写树
    const asst1: AssistantMessage = { role: "assistant", stopReason: "tool_use", toolCalls: [{ id: "c1", name: "todo", arguments: { action: "add", text: "任务一" } }] };
    const asst2: AssistantMessage = { role: "assistant", stopReason: "tool_use", toolCalls: [{ id: "c2", name: "todo", arguments: { action: "add", text: "任务二" } }] };
    const r1 = await todoTool.execute({ action: "add", text: "任务一" } as Record<string, unknown>);
    session.appendMessage(asst1);
    session.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "todo", text: r1.content, details: r1.details });
    const r2 = await todoTool.execute({ action: "add", text: "任务二" } as Record<string, unknown>);
    session.appendMessage(asst2);
    session.appendMessage({ role: "toolResult", toolCallId: "c2", toolName: "todo", text: r2.content, details: r2.details });

    const list = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    expect(list.content).toContain("任务一");
    expect(list.content).toContain("任务二");

    // 分支回溯到第一条 toolResult：状态自动回到历史值（树的第二个价值）
    const firstTr = session.getBranch().find((e) => e.type === "message" && (e as { message: Message }).message.role === "toolResult");
    if (!firstTr) throw new Error("toolResult 不存在");
    session.branch(firstTr.id);
    const listAfter = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    expect(listAfter.content).toContain("任务一");
    expect(listAfter.content).not.toContain("任务二");
  });

  it("组合：guard + hello + todo 全链路（Intercept + Extend + Observe + Persist 一次 run）", async () => {
    const session = new TreeSession();
    const config: RuntimeConfig = { model: "m", activeTools: ["hello", "todo", "delete_file"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session });
    await runner.load(await loadExtensionsFromDir(EXTENSIONS_DIR));

    const agent = new Agent({
      systemPrompt: "助手",
      tools: [createCalculatorTool(), ...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "delete_file", args: { path: "/tmp/x" } }]),
        toolStream([{ id: "c2", name: "todo", args: { action: "add", text: "任务" } }]),
        toolStream([{ id: "c3", name: "hello", args: { name: "Alice" } }]),
        textStream("完成"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    agent.subscribe(forwardAgentEvents(runner));
    agent.subscribe((event) => {
      if (event.type === "message_end") session.appendMessage(event.message);
    });
    await agent.prompt("执行");

    const msgs = agent.state.messages;
    // Intercept：delete_file 被 guard 拦成错误结果
    const blocked = msgs.find((m) => m.role === "toolResult" && m.toolName === "delete_file");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("禁止删除");
    // Extend：todo / hello 正常执行
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "todo")).toBe(true);
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "hello")).toBe(true);
    // Persist：todo 状态可从会话树分支推导
    const todoTool = runner.getRegisteredTools().find((t) => t.name === "todo");
    if (!todoTool) throw new Error("todo 未注册");
    const list = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    expect(list.content).toContain("任务");
  });

  it("todo 并行批次：同一批两次 add 不丢状态（module state 权威 + leaf 变化才重建）", async () => {
    const session = new TreeSession();
    const config: RuntimeConfig = { model: "m", activeTools: ["todo"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session });
    await runner.load(await loadExtensionsFromDir(EXTENSIONS_DIR));
    const todoTool = runner.getRegisteredTools().find((t) => t.name === "todo");
    if (!todoTool) throw new Error("todo 未注册");

    // 一条 assistant 消息带两个 todo add → 07 章 loop 默认并行执行（executeToolCallsParallel）
    const agent = new Agent({
      systemPrompt: "助手",
      tools: runner.getVisibleTools(),
      llm: new ScriptedLlm([
        toolStream([
          { id: "c1", name: "todo", args: { action: "add", text: "A" } },
          { id: "c2", name: "todo", args: { action: "add", text: "B" } },
        ]),
        textStream("完成"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    agent.subscribe(forwardAgentEvents(runner));
    agent.subscribe((event) => {
      if (event.type === "message_end") session.appendMessage(event.message);
    });
    await agent.prompt("加两条");

    const list = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    // 并行批次下两次 execute 都基于内存态递增：不丢状态、编号不重
    expect(list.content).toContain("#1: A");
    expect(list.content).toContain("#2: B");
  });

  it("loader 失败隔离：factory throw 不杀兄弟扩展，半注册不提交（Pi 逐路径收集 + discard）", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "bad-extension.ts"),
      [
        "export default function (pi) {",
        "  pi.registerTool({ name: \"zombie\", description: \"僵尸\", parameters: { type: \"object\", properties: {} },",
        "    async execute() { return { content: \"z\" }; } });",
        '  throw new Error("boom");',
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "good-extension.ts"),
      [
        "export default function (pi) {",
        "  pi.registerTool({ name: \"hello\", description: \"问候\",",
        "    parameters: { type: \"object\", properties: { name: { type: \"string\" } }, required: [\"name\"] },",
        "    async execute(args) { return { content: `Hello, ${String(args.name)}!` }; } });",
        "}",
      ].join("\n"),
    );
    const factories = await loadExtensionsFromDir(dir);
    const runner = await makeRunner(factories);
    // zombie 在 throw 前已注册，必须随临时注册区一起被丢弃
    expect(runner.getRegisteredTools().map((t) => t.name)).toEqual(["hello"]);
  });

  it("Inject 链式：后一个 context handler 看到前一个的输出（Pi emitContext L984 链式）", async () => {
    const runner = await makeRunner([
      (pi) => pi.on("context", async ({ messages }) => [...messages, { role: "user" as const, text: "A" }]),
      (pi) =>
        pi.on("context", async ({ messages }) => {
          // 链式语义：这里必须已经看到 A 的注入（load 序 × 注册序）
          expect(messages.some((m) => m.text === "A")).toBe(true);
          return [...messages, { role: "user" as const, text: "B" }];
        }),
    ]);
    const out = await runner.emitContext([{ role: "user", text: "任务" }]);
    expect(out.map((m) => m.text)).toEqual(["任务", "A", "B"]);
  });

  it("Intercept 短路：block 后后续 handler 不运行（Pi emitToolCall L932 短路）", async () => {
    let sideEffects = 0;
    const runner = await makeRunner([
      (pi) =>
        pi.on("tool_call", async (e) =>
          e.toolCall.name === "delete_file" ? { block: true, reason: "禁止" } : undefined,
        ),
      (pi) =>
        pi.on("tool_call", async () => {
          sideEffects++;
          return undefined;
        }),
    ]);
    const verdict = await runner.emitToolCall({
      assistantMessage: assistantMessage(),
      toolCall: { id: "c1", name: "delete_file", arguments: {} },
      args: {},
    });
    expect(verdict).toMatchObject({ block: true, reason: "禁止" });
    expect(sideEffects).toBe(0);
  });

  it("错误隔离：handler 抛错不击穿兄弟 handler 与 dispatch（Pi 每 handler try/catch）", async () => {
    const ran: string[] = [];
    const runner = await makeRunner([
      (pi) =>
        pi.on("message_end", async () => {
          throw new Error("boom");
        }),
      (pi) =>
        pi.on("message_end", async () => {
          ran.push("B");
        }),
    ]);
    // dispatch 本身不抛；B 照常运行
    await expect(runner.emit("message_end", { message: { role: "user", text: "hi" } })).resolves.toBeDefined();
    expect(ran).toEqual(["B"]);
  });

  it("async factory：await 后注册照常生效（Pi ExtensionFactory 支持 Promise<void>）", async () => {
    const runner = await makeRunner([
      async (pi) => {
        await Promise.resolve();
        pi.registerTool({
          name: "hello",
          description: "问候",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: "hi" };
          },
        });
      },
    ]);
    expect(runner.getRegisteredTools().map((t) => t.name)).toEqual(["hello"]);
  });

  it("回归：空 runner 接线不改变 Agent 基线（无扩展 → hooks 直通）", async () => {
    const runner = await makeRunner([]);
    const aware = createExtensionAwareConfig(runner);
    // transformContext 原样返回
    const msgs: Message[] = [{ role: "user", text: "任务" }];
    expect(await aware.transformContext(msgs)).toEqual(msgs);
    // beforeToolCall 不拦截
    const verdict = await aware.beforeToolCall({
      assistantMessage: assistantMessage(),
      toolCall: { id: "c1", name: "hello", arguments: {} },
      args: {},
      context: { systemPrompt: "助手", messages: msgs },
    });
    expect(verdict).toBeUndefined();
    // loadTools 无新增
    expect(aware.loadTools(["hello"])).toEqual([]);
  });

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });
});
