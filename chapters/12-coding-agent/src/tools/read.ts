/**
 * 12 章产品工具：read_file（读取文件，Pi 蓝本 harness/tools/read.ts 全文 144 行）。
 *
 * 与 Pi 对齐的机制：
 * - parameters schema（Pi readSchema L16-20）：path / offset（1 起）/ limit
 * - 文本读取 + 行切片（Pi L98-114），offset 越界抛错（Pi L102-104）
 * - 输出截断与续读提示（Pi truncateHead L116-131：[Showing lines X-Y of N. Use offset=Z to continue.]）
 * - 读取失败抛错（Pi L55 getOrThrow），由 01 章流水线转错误 toolResult
 *
 * 教学剪裁：
 * - 图像读取（Pi L56-95：mime 检测 + base64 附件）不教，纯文本工具
 * - env 抽象（Pi ExecutionEnv.readBinaryFile，可换远程后端）简化为直接 fs 调用
 * - 截断上限教学自取 500 行 / 64KB（Pi 实际 DEFAULT_MAX_LINES=2000、DEFAULT_MAX_BYTES=50KB，
 *   harness/utils/truncate.ts L11-12；教学自定值，非 Pi 减半）
 */
import { readFile } from "node:fs/promises";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** 默认截断上限：行数与字节数任一超限即截断（Pi DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES 教学子集）。 */
export const READ_MAX_LINES = 500;
export const READ_MAX_BYTES = 64 * 1024;

/** 创建 read_file 工具（Pi createReadTool，harness/tools/read.ts）。 */
export function createReadFileTool(cwd: string): Tool<{ path: string; offset?: number; limit?: number }> {
  return {
    name: "read_file",
    description:
      "读取文件内容（文本）。可用 offset/limit 按行切片；超长输出截断并提示续读 offset。读取失败返回错误结果。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要读取的文件路径（相对或绝对）" },
        offset: { type: "number", description: "起始行号（1 起，默认第 1 行）" },
        limit: { type: "number", description: "最多读取的行数" },
      },
      required: ["path"],
    },
    async execute(args) {
      const absolutePath = resolveToolPath(cwd, args.path);
      let content: string;
      try {
        content = await readFile(absolutePath, "utf-8");
      } catch (error) {
        throw new Error(`无法读取文件: ${args.path}（${describeError(error)}）`);
      }
      const allLines = content.split("\n");
      const startLine = args.offset ? Math.max(0, args.offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`偏移 ${args.offset} 超出文件末尾（共 ${allLines.length} 行）`);
      }
      const endLine = args.limit !== undefined ? Math.min(startLine + args.limit, allLines.length) : allLines.length;
      const selected = allLines.slice(startLine, endLine);
      const { text, truncated, keptLines } = truncateHead(selected);

      let output = text;
      if (truncated) {
        const shownEnd = startLineDisplay + keptLines - 1;
        output += `\n\n[显示第 ${startLineDisplay}-${shownEnd} 行，共 ${allLines.length} 行（上限 ${READ_MAX_LINES} 行 / ${READ_MAX_BYTES / 1024}KB）。用 offset=${shownEnd + 1} 继续。]`;
      } else if (args.limit !== undefined && endLine < allLines.length) {
        output += `\n\n[文件还有 ${allLines.length - endLine} 行。用 offset=${endLine + 1} 继续。]`;
      }
      return {
        content: output,
        details: truncated
          ? { truncation: { truncated: true, outputLines: keptLines, totalLines: allLines.length } }
          : undefined,
      };
    },
  };
}

/** 头部截断：行数或字节数任一超限时保留头部（Pi utils/truncate.ts truncateHead 的教学子集）。 */
function truncateHead(lines: string[]): { text: string; truncated: boolean; keptLines: number } {
  let bytes = 0;
  let kept = 0;
  for (const line of lines) {
    const lineBytes = new TextEncoder().encode(line).length + 1; // +1 换行符
    if (kept >= READ_MAX_LINES || bytes + lineBytes > READ_MAX_BYTES) break;
    bytes += lineBytes;
    kept++;
  }
  const truncated = kept < lines.length;
  return { text: lines.slice(0, kept).join("\n"), truncated, keptLines: kept };
}
