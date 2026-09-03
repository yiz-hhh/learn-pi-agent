/**
 * 教学扩展：危险工具集（被 guard 拦截的演示对象）。
 * delete_file：删除单个文件（演示用临时文件）；被 guard 的 tool_call 拦截时不会执行。
 * 说明：只删除单个文件，不做递归；guard 拦截后 execute 根本不触发。
 */
import { rm } from "node:fs/promises";
import type { ExtensionAPI } from "../src/extension-api.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delete_file",
    description: "删除指定文件（危险操作，会被 guard 拦截）",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要删除的文件路径" } },
      required: ["path"],
    },
    async execute(args) {
      const path = String(args.path);
      await rm(path, { force: true });
      return { content: `已删除 ${path}` };
    },
  });
}
