/**
 * 07 章 Phase 2：Entry 树 JSONL 持久化（对应 coding-agent v3 文件格式，docs/session-format.md）。
 * 10 章组装复用：本文件与 07 章 jsonl.ts 保持同步。
 *
 * 与 Phase 1（session.ts）的格式演进：
 * - v1（Phase 1 脚手架）：头行 + 消息行，线性；
 * - v2（本文件）：头行 + entry 行，id/parentId 成树，原地分支不建新文件。
 * Pi 的版本演进相同（session-format.md：Version 1 linear → Version 2 tree）。
 *
 * 容错沿用 Phase 1：损坏行跳过继续、缺尾换行 append 先补换行；
 * Pi 的原子修复（harness/session/jsonl/storage.ts L86-106 torn tail 重写）教学不展开。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TreeSession, type Entry } from "./session-tree.ts";

/** 会话头（v2 = Entry 树格式）。 */
export interface TreeSessionHeader {
  version: 2;
  systemPrompt: string;
  model: string;
}

/** 追加 entry 行到会话文件（Pi JsonlSessionRepo append 语义 + Phase 1 容错）。 */
export function appendEntries(file: string, header: TreeSessionHeader, entries: Entry[]): void {
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
  for (const entry of entries) {
    lines.push(JSON.stringify(entry));
  }
  writeFileSync(file, lines.join("\n") + "\n", { flag: "a" });
}

/** 从会话文件恢复树（头 + entry 行；文件不存在/头损坏返回 null）。leaf = 最后一条 entry（Pi _buildIndex L959）。 */
export function loadTree(file: string): { header: TreeSessionHeader; tree: TreeSession } | null {
  if (!existsSync(file)) {
    return null;
  }
  const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return null;
  }
  let header: TreeSessionHeader;
  try {
    header = JSON.parse(lines[0]) as TreeSessionHeader;
    if (typeof header?.systemPrompt !== "string" || header?.version !== 2) {
      return null; // header 损坏（非 v2 会话文件或写了一半）→ 不可恢复
    }
  } catch {
    return null;
  }
  // 逐行容错，损坏行跳过，不让单行问题杀死整个会话
  const entries: Entry[] = [];
  for (const line of lines.slice(1)) {
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      console.warn("会话文件存在损坏行，已跳过:", line.slice(0, 60));
    }
  }
  const tree = new TreeSession();
  tree.load(entries);
  return { header, tree };
}
