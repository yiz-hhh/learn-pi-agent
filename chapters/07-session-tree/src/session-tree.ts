/**
 * 07 章核心（Phase 2）：Entry 树会话（Reduce it，精读 Pi SessionManager / harness/session 的最小复刻）。
 *
 * 07 章两阶段教学：
 * - Phase 1（session.ts，脚手架）：线性 JSONL 会话（头 + 消息行）。用它暴露线性历史的三个毛病
 *   （无法从历史节点重新开始、无法保留分支、只有「最后」没有「位置」），然后升级；
 * - Phase 2（本文件 + jsonl.ts）：Entry 树会话，与 Pi 的版本演进一致
 *   （session-format.md：Version 1 linear → Version 2 tree）。
 *
 * 树机制全部锚定 Pi：
 * - Entry{type,id,parentId,timestamp}：EntryBase（harness/session/types.ts L14-20）+ coding-agent v3 格式
 *   （docs/session-format.md：id/parentId 成树、原地分支不建新文件）
 * - current leaf：SessionManager.leafId（session-manager.ts L1196），append 写 leaf 并前移（_appendEntry L1045-1050）
 * - branch：只移 leaf 指针，不改删任何 entry（L1361-1366）
 * - getBranch：沿 parentId 向根查询后反序（L1261-1271）
 * - getTree：孤儿 entry 当根、children 按 timestamp 排序（L1311-1349）
 * - leaf 恢复：加载后 leaf = 文件最后一条 entry（_buildIndex L959-978）
 *
 * 剪裁（教学简化）：seq 字段（v2 架构 read-side 分配）、lane/durable operation/crash recovery
 * 全量、Sqlite backend、memory.ts/context.ts 不教；branch_summary 等非 message entry 教学不展开，
 * compaction entry 的教学实现见 08 章。
 */
import { randomUUID } from "node:crypto";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";

/** Entry 基座：Pi EntryBase（harness/session/types.ts L14-20）的教学子集（无 seq，ISO 时间戳与 v3 格式一致）。 */
export interface EntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string; // ISO（coding-agent v3 格式：new Date().toISOString()）
}

/** 消息 entry：承载对话消息（Pi MessageEntry）。 */
export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
}

/** 自定义 entry：扩展状态持久化，不参与 LLM 上下文（Pi CustomEntry，session-format.md）。 */
export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

/** Entry 联合：教学子集（message/custom；model_change/branch_summary 等教学不展开）。 */
export type Entry = MessageEntry | CustomEntry;

/** 树节点（getTree 用）：entry + 子节点。 */
export interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

/**
 * 生成唯一短 ID（8 位 hex，碰撞检查）：Pi generateId（session-manager.ts L221，randomUUID().slice(0,8)）。
 */
export function generateId(existing: ReadonlySet<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

/**
 * 会话树：append-only entry 树 + current leaf 指针（Pi SessionManager 的教学子集）。
 * 所有写入都 append（entry 从不修改删除），分支只移动 leaf 指针。
 */
export class TreeSession {
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private _leafId: string | null = null;

  /** 当前 leaf（Pi getLeafId，L1196）。 */
  getLeafId(): string | null {
    return this._leafId;
  }

  /** 按 id 查 entry（Pi getEntry，L1204）。 */
  getEntry(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  /** 全部 entry（文件顺序，不含头；Pi getEntries，L1302）。 */
  getEntries(): Entry[] {
    return [...this.entries];
  }

  /** entry 的直接子节点（Pi getChildren，L1211）。 */
  getChildren(parentId: string): Entry[] {
    return this.entries.filter((e) => e.parentId === parentId);
  }

  /** append 消息为当前 leaf 的子节点，然后 leaf 前移；返回完整 entry（Pi appendMessage L1058 + _appendEntry L1045）。 */
  appendMessage(message: Message): MessageEntry {
    return this.append({ type: "message", message } as MessageEntry);
  }

  /** append 自定义 entry（扩展状态，不进 LLM 上下文；Pi appendCustomEntry L1123）。 */
  appendCustomEntry(customType: string, data?: unknown): CustomEntry {
    return this.append({ type: "custom", customType, data } as CustomEntry);
  }

  /** 分支：把 leaf 移到历史 entry。只移指针，不改删任何 entry（Pi branch L1361-1366）。 */
  branch(entryId: string): void {
    if (!this.byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
    this._leafId = entryId;
  }

  /** 重置 leaf 为 null（下次 append 生成新根；Pi resetLeaf L1373）。 */
  resetLeaf(): void {
    this._leafId = null;
  }

  /** 向根查询：从 fromId（默认 leaf）沿 parentId 走到根，返回 root→leaf 顺序（Pi getBranch L1261-1271）。 */
  getBranch(fromId?: string): Entry[] {
    const path: Entry[] = [];
    const startId = fromId ?? this._leafId;
    let current = startId ? this.byId.get(startId) : undefined;
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  /** 分支路径上的消息（buildSessionContext 的教学版：custom 不产消息）。 */
  getMessages(): Message[] {
    return this.getBranch()
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message);
  }

  /** 树结构：孤儿（parent 缺失）当根，children 按 timestamp 排序（Pi getTree L1311-1349）。 */
  getTree(): TreeNode[] {
    const nodeMap = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];
    for (const entry of this.entries) {
      nodeMap.set(entry.id, { entry, children: [] });
    }
    for (const entry of this.entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node); // 孤儿当根（Pi L1332-1335）
        }
      }
    }
    const stack: TreeNode[] = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort((a, b) => a.entry.timestamp.localeCompare(b.entry.timestamp));
      stack.push(...node.children);
    }
    return roots;
  }

  /** 从已解析的 entry 列表重建（加载用）：leaf = 最后一条 entry（Pi _buildIndex L959-978）。 */
  load(entries: Entry[]): void {
    this.entries = [...entries];
    this.byId.clear();
    this._leafId = null;
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
      this._leafId = entry.id;
    }
  }

  /** 内部写入：分配 id/parentId/timestamp，追加并前移 leaf（Pi _appendEntry L1045-1050）。 */
  private append<T extends Entry>(entry: T): T {
    const full: Entry = {
      ...entry,
      id: generateId(new Set(this.byId.keys())),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    this.byId.set(full.id, full);
    this._leafId = full.id;
    return full as T;
  }
}
