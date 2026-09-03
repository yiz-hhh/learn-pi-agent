/**
 * 教学扩展：todo 工具 + /todos 命令（Pi examples/extensions/todo.ts 简化版）。
 *
 * 演示三个能力：
 * - Extend：registerTool（todo）+ registerCommand（todos）
 * - Persist：状态存工具结果的 details，从会话树分支路径重建（Pi todo.ts L114-133
 *   reconstructState 扫 getBranch()），分支时状态自动正确（07 章树价值在扩展里的兑现）
 * - Observe：on("message_end") 触发状态重建（Pi 用 session_start/session_tree 事件）
 */
import type { ExtensionAPI, ExtensionContext } from "../src/extension-api.ts";
import type { MessageEntry } from "../../07-session-tree/src/session-tree.ts";

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: string;
  todos: TodoItem[];
  nextId: number;
  error?: string;
}

export default function (pi: ExtensionAPI): void {
  let todos: TodoItem[] = [];
  let nextId = 1;
  /** 当前状态是从哪个 leaf 的分支路径重建的（Pi 无此字段，教学 leaf-change 检测用）。 */
  let stateBuiltFromLeaf: string | null = null;

  /** 从会话树分支路径重建状态（Pi todo.ts L114-133 reconstructState 的教学版）。 */
  const reconstruct = (ctx: ExtensionContext): void => {
    todos = [];
    nextId = 1;
    for (const entry of ctx.session.getBranch()) {
      if (entry.type !== "message") continue;
      const m = (entry as MessageEntry).message;
      if (m.role === "toolResult" && m.toolName === "todo") {
        const details = m.details as TodoDetails | undefined;
        if (details) {
          // 拷贝而非引用：后续 todos.push 不得污染树里存的历史 details。
          // Pi 在存储边界 structuredClone（jsonl/storage.ts L159）隔离写读，教学树不克隆，
          // 由扩展在重建时自己拷贝（aliasing 教训：状态从树推导 = 拷贝出来再改）。
          todos = [...details.todos];
          nextId = details.nextId;
        }
      }
    }
  };

  /**
   * 状态权威策略（Pi 同款：module state 是当前运行期权威，session entry 是持久化日志）：
   * 同一 leaf 上连续执行时直接改 module state——并行批次里两次 execute 都基于内存态递增，
   * 不会各自从（尚未落树 toolResult 的）旧分支重建；只有 leaf 变化（branch/restore）才重建。
   */
  const ensureState = (ctx: ExtensionContext): void => {
    const leafId = ctx.session.getLeafId();
    if (leafId === stateBuiltFromLeaf) return;
    reconstruct(ctx);
    stateBuiltFromLeaf = leafId;
  };

  // Observe：消息落树后按 leaf 检测重建（教学简化；Pi 在 session_start/session_tree 时重建）
  pi.on("message_end", async (_event, ctx) => {
    ensureState(ctx);
  });

  pi.registerTool({
    name: "todo",
    description: "管理待办列表。动作：list（列出）、add（加，text 参数）、toggle（切换，id 参数）、clear（清空）",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "list | add | toggle | clear" },
        text: { type: "string", description: "add 时的待办文本" },
        id: { type: "number", description: "toggle 时的待办编号" },
      },
      required: ["action"],
    },
    async execute(args, ctx) {
      ensureState(ctx);
      const action = String(args.action ?? "list");
      switch (action) {
        case "add": {
          const text = String(args.text ?? "");
          if (!text) {
            return { content: "错误：add 需要 text 参数", details: { action, todos, nextId, error: "text required" } as TodoDetails };
          }
          const item: TodoItem = { id: nextId++, text, done: false };
          todos.push(item);
          return { content: `已添加待办 #${item.id}: ${item.text}`, details: { action, todos: [...todos], nextId } as TodoDetails };
        }
        case "toggle": {
          const id = Number(args.id);
          const item = todos.find((t) => t.id === id);
          if (!item) {
            return { content: `错误：待办 #${id} 不存在`, details: { action, todos, nextId, error: "not found" } as TodoDetails };
          }
          item.done = !item.done;
          return { content: `待办 #${item.id} 已${item.done ? "完成" : "取消"}`, details: { action, todos: [...todos], nextId } as TodoDetails };
        }
        case "clear": {
          todos = [];
          nextId = 1;
          return { content: "待办已清空", details: { action, todos: [], nextId: 1 } as TodoDetails };
        }
        default:
          return {
            content: todos.length
              ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
              : "暂无待办",
            details: { action, todos: [...todos], nextId } as TodoDetails,
          };
      }
    },
  });

  pi.registerCommand("todos", {
    description: "查看当前分支的待办列表",
    handler: async (_args, ctx) => {
      ensureState(ctx);
      console.log(
        todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n") : "暂无待办",
      );
    },
  });
}
