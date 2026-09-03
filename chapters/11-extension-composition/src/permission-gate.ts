/**
 * 案例一：Permission Gate（官方 No permission popups 的 extension 版）。
 * Pi 锚点：examples/extensions/permission-gate.ts（34 行全文）。
 *
 * 官方 No 清单原话（coding-agent README L503）：
 * "No permission popups. Run in a container, or build your own confirmation flow with extensions."
 *
 * Pi 机制（permission-gate.ts）：危险模式匹配（L11 三个正则）→ on("tool_call") 拦截 bash
 * （L13-33）→ 无 UI 时默认 block（L20-23），有 UI 时用户选择（L25-29）。
 * 教学版：hasUI=false（TUI 白名单外），决策抽象为纯函数 decidePermission（可测），
 * 放行路径由 allow 参数覆盖（模拟用户确认）。
 */
import type { ExtensionAPI } from "../../10-extension-runtime/src/extension-api.ts";

/** 危险命令模式（Pi permission-gate.ts L11）。 */
export const DANGEROUS_PATTERNS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

/** 纯函数：命令是否命中危险模式。 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

/** 纯函数：放行/拦截决策（Pi L19-30 语义：无 UI 默认拒绝；allow 模拟用户确认）。 */
export function decidePermission(command: string, allow: boolean): { block: boolean; reason?: string } {
  if (!isDangerousCommand(command)) return { block: false };
  if (allow) return { block: false };
  return { block: true, reason: "危险命令被拦截（permission-gate：无 UI 确认，默认拒绝）" };
}

/** 扩展工厂：拦截 bash 危险命令（教学 hasUI=false，危险即拦）。 */
export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolCall.name !== "bash") return undefined;
    const command = String((event.args as { command?: unknown }).command ?? "");
    const verdict = decidePermission(command, false);
    return verdict.block ? { block: true, reason: verdict.reason } : undefined;
  });
}
