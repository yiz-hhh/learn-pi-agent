/**
 * 07 章 Phase 1：线性 JSONL 会话（教学脚手架）。
 *
 * 07 章两阶段教学：先用最自然的线性方案（本文件）暴露问题，再升级到 Phase 2 的 Entry 树
 * （session-tree.ts + jsonl.ts）。本文件保留为脚手架与对照，最终机制不复用它。
 *
 * - 每条消息一行 JSON（append 追加，恢复逐行解析）
 * - 附加会话头（首行记录 systemPrompt/model，便于恢复完整上下文）
 *
 * 线性方案的三个毛病（README §2）：
 * 1. 无法从历史节点重新开始（回到第 N 条继续，只能复制文件再截断）；
 * 2. 无法保留分支（另一条路径需另开文件，两文件没有关系）；
 * 3. 会话只有「最后」没有「位置」（无法表达「当前在哪」）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";

/** 会话文件头：首行 JSON（系统提示与模型，恢复时重建上下文）。 */
export interface SessionHeader {
  version: 1;
  systemPrompt: string;
  model: string;
}

/** 会话文件：头 + 消息行。 */
export interface LoadedSession {
  header: SessionHeader;
  messages: Message[];
}

/** 追加消息到会话文件（Pi JsonlSessionRepo 的 append 语义最小版）。 */
export function appendToSession(file: string, header: SessionHeader, messages: Message[]): void {
  const lines: string[] = [];
  // 文件存在且非空才算「已有会话」；空文件（如 clearSession 后）需要重新写头
  const hasContent = existsSync(file) && readFileSync(file, "utf-8").trim() !== "";
  if (!hasContent) {
    lines.push(JSON.stringify(header));
  } else {
    // 文件存在但缺尾换行（崩溃截断等）时先补换行，避免与下一行合并成损坏 JSON
    const existing = readFileSync(file, "utf-8");
    if (!existing.endsWith("\n")) {
      writeFileSync(file, "\n", { flag: "a" });
    }
  }
  for (const message of messages) {
    lines.push(JSON.stringify(message));
  }
  writeFileSync(file, lines.join("\n") + "\n", { flag: "a" });
}

/** 从会话文件恢复（头 + 消息；文件不存在返回 null）。 */
export function loadSession(file: string): LoadedSession | null {
  if (!existsSync(file)) {
    return null;
  }
  const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return null;
  }
  let header: SessionHeader;
  try {
    header = JSON.parse(lines[0]) as SessionHeader;
    if (typeof header?.systemPrompt !== "string" || header?.version !== 1) {
      return null;  // header 损坏（非会话文件或写了一半）→ 不可恢复
    }
  } catch {
    return null;
  }
  // 逐行容错——损坏行跳过，不让单行问题杀死整个会话
  const messages: Message[] = [];
  for (const line of lines.slice(1)) {
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      console.warn("会话文件存在损坏行，已跳过:", line.slice(0, 60));
    }
  }
  return { header, messages };
}

/** 清空会话文件（开始新会话）。 */
export function clearSession(file: string): void {
  writeFileSync(file, "");
}
