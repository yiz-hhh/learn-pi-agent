/**
 * 案例二：Plan Mode（官方 No plan mode 的 extension 版）。
 * Pi 锚点：examples/extensions/plan-mode/（index.ts 390 行 + utils.ts 168 行）。
 *
 * 官方 No 清单原话（coding-agent README L505）：
 * "No plan mode. Write plans to files, or build it with [extensions], or install a package."
 *
 * Pi 机制：
 * - bash 白名单判定（utils.ts isSafeCommand L97-101：黑名单 DESTRUCTIVE_PATTERNS L7-41
 *   优先，白名单 SAFE_PATTERNS L44-95 才放行）
 * - /plan 命令切换（index.ts L141-144 registerCommand）+ setActiveTools 工具切换
 *   （L104-114：进入时保存 toolsBeforePlanMode，plan 模式禁用 mutation 工具、补充只读工具）
 * - tool_call 拦截（L164-174：非白名单 bash 命令 block）
 * - 只读上下文注入（教学走 context 事件 call-time；Pi 走 before_agent_start 注入
 *   [PLAN MODE ACTIVE] 持久 custom message L201-228）
 *
 * 教学子集：白名单判定 + /plan 切换（10 章 ctx.setActiveTools 动作，写入 running
 * agent.state.tools）+ tool_call 拦截 + context 注入。
 * 不教：UI widget/status（L59-84）、extractTodoItems/[DONE:n] 计划跟踪、registerShortcut/Flag、
 * questionnaire、appendEntry 状态持久化、system prompt 重建（Pi setActiveToolsByName 附带）。
 */
import type { ExtensionAPI } from "../../10-extension-runtime/src/extension-api.ts";

/** 破坏性模式（Pi plan-mode/utils.ts L7-41 教学子集）。 */
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bsudo\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bgit\s+(add|commit|push|reset|checkout)/i,
];

/** 只读安全命令（Pi plan-mode/utils.ts L44-95 教学子集）。 */
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*grep\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*find\b/,
];

/** 纯函数：命令是否在白名单（Pi utils.ts isSafeCommand L97-101）。 */
export function isSafeCommand(command: string): boolean {
  return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

/** plan 模式工具集（Pi PLAN_MODE_TOOLS L22 教学子集：只读探索够用的最小集，subagent 委托调研是只读操作）。 */
export const PLAN_MODE_TOOLS = ["bash", "calculator", "subagent"];

/** 默认禁用的 mutation 工具（Pi PLAN_MODE_DISABLED_TOOLS L24 教学子集：本基线唯一的写类工具是 10 章 delete_file）。 */
const DEFAULT_DISABLED_TOOL_NAMES = ["delete_file"];

/** 工厂选项：教学 fixture 可注入额外禁用工具名（测试用 write_fixture；Pi 为硬编码常量）。 */
export interface PlanModeOptions {
  disabledToolNames?: string[];
}

/** 扩展工厂：/plan 切换 + bash 白名单拦截 + 只读上下文注入。 */
export default function (pi: ExtensionAPI, options: PlanModeOptions = {}): void {
  let enabled = false;
  let toolsBeforePlanMode: string[] | undefined;
  const disabledToolNames = new Set([...DEFAULT_DISABLED_TOOL_NAMES, ...(options.disabledToolNames ?? [])]);

  /** plan 模式工具集 = 当前 active 去掉禁用工具 + 补充只读工具（Pi getPlanModeTools L90-95）。 */
  function computePlanTools(activeToolNames: string[]): string[] {
    return [...new Set([...activeToolNames.filter((name) => !disabledToolNames.has(name)), ...PLAN_MODE_TOOLS])];
  }

  pi.registerCommand("plan", {
    description: "切换 plan 模式（只读探索）",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        // 进入：动态保存当前工具集，切换为只读子集（Pi L104-109：toolsBeforePlanMode 保存 + setActiveTools）
        toolsBeforePlanMode = ctx.getActiveTools();
        ctx.setActiveTools(computePlanTools(toolsBeforePlanMode));
      } else {
        // 退出：恢复进入前的工具集（Pi restoreNormalModeTools L111-114；无保存记录时不动工具集）
        ctx.setActiveTools(toolsBeforePlanMode ?? ctx.getActiveTools());
        toolsBeforePlanMode = undefined;
      }
      console.log(`[plan] ${enabled ? "只读模式已开启（mutation 工具被禁用）" : "只读模式已关闭"}`);
    },
  });

  pi.on("tool_call", async (event) => {
    if (!enabled || event.toolCall.name !== "bash") return undefined;
    const command = String((event.args as { command?: unknown }).command ?? "");
    if (!isSafeCommand(command)) {
      return { block: true, reason: `plan 模式：命令不在白名单（${command}）。用 /plan 关闭只读模式后执行。` };
    }
    return undefined;
  });

  // 只读探索上下文注入（Pi before_agent_start 注入 [PLAN MODE ACTIVE] 的教学简化：走 context 事件，call-time 不持久化）
  pi.on("context", async ({ messages }) => {
    if (!enabled) return undefined;
    return [
      ...messages,
      { role: "user" as const, text: "[PLAN MODE ACTIVE] 只读探索模式：不能修改文件。先调研，再输出带编号的 Plan: 节。" },
    ];
  });
}
