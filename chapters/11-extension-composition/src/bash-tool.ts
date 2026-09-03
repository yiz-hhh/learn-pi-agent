/**
 * 教学最小 bash 工具（11 章案例的拦截对象；完整产品工具集在 12 章）。
 *
 * 设计要点：bash 工具本身**不设防**（执行任意命令）。这正是教学点：
 * 权限策略不在工具里，在扩展里（permission-gate / plan-mode 在 execute 前拦截）。
 * 危险命令（rm -rf 等）在教学中从不真执行：demo/测试只发安全命令，危险命令一律被拦截。
 */
import { execFileSync } from "node:child_process";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";

/** 创建 bash 工具（Pi harness/tools/bash.ts 的教学最小版，12 章做完整版）。 */
export function createBashTool(): Tool<{ command: string }> {
  return {
    name: "bash",
    description: "执行 shell 命令",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
    async execute(args) {
      const stdout = execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf-8", timeout: 5000 });
      return { content: stdout.trim() || "(无输出)" };
    },
  };
}
