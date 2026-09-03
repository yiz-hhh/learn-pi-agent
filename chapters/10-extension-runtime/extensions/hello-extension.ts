/**
 * 教学扩展：hello 工具（Pi examples/extensions/hello.ts 简化版，无 defineTool/TypeBox）。
 * 演示 Extend 能力（registerTool）：扩展工具被 wrapper 注入 ctx 后进入循环的 context.tools。
 */
import type { ExtensionAPI } from "../src/extension-api.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "hello",
    description: "向指定名字打招呼",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "要问候的名字" } },
      required: ["name"],
    },
    async execute(args) {
      return { content: `Hello, ${String(args.name)}!`, details: { greeted: args.name } };
    },
  });
}
