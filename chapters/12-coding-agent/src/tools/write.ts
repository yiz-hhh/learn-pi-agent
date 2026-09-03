/**
 * 12 章产品工具：write_file（写入文件，Pi 蓝本 harness/tools/write.ts 全文 39 行）。
 *
 * 与 Pi 对齐的机制：
 * - parameters schema（Pi writeSchema L8-11）：path / content
 * - 自动创建父目录（Pi 描述原文：Automatically creates parent directories，env.writeFile 语义）
 * - 成功回执带字节数（Pi L33：Successfully wrote ${content.length} bytes to ${path}）
 * - 写入失败抛错，由 01 章流水线转错误 toolResult
 *
 * 教学剪裁：
 * - 文件并发写队列（Pi withFileMutationQueue，file-mutation-queue.ts 全文 56 行）不教，
 *   同一路径的并发写由教学简化环境自行保证（demo/测试串行）
 * - env 抽象（Pi ExecutionEnv.writeFile）简化为直接 fs 调用
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** 创建 write_file 工具（Pi createWriteTool，harness/tools/write.ts）。 */
export function createWriteFileTool(cwd: string): Tool<{ path: string; content: string }> {
  return {
    name: "write_file",
    description: "写入文件内容。文件不存在则创建，存在则覆盖。自动创建父目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要写入的文件路径（相对或绝对）" },
        content: { type: "string", description: "写入的完整内容" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      const absolutePath = resolveToolPath(cwd, args.path);
      try {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, args.content, "utf-8");
      } catch (error) {
        throw new Error(`无法写入文件: ${args.path}（${describeError(error)}）`);
      }
      return { content: `成功写入 ${args.content.length} 字节到 ${args.path}` };
    },
  };
}
