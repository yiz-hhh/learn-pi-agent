/**
 * 00 章共享基座：演示工具集（echo + calculator），供全部章节复用。
 * Pi 锚点：工具即 `context.tools` 数组（types.ts L418），查找在 `prepareToolCall` L607。
 */
import type { Tool } from "./types.ts";

export function createEchoTool(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "原样返回你传入的 text 字段",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
    async execute({ text }) {
      return { content: text };
    },
  };
}

export function createCalculatorTool(): Tool<{ a: number; b: number }> {
  return {
    name: "calculator",
    description: "计算两个数的和 a + b",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "第一个加数" },
        b: { type: "number", description: "第二个加数" },
      },
      required: ["a", "b"],
    },
    async execute({ a, b }) {
      return { content: String(a + b) };
    },
  };
}

export function createDemoTools(): Tool[] {
  return [createEchoTool(), createCalculatorTool()];
}
