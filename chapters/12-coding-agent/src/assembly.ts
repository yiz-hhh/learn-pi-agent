/**
 * 12 章核心：组装（Pi 启动链路 createAgentSessionRuntime（agent-session-runtime.ts L414）的教学版）。
 *
 * 把 00-11 的全部机制组装成能跑的 Coding Agent：
 * - 00 基座：Message/Tool/AgentLoopConfig/LLMAdapter（import 共享基座）
 * - 07 Agent 封装 + TreeSession 会话树（本目录同步副本 src/agent.ts / session-tree.ts / jsonl.ts）
 * - 08 compaction：可选（传入 compact 阈值即启用 Session Compaction——saveSession 时检查，
 *   超限才压缩：CompactionEntry 追加落盘 + agent state 刷新为重建 context；
 *   **不经过 transformContext**，compaction 归 Session 生命周期，见 08 章语义）
 * - 09 技能目录：formatSkillsForSystemPrompt 只列 name/description/location，content 按需读取
 *   （Pi agent-session.ts L963 _rebuildSystemPrompt → buildSystemPrompt）
 * - 10 扩展 runtime：ExtensionRunner + createExtensionAwareConfig 接线
 *   （beforeToolCall → emitToolCall 拦截、transformContext → emitContext 注入、loadTools 动态工具，
 *   Pi core/sdk.ts L362-367 + _installAgentToolHooks L486-522）
 * - 11 permission-gate：扩展工厂直接复用 11 章实现（危险 bash 在扩展层拦截）
 * - 产品工具集：src/tools/ 五件（Pi tools/index.ts createAllToolDefinitions 的组装视角）
 *
 * 层次（08 章起生效，本文件不破坏）：
 *   Session Tree → buildSessionContext（重建投影）→ canonical state.messages
 *   → transformContext（extension 注入接缝）→ call-time messages
 *
 * 边界完整性：本文件只做接线，不含任何 workflow policy（危险命令判断、
 * 白名单等）都在扩展里。判断标准：删掉 extensions 数组，loop 与工具语义不变。
 */
import type { AgentLoopConfig, LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { ExtensionRunner } from "../../10-extension-runtime/src/runner.ts";
import { createExtensionAwareConfig } from "../../10-extension-runtime/src/index.ts";
import type { ExtensionContext, ExtensionFactory, RuntimeConfig } from "../../10-extension-runtime/src/extension-api.ts";
import { Agent } from "./agent.ts";
import { compactSession, type CompactionSettings } from "./compaction.ts";
import { formatSkillsForSystemPrompt, type Skill } from "./extensions.ts";
import { appendEntries, loadTree } from "./jsonl.ts";
import { TreeSession } from "./session-tree.ts";
import { createProductTools } from "./tools/index.ts";

/** 组装选项。 */
export interface CodingAgentOptions {
  /** 项目根目录：产品工具的 cwd 与路径解析基准。 */
  cwd: string;
  model: string;
  llm: LLMAdapter;
  /** 09 技能目录（content 留在技能文件，模型按需读取）。 */
  skills: Skill[];
  /** 10/11 扩展工厂（如 permission-gate），可选。 */
  extensions?: ExtensionFactory[];
  /** 07 会话持久化文件：构造时自动恢复，saveSession 时追加落盘。 */
  sessionFile?: string;
  /** 系统提示词前缀（技能目录与工具清单自动追加）。 */
  systemPromptPrefix?: string;
  /** 额外工具（追加到产品工具集之后）。 */
  extraTools?: Tool[];
  /** 08 压缩：传入阈值即启用 Session Compaction（saveSession 时检查；不超限零副作用）。 */
  compact?: CompactionSettings;
}

/** 组装产物：可直接 prompt 的 agent + 扩展 runtime + 会话树。 */
export interface CodingAgentAssembly {
  agent: Agent;
  runner: ExtensionRunner;
  session: TreeSession;
  tools: Tool[];
  /**
   * 把 agent 当前消息追加进会话树并落盘（Pi AgentSession 自动持久化的教学版，由调用方触发）。
   * 启用 compact 时在此检查并执行 Session Compaction（08 层）：消息同步进树后，
   * compactSession 内部判定是否超限（未超限/无切点/摘要失败均返回 null，零副作用）；
   * 压缩 = 追加 CompactionEntry + 刷新 agent state 为重建 context，旧 entries 一条不动。
   */
  saveSession(): Promise<void>;
}

/** 组装 00-11（Pi 启动链路的教学版，异步：扩展加载发生在构造期）。 */
export async function createCodingAgent(options: CodingAgentOptions): Promise<CodingAgentAssembly> {
  const tools = [...createProductTools(options.cwd), ...(options.extraTools ?? [])];
  const toolNames = tools.map((t) => t.name);

  // 09 层：system prompt 构造（技能目录 + 工具清单；Pi buildSystemPrompt，agent-session.ts L963）
  const skillsBlock = formatSkillsForSystemPrompt(options.skills);
  const systemPrompt = [options.systemPromptPrefix ?? "你是一个编码助手。", skillsBlock, `可用工具：${toolNames.join(" / ")}`]
    .filter(Boolean)
    .join("\n\n");

  // 10 层：扩展 runtime（ctx.config.activeTools = 产品工具名；runner 持有 07 会话树）
  const config: RuntimeConfig = { model: options.model, activeTools: toolNames };
  const session = new TreeSession();
  const runner = new ExtensionRunner({
    cwd: options.cwd,
    config,
    // 10 章 runner 的 ctx.session 类型指向 07 章 TreeSession；本目录副本与源章同构，
    // 因 class 私有字段产生名义类型差异，此处单点断言（结构完全一致）
    session: session as unknown as ExtensionContext["session"],
  });
  if (options.extensions) {
    await runner.load(options.extensions);
  }

  // 10 层接线：beforeToolCall/transformContext/loadTools 三个钩子（Pi _installAgentToolHooks L486-522 + sdk.ts L362-367）
  // transformContext 只做 extension 注入 / call-time projection（06 层）；
  // compaction 归 Session 生命周期（08 层），不经过这条接缝。
  const hooks = createExtensionAwareConfig(runner);
  const loopConfig: AgentLoopConfig = {
    model: options.model,
    beforeToolCall: hooks.beforeToolCall,
    transformContext: hooks.transformContext,
    loadTools: hooks.loadTools,
  };

  // 07 层：Agent 封装 + 会话恢复。恢复走 buildSessionContext（08 重建投影）：
  // 会话文件里若有 CompactionEntry，canonical 初始消息 = summary + 保留段，而非完整历史
  // （leaf = 文件最后一条 entry，Pi _buildIndex L959）
  const restored = options.sessionFile ? loadTree(options.sessionFile) : null;
  const initialMessages = restored?.tree.buildSessionContext();
  const agent = new Agent({
    systemPrompt,
    tools,
    llm: options.llm,
    config: loopConfig,
    initialMessages,
  });

  // 07 层：会话持久化（消息 → Entry 树 → JSONL；已恢复的消息不重复追加）
  // savedCount 语义：agent.state.messages 中「已在树里表达」的前缀长度。
  // compact 刷新 state 后同步为重建 context 长度（summary 由 CompactionEntry 表达），
  // 下次 save 只追加真正的新消息，不会把 summary 重复写成 MessageEntry。
  let savedCount = initialMessages?.length ?? 0;
  const assembly: CodingAgentAssembly = {
    agent,
    runner,
    session,
    tools,
    async saveSession() {
      const fresh = agent.state.messages.slice(savedCount);
      savedCount = agent.state.messages.length;
      const entries = fresh.map((message) => session.appendMessage(message));
      if (options.sessionFile && entries.length > 0) {
        appendEntries(options.sessionFile, { version: 2, systemPrompt, model: options.model }, entries);
      }

      // 08 层：可选 Session Compaction（触发检查在 compactSession 内部：
      // 未超限 / 无安全切点 / 摘要失败均返回 null，Session 与 agent state 零副作用；
      // active path 已有 compaction entry 的再次压缩不恢复）
      if (options.compact) {
        const result = await compactSession(session, options.llm, options.model, options.compact);
        if (result) {
          // CompactionEntry 与普通 entry 一样落盘（跨 run 持久：恢复时 buildSessionContext 重建）
          const compactionEntry = session.getLeafId() ? session.getEntry(session.getLeafId()!) : undefined;
          if (options.sessionFile && compactionEntry) {
            appendEntries(options.sessionFile, { version: 2, systemPrompt, model: options.model }, [compactionEntry]);
          }
          // 刷新 canonical state（Pi agent-session.ts L2004-2007）：下一 run 用 summary + 保留段，
          // Session Tree 仍保留全部原始 entries（source of truth 不变）。
          agent.replaceMessages(result.context);
          savedCount = result.context.length;
        }
      }
    },
  };
  return assembly;
}
