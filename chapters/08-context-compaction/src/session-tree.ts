/**
 * 08 章核心（session 层）：07 章 Entry 树快照 + CompactionEntry 与重建投影。
 *
 * 07 章基线（快照，机制不变，锚点沿用）：
 * - Entry{type,id,parentId,timestamp}：coding-agent v3 SessionEntryBase 子集
 * - append 写 leaf 并前移（Pi _appendEntry session-manager.ts L1045-1050）
 * - branch：只移 leaf 指针，不改删任何 entry（L1361-1366）
 * - getBranch：沿 parentId 向根查询后反序（L1261-1271）
 * - getTree / load：沿用 07 章
 *
 * 08 章新增（全部锚定 coding-agent 产品栈 session-manager.ts，非低层 harness）：
 * - CompactionEntry（L69-80 教学子集：summary/firstKeptEntryId/tokensBefore；
 *   details/usage/fromHook 剪裁）
 * - appendCompaction（L1097-1120）：与普通 Entry 完全相同的 append 机制，
 *   parentId = 当前 leaf，append 后 leaf 前移。不做任何删除/改写/side channel。
 * - buildContextEntries（L418-454）：active path → latest compaction →
 *   [compaction] + 从 firstKeptEntryId 起的保留 entries + compaction 之后全部。
 *   firstKeptEntryId 找不到时不抛错，降级为 [compaction] + 之后（Pi 同款宽容）。
 * - buildSessionContext（L461-470）：buildContextEntries → 逐 entry 投影 → Message[]。
 * - sessionEntryToContextMessages（L383-408 子集）：compaction entry 投影为
 *   带标记的 summary 消息（Pi 内部 role=compactionSummary → provider user；
 *   教学 Message 三角色无该 role，直接投影为 user + 前缀/后缀文本）。
 *
 * Compaction as an Entry：压缩以「追加一个持久化 entry」为形态；
 * 历史不删不改（getEntries 契约与 Pi L1297-1304 一致），缩短 context 靠重建投影。
 *
 * 采用 firstKeptEntryId 模型（产品栈），不采用低层 harness 的 retainedTail 快照模型。
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

/**
 * 压缩 entry（Pi CompactionEntry，session-manager.ts L69-80 的教学子集）：
 * - summary：被压前缀的 LLM 摘要（持久化的压缩物）
 * - firstKeptEntryId：压缩后第一个被保留 entry 的 id（重建投影的切片开关）
 * - tokensBefore：压缩前 canonical context 的估算 token 数
 * 剪裁：details/usage/fromHook 不恢复（扩展/成本元数据，教学不展开）。
 */
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/** Entry 联合：教学子集（message/custom/compaction；model_change/branch_summary 等教学不展开）。 */
export type Entry = MessageEntry | CustomEntry | CompactionEntry;

/** 树节点（getTree 用）：entry + 子节点。 */
export interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

/** 摘要消息标记（Pi coding-agent messages.ts L11-20，逐字一致）。 */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

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
 * 单个 entry → LLM 上下文消息（Pi sessionEntryToContextMessages L383-408 的教学子集）。
 * - message → 原消息
 * - compaction → 带标记的 user 摘要消息（教学投影，见文件头 divergence 说明）
 * - custom → 不产消息（扩展状态不进 LLM 上下文）
 */
export function sessionEntryToContextMessages(entry: Entry): Message[] {
  if (entry.type === "message") {
    return [entry.message];
  }
  if (entry.type === "compaction") {
    return [{ role: "user", text: COMPACTION_SUMMARY_PREFIX + entry.summary + COMPACTION_SUMMARY_SUFFIX }];
  }
  return [];
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

  /** 全部 entry（文件顺序，不含头；Pi getEntries，L1302——append-only，返回浅拷贝）。 */
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

  /**
   * append 压缩 entry 为当前 leaf 的子节点，然后 leaf 前移（Pi appendCompaction L1097-1120）。
   * 语义锁定：parentId = 旧 leaf；append 后 leaf = CompactionEntry.id。
   * 与普通 append 共用同一机制：不删除、不修改任何旧 entry，不写回旧 MessageEntry。
   */
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): CompactionEntry {
    return this.append({ type: "compaction", summary, firstKeptEntryId, tokensBefore } as CompactionEntry);
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

  /**
   * 07 章旧接口：分支路径上的 message entry 直接投影（不做 compaction 感知）。
   * 08 章的 canonical reconstruction 是 buildSessionContext()；
   * 本接口保留供 07 章语义对照（无 compaction 时两者等价，测试锁定）。
   */
  getMessages(): Message[] {
    return this.getBranch()
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message);
  }

  /**
   * 重建投影第一层（Pi buildContextEntries L418-454 的教学子集）：
   * active path 上取【位置最靠后】的 compaction entry（多个只认 latest）；
   * 结果 = [compaction] + path 中 firstKeptEntryId 起的 entries + compaction 之后的全部 entries。
   * firstKeptEntryId 找不到：不抛错，降级为 [compaction] + 之后（Pi 同款宽容）。
   * 无 compaction：返回完整 path（与 07 章行为等价）。
   */
  buildContextEntries(): Entry[] {
    const path = this.getBranch();

    let compaction: CompactionEntry | null = null;
    for (const entry of path) {
      if (entry.type === "compaction") {
        compaction = entry; // 覆盖赋值 → path 上最后一个 compaction 生效
      }
    }
    if (!compaction) {
      return path;
    }

    const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
    if (compactionIndex < 0) {
      return path;
    }

    const result: Entry[] = [compaction];
    let foundFirstKept = false;
    for (let i = 0; i < compactionIndex; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        result.push(entry);
      }
    }
    result.push(...path.slice(compactionIndex + 1));
    return result;
  }

  /**
   * 重建投影第二层（Pi buildSessionContext L461-470 的教学子集）：
   * buildContextEntries → 逐 entry 投影 → canonical Message[]。
   * 这是 08 章「active path → canonical messages」的唯一切片点：
   * 压缩只改变这里的结果，不改变树里任何数据。
   */
  buildSessionContext(): Message[] {
    return this.buildContextEntries().flatMap(sessionEntryToContextMessages);
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
