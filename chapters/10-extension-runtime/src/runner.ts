/**
 * 10 章核心：ExtensionRunner（Pi runner.ts L268 的教学子集）。
 *
 * 职责四件：
 * 1. 事件分发：hasHandlers（L569）+ emit（L801）+ emitToolCall（L932 拦截短路）+ emitContext（L984 链式）；
 * 2. 上下文：createContext（L673，Pi 用惰性 getter + assertActive，教学简化为直接对象）；
 * 3. 收集：registerTool / registerCommand（工厂通过 ExtensionAPI 写入临时注册区，成功后并入 runner；
 *    throw 则整体丢弃——Pi initializeExtension 的 commit/discard 教学版）；
 * 4. Reconfigure 动作：bindToolRuntime 绑定组装层的工具宇宙与 running Agent，
 *    ctx.setActiveTools 经此立即写 agent.state.tools（Pi setActiveToolsByName L950-972 的教学版）。
 */
import type { Message } from "../../00-minimal-llm-call/src/index.ts";
import type {
  ExtensionContext,
  ExtensionEvents,
  ExtensionFactory,
  ExtensionTool,
  RegisteredCommand,
  RuntimeConfig,
  ToolCallEventResult,
  ToolRuntimeBinding,
} from "./extension-api.ts";
import { wrapRegisteredTools } from "./wrapper.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";

/** 运行时上下文快照（createContext 用）。 */
export interface RunnerOptions {
  cwd: string;
  config: RuntimeConfig;
  session: ExtensionContext["session"];
}

/** 单个扩展工厂的临时注册区（Pi 每扩展 Extension 对象注册表的教学压缩）。 */
interface PendingRegistrations {
  handlers: Map<string, Set<(event: unknown, ctx: ExtensionContext) => unknown>>;
  tools: ExtensionTool[];
  commands: RegisteredCommand[];
}

export class ExtensionRunner {
  private handlers = new Map<string, Set<(event: unknown, ctx: ExtensionContext) => unknown>>();
  private tools: ExtensionTool[] = [];
  private commands: RegisteredCommand[] = [];
  private ctx: ExtensionContext;
  private toolBinding: ToolRuntimeBinding | undefined;

  constructor(options: RunnerOptions) {
    this.ctx = {
      cwd: options.cwd,
      mode: "cli",
      config: options.config,
      session: options.session,
      getActiveTools: () => this.getActiveTools(),
      setActiveTools: (toolNames) => this.setActiveTools(toolNames),
    };
  }

  /**
   * 加载扩展工厂（Pi loadExtensions：default export 收 ExtensionAPI）。
   * 失败隔离（Pi initializeExtension + createExtensionAPI 的 commit/discard 教学版）：
   * 每个 factory 先写临时注册区，成功后并入 runner；throw 则整体丢弃，
   * 不留半注册 extension，且不影响其余工厂。
   */
  async load(factories: ExtensionFactory[]): Promise<void> {
    for (const factory of factories) {
      const pending: PendingRegistrations = { handlers: new Map(), tools: [], commands: [] };
      try {
        await factory(this.createAPI(pending));
        // commit：并入 runner 注册表（保持 load 序 × 注册序）
        for (const [type, handlers] of pending.handlers) {
          const set = this.handlers.get(type) ?? new Set();
          for (const handler of handlers) {
            set.add(handler);
          }
          this.handlers.set(type, set);
        }
        this.tools.push(...pending.tools);
        this.commands.push(...pending.commands);
      } catch (error) {
        // discard：临时注册区整体丢弃（Pi load.discard() 的教学版）
        console.warn(
          `扩展工厂执行失败，其注册全部丢弃:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** 事件类型是否有人订阅（Pi hasHandlers L569）。 */
  hasHandlers(type: string): boolean {
    return (this.handlers.get(type)?.size ?? 0) > 0;
  }

  /** 通用事件分发（Pi emit L801）：Observe / Inject。返回所有 handler 结果。 */
  async emit<K extends keyof ExtensionEvents>(type: K, event: ExtensionEvents[K]): Promise<unknown[]> {
    const hs = this.handlers.get(type);
    if (!hs || hs.size === 0) return [];
    const ctx = this.createContext();
    const results: unknown[] = [];
    for (const handler of hs) {
      try {
        results.push(await handler(event, ctx));
      } catch (error) {
        // 扩展 handler 抛错不击穿循环（Pi runner 的错误监听；教学简化为警告）
        console.warn(`扩展事件 ${type} handler 抛错:`, error instanceof Error ? error.message : String(error));
      }
    }
    return results;
  }

  /**
   * Intercept：tool_call 事件，任一 handler 返回 block 即短路（Pi emitToolCall L932：
   * block 后后续 handler 不运行——permission-gate 类策略依赖此语义）。
   */
  async emitToolCall(event: ExtensionEvents["tool_call"]): Promise<ToolCallEventResult | undefined> {
    const hs = this.handlers.get("tool_call");
    if (!hs || hs.size === 0) return undefined;
    const ctx = this.createContext();
    for (const handler of hs) {
      try {
        const verdict = (await handler(event, ctx)) as ToolCallEventResult | undefined;
        if (verdict?.block) {
          return { block: true, reason: verdict.reason };
        }
      } catch (error) {
        console.warn(`扩展事件 tool_call handler 抛错:`, error instanceof Error ? error.message : String(error));
      }
    }
    return undefined;
  }

  /** Inject：context 事件链式变换（Pi emitContext L984：后一个 handler 看到前一个的输出）。 */
  async emitContext(messages: Message[]): Promise<Message[]> {
    const hs = this.handlers.get("context");
    if (!hs || hs.size === 0) return messages;
    const ctx = this.createContext();
    let current = [...messages];
    for (const handler of hs) {
      try {
        const result = (await handler({ messages: current }, ctx)) as Message[] | void;
        if (Array.isArray(result)) {
          current = result;
        }
      } catch (error) {
        console.warn(`扩展事件 context handler 抛错:`, error instanceof Error ? error.message : String(error));
      }
    }
    return current;
  }

  /** 当前上下文（Pi createContext L673；教学版直接返回快照）。 */
  createContext(): ExtensionContext {
    return this.ctx;
  }

  /** 当前可见工具名（Pi getActiveTools；教学版 = config.activeTools 快照）。 */
  getActiveTools(): string[] {
    return [...this.ctx.config.activeTools];
  }

  /**
   * 绑定工具运行时（组装层在 Agent 构造后调用一次）：
   * - resolve：组装层的完整工具宇宙（内置工具 + 扩展注册表），按名解析；
   * - apply：把解析结果立即写入 running Agent 的 state.tools。
   * invariant：Extension 只能经 ctx.setActiveTools 调用动作，永远不获得 Agent 实例。
   */
  bindToolRuntime(binding: ToolRuntimeBinding): void {
    this.toolBinding = binding;
  }

  /**
   * Reconfigure 动作：切换活跃工具集（Pi setActiveToolsByName，agent-session.ts L950-972 教学版）。
   * 1. 按名解析（有绑定时走组装层宇宙；无绑定时退回扩展注册表——纯配置场景，无 running Agent 可写）；
   * 2. 未知名忽略；
   * 3. 同步 config.activeTools（同数组引用原地更新，组装层/测试持有的 config 保持一致）；
   * 4. 立即写 running agent.state.tools（下一次 provider call 可见）；
   * 5. 不修改 Agent Loop。
   */
  setActiveTools(toolNames: string[]): void {
    const resolve =
      this.toolBinding?.resolve ??
      ((names: string[]) => this.getRegisteredTools().filter((t) => names.includes(t.name)));
    const tools = resolve([...toolNames]);
    const resolvedNames = tools.map((t) => t.name);
    this.ctx.config.activeTools.splice(0, this.ctx.config.activeTools.length, ...resolvedNames);
    this.toolBinding?.apply(tools);
  }

  /** 全部注册工具（含未激活；loadTools 动态加载用）。 */
  getRegisteredTools(): Tool[] {
    return wrapRegisteredTools(this.tools, this);
  }

  /** 当前可见工具（注册即激活的教学简化 + config.activeTools 过滤）。 */
  getVisibleTools(): Tool[] {
    const active = new Set(this.ctx.config.activeTools);
    return wrapRegisteredTools(this.tools, this).filter((t) => active.has(t.name));
  }

  /** 已注册命令。 */
  getCommands(): RegisteredCommand[] {
    return [...this.commands];
  }

  /** 分发命令（用户输入 "name args" → 对应 handler）。 */
  async runCommand(input: string, ctx?: ExtensionContext): Promise<void> {
    const [name, ...rest] = input.trim().split(/\s+/);
    const command = this.commands.find((c) => c.name === name);
    if (!command) {
      throw new Error(`Command not found: ${name}`);
    }
    await command.handler(rest.join(" "), ctx ?? this.createContext());
  }

  /** 工厂看到的 API：只暴露 on/registerTool/registerCommand（Pi createExtensionRuntime + bindCore 的最小版）。
   *  注册先写进 pending（每工厂临时注册区），load 成功后统一并入 runner。 */
  private createAPI(pending: PendingRegistrations) {
    return {
      on<K extends keyof ExtensionEvents>(event: K, handler: (event: ExtensionEvents[K], ctx: ExtensionContext) => unknown) {
        const set = pending.handlers.get(event) ?? new Set();
        set.add(handler as (event: unknown, ctx: ExtensionContext) => unknown);
        pending.handlers.set(event, set);
      },
      registerTool(tool: ExtensionTool) {
        pending.tools.push(tool);
      },
      registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
        pending.commands.push({ name, ...options });
      },
    };
  }
}
