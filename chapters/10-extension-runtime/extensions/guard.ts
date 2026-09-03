/**
 * 教学扩展：guard 拦截（Intercept 能力）。
 * 订阅 tool_call 事件，危险工具（delete_file）直接 block（Pi permission-gate 的最小版，
 * 完整案例在 11 章 Extension Composition）。
 */
import type { ExtensionAPI } from "../src/extension-api.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolCall.name === "delete_file") {
      return { block: true, reason: "guard 扩展：禁止删除文件（危险操作）" };
    }
    return undefined;
  });
}
