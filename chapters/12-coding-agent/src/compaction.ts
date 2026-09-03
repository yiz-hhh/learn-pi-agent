/**
 * 08 章核心（compaction 层）：Session Compaction——切点、摘要与最小编排。
 * 12 章组装复用：本文件与 08 章对应文件保持一致（Product Assembly 的压缩层同步副本）。
 *
 * 复刻的机制（全部锚定 coding-agent 产品栈，非低层 harness）：
 * - `estimateTokens`（compaction.ts L266）：token 估算（教学用字符 / 4 粗估；Pi 优先 usage 锚定）
 * - `shouldCompact`（L235）：估算超阈值（教学 trigger 简化）
 * - `findCutPoint`（L403-461）：从后往前累积 token 选切点；合法切点 = user/assistant
 *   （教学 Message 三角色子集，等价于 Pi isCutPointMessage L308-321 的子集——
 *   Pi 还允许 bashExecution/custom/branchSummary/compactionSummary，教学无这些角色），
 *   toolResult 永不作为切点。切在 assistant(toolCall) 时其后的 toolResult 位于保留段。
 *   Split Turn 的 turn 前缀单独摘要（Pi TURN_PREFIX_SUMMARIZATION_PROMPT L835-848）教学不恢复。
 * - `summarize`：LLM 生成摘要（Pi compact L858-964 的失败安全子集：error/aborted/流异常 → null）
 * - `compactSession`：最小编排（Pi AgentSession.compact 的 harness seam 教学版，见函数注释）
 *
 * 层次（08 章核心教学结构，与 06 章明确划界）：
 *   Session Tree → buildSessionContext（重建投影）→ canonical state.messages
 *   → 06 章 transformContext → call-time messages。
 * Compaction 不经过 transformContext；transformContext 仍是 06 章的 extension 注入接缝。
 */
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";
import { TreeSession, type Entry, sessionEntryToContextMessages } from "./session-tree.ts";

/** 摘要生成用的系统提示（Pi SUMMARIZATION_SYSTEM_PROMPT 的教学最小版）。 */
const SUMMARIZATION_SYSTEM_PROMPT =
  "你是一个对话摘要助手。阅读用户与 AI 助手的对话，产出一段结构化摘要。" +
  "保留关键事实、文件路径、函数名、工具调用结果与错误信息。用简洁的中文总结。";

/** 压缩设置（Pi CompactionSettings L126-130 的教学子集；trigger 简化）。 */
export interface CompactionSettings {
  /** 触发压缩的估算 token 阈值（Pi reserveTokens 语义的教学映射）。 */
  limitTokens: number;
  /** 压缩后保留的最近消息估算 token 数（Pi keepRecentTokens）。 */
  keepRecentTokens: number;
}

/** token 估算（Pi estimateTokens L266 的字符/4 版；Pi 优先 usage 锚定，教学无 usage）。 */
export function estimateTokens(message: Message): number {
  let chars = 0;
  if (message.text) chars += message.text.length;
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      chars += tc.name.length + JSON.stringify(tc.arguments).length;
    }
  }
  if (message.errorMessage) chars += message.errorMessage.length;
  return Math.ceil(chars / 4);
}

/** 是否应压缩（Pi shouldCompact L235：contextTokens > contextWindow - reserveTokens 的教学映射）。 */
export function shouldCompact(messages: Message[], limitTokens: number): boolean {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  return total > limitTokens;
}

/**
 * 从后往前找合法切点（Pi findCutPoint L403-461 的教学子集）：
 * 合法切点 = user 或 assistant（教学三角色中排除 toolResult；Pi 的合法集是超集，
 * 教学无 bashExecution/custom/摘要消息角色，故子集即完备）。
 * 累积达 keepRecentTokens 后，取「该位置或其后第一个合法切点」。
 * - 切在 assistant(toolCall) 时，其后的 toolResult 都位于保留段（配对不被拆开）
 * - 阈值区全为 toolResult（无合法切点）→ 返回 0 不压缩（Pi 无合法切点回退 startIndex 同效）
 * 返回 0 也覆盖「历史本身不超过 keep 窗口」的情形（无需压缩）。
 */
export function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // 从 i 往后找最近的合法切点（Pi L393-399：cutPoints[c] >= i 的第一个）
      for (let j = i; j < messages.length; j++) {
        if (messages[j].role !== "toolResult") {
          return j;
        }
      }
      return 0; // 阈值区全 toolResult → 不压缩
    }
  }
  return 0;
}

/**
 * 用 LLM 生成摘要（Pi compact 失败安全的子集，无重试）。
 * 失败（stopReason=error/aborted 或流异常）→ 返回 null（调用方不写 CompactionEntry）。
 * 教学额外守卫：空文本摘要视为失败（Pi 正常 stopReason 下允许空摘要）。
 */
export async function summarize(messages: Message[], llm: LLMAdapter, model: string): Promise<string | null> {
  let summary = "";
  let failed = false;
  try {
    for await (const event of llm.complete({
      model,
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages,
      tools: [],
    })) {
      if (event.type === "done") {
        // Pi getSummarizationFailure L545-553：error 与 aborted 均视为失败（aborted 的碎片文本不得当摘要）
        if (event.partial.stopReason === "error" || event.partial.stopReason === "aborted") {
          failed = true;
        }
        summary = event.partial.text ?? "";
      }
    }
  } catch {
    // 流异常（网络中断等）→ 失败安全：不击穿压缩流程
    failed = true;
  }
  if (failed || summary.trim() === "") {
    return null;
  }
  return summary;
}

/** compact 成功的结果（Pi CompactionResult L88-97 的教学子集）。 */
export interface CompactionResult {
  /** 被压前缀的摘要（持久化进 CompactionEntry.summary）。 */
  summary: string;
  /** 压缩后第一个被保留 entry 的 id（持久化进 CompactionEntry.firstKeptEntryId）。 */
  firstKeptEntryId: string;
  /** 压缩前 canonical context 的估算 token 数（持久化进 CompactionEntry.tokensBefore）。 */
  tokensBefore: number;
  /** compact 成功后重建的 canonical context（供调用方刷新 agent state）。 */
  context: Message[];
}

/**
 * Session Compaction 最小编排（Pi AgentSession.compact 的 harness seam 教学版）：
 * 1. 取 active path 的 canonical messages（buildSessionContext）
 * 2. shouldCompact：不超限 → null（什么都不做）
 * 3. findCutPoint：切点 0（无安全切点）→ null
 * 4. summarize 旧前缀；失败 → null（Session 与 agent state 均不变）
 * 5. cutIndex → firstKeptEntryId（跨 run 持久化的 Session 位置；cutIndex 只是本次运行的临时位置）
 * 6. appendCompaction：parentId = 旧 leaf，leaf 前移；旧 entries 一条不动
 * 7. 重建 canonical context 随结果返回，由调用方刷新 agent state
 *    （Pi agent-session.ts L2004-2007/L2329-2332：agent.state.messages = buildSessionContext().messages）
 *
 * 返回 null 的三种情形对 Session 零副作用。
 * 教学范围：只处理 active path 尚无 compaction entry 的首次压缩；
 * Pi 的再次压缩（prepareCompaction boundaryStart + UPDATE prompt 摘要链）不恢复。
 */
export async function compactSession(
  session: TreeSession,
  llm: LLMAdapter,
  model: string,
  settings: CompactionSettings,
): Promise<CompactionResult | null> {
  const path = session.getBranch();
  if (path.some((entry) => entry.type === "compaction")) {
    return null; // 教学范围：active path 已有 compaction entry 的再次压缩不恢复
  }

  const messages = session.buildSessionContext();
  if (!shouldCompact(messages, settings.limitTokens)) {
    return null;
  }

  const cutIndex = findCutPoint(messages, settings.keepRecentTokens);
  if (cutIndex === 0) {
    return null; // 无安全切点 / 无需压缩
  }

  const oldPart = messages.slice(0, cutIndex);

  const summary = await summarize(oldPart, llm, model);
  if (summary === null) {
    return null; // 摘要失败 → 不 append，Session 与 canonical state 均不变
  }

  // cutIndex 是消息空间的临时位置；映射回 entry 得到跨 run 持久化的 Session 位置
  // （路径上无 compaction entry 时 message/custom entry 与消息 1:0|1 对应，映射唯一）
  let messageOffset = 0;
  let firstKeptEntry: Entry | undefined;
  for (const entry of path) {
    const projected = sessionEntryToContextMessages(entry);
    if (messageOffset <= cutIndex && cutIndex < messageOffset + projected.length) {
      firstKeptEntry = entry;
      break;
    }
    messageOffset += projected.length;
  }
  if (!firstKeptEntry) {
    return null; // 理论上不可达（cutIndex < messages.length）；防御保留
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const tokensBefore = messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  session.appendCompaction(summary, firstKeptEntryId, tokensBefore);
  const context = session.buildSessionContext();

  return { summary, firstKeptEntryId, tokensBefore, context };
}
