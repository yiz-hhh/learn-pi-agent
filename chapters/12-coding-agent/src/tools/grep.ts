/**
 * 12 章产品工具：grep（搜索文件内容，Pi 蓝本 coding-agent/src/core/tools/grep.ts 全文 391 行）。
 *
 * 工具分层教学点：grep 不在 harness/tools/（agent 包），只在产品层（coding-agent core/tools/）：
 * 它是 Coding Agent 产品的工作流工具，不是 agent 机制的必需件。这是 12 章工具分层的锚点之一。
 *
 * 与 Pi 对齐的机制：
 * - parameters schema（Pi grepSchema L24-36）：pattern / path / glob / ignoreCase / literal / context / limit
 * - 匹配输出格式（Pi formatBlock L255-273）：`文件:行号: 内容`，context 行用 `文件-行号- 内容`
 * - 匹配上限与提示（Pi L292-296/L344-348）：达到 limit 截断并提示细化 pattern
 * - 路径不存在抛错（Pi L186-191：Path not found）
 * - 无匹配返回提示文本（Pi L314-318：No matches found）
 *
 * 教学剪裁：
 * - 不依赖 ripgrep（Pi spawn rg L226），纯 Node fs 递归扫描；行级截断（Pi truncateLine
 *   GREP_MAX_LINE_LENGTH）不教；.gitignore 尊重简化为跳过 node_modules/.git 等目录
 * - glob 支持最小子集（* 与 ** 通配），Pi 透传给 ripgrep 的完整 glob 语法不教
 * - 输出字节截断（Pi DEFAULT_MAX_BYTES=50KB，truncate.ts L12）教学用 limit 语义兜底，不做字节截断
 */
import { basename, join, relative, sep } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** 默认匹配上限（Pi DEFAULT_LIMIT L44）。 */
export const GREP_DEFAULT_LIMIT = 100;

/** 教学简化：跳过这些目录（Pi 由 ripgrep 尊重 .gitignore 实现）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/** 单个匹配记录。 */
interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** 创建 grep 工具（Pi createGrepTool，coding-agent/src/core/tools/grep.ts）。 */
export function createGrepTool(cwd: string): Tool<{
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}> {
  return {
    name: "grep",
    description:
      "在文件内容中搜索模式（正则或字面量），返回匹配行（文件路径:行号: 内容）。跳过 node_modules 与 .git。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索模式（正则或字面量字符串）" },
        path: { type: "string", description: "搜索的目录或文件（默认当前目录）" },
        glob: { type: "string", description: "按 glob 过滤文件，如 *.ts 或 **/*.test.ts" },
        ignoreCase: { type: "boolean", description: "忽略大小写（默认 false）" },
        literal: { type: "boolean", description: "把 pattern 当字面量而非正则（默认 false）" },
        context: { type: "number", description: "每个匹配前后各显示的行数（默认 0）" },
        limit: { type: "number", description: "最多返回的匹配数（默认 100）" },
      },
      required: ["pattern"],
    },
    async execute(args) {
      const root = resolveToolPath(cwd, args.path ?? ".");
      let isDirectory: boolean;
      try {
        const info = await stat(root);
        isDirectory = info.isDirectory();
        if (!isDirectory && !info.isFile()) {
          throw new Error(`路径不是文件也不是目录: ${root}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("路径不是")) throw error;
        throw new Error(`路径不存在: ${root}（${describeError(error)}）`);
      }

      let matcher: RegExp;
      try {
        matcher = compilePattern(args.pattern, args.literal ?? false, args.ignoreCase ?? false);
      } catch (error) {
        throw new Error(`无效的正则: ${args.pattern}（${describeError(error)}）`);
      }
      const globRe = args.glob ? compileGlob(args.glob) : undefined;
      const effectiveLimit = Math.max(1, args.limit ?? GREP_DEFAULT_LIMIT);
      const contextValue = args.context && args.context > 0 ? args.context : 0;

      const matches: GrepMatch[] = [];
      if (isDirectory) {
        await walkDirectory(root, root, matcher, globRe, effectiveLimit, matches);
      } else {
        await searchFile(root, basename(root), matcher, effectiveLimit, matches);
      }
      const limitReached = matches.length >= effectiveLimit;

      const lines = await formatMatches(matches, contextValue, limitReached, effectiveLimit, root);
      return {
        content: lines.length > 0 ? lines.join("\n") : "未找到匹配",
        details: limitReached ? { matchLimitReached: effectiveLimit } : undefined,
      };
    },
  };
}

/** 编译搜索模式：literal 时转义正则元字符（Pi rg --fixed-strings 的教学等价物）。 */
function compilePattern(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  return new RegExp(source, ignoreCase ? "i" : "");
}

/** 最小 glob 编译：* 匹配段内任意字符，** 匹配跨目录（Pi 完整 glob 语法透传 ripgrep）。
 * 用 split("**") 分段处理，避免 * 替换干扰 **。 */
function compileGlob(glob: string): RegExp {
  const source = glob
    .split("**")
    .map((segment) => segment.replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** 递归扫描目录，逐行匹配并收集结果（Pi 用 ripgrep 流式收集，教学版递归遍历）。 */
async function walkDirectory(
  dir: string,
  root: string,
  matcher: RegExp,
  globRe: RegExp | undefined,
  limit: number,
  matches: GrepMatch[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= limit) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDirectory(full, root, matcher, globRe, limit, matches);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(root, full).split(sep).join("/");
    if (globRe && !globRe.test(rel)) continue;
    await searchFile(full, rel, matcher, limit, matches);
  }
}

/** 搜索单个文件：逐行匹配，达到 limit 提前停止（Pi 对单个文件同样支持）。 */
async function searchFile(
  filePath: string,
  relName: string,
  matcher: RegExp,
  limit: number,
  matches: GrepMatch[],
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return; // 不可读文件跳过（如权限受限）
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    if (matcher.test(lines[i])) {
      matches.push({ file: relName, line: i + 1, text: lines[i] });
    }
  }
}

/** 格式化匹配输出：`文件:行号: 内容`，context 行用 `文件-行号- 内容`（Pi formatBlock L255-273）。 */
async function formatMatches(
  matches: GrepMatch[],
  context: number,
  limitReached: boolean,
  effectiveLimit: number,
  root: string,
): Promise<string[]> {
  const lines: string[] = [];
  const fileCache = new Map<string, string[]>();
  const getLines = async (file: string): Promise<string[]> => {
    let cached = fileCache.get(file);
    if (!cached) {
      cached = (await readFile(join(root, file), "utf-8")).split("\n");
      fileCache.set(file, cached);
    }
    return cached;
  };

  for (const match of matches) {
    if (context === 0) {
      lines.push(`${match.file}:${match.line}: ${match.text}`);
      continue;
    }
    const fileLines = await getLines(match.file);
    const start = Math.max(1, match.line - context);
    const end = Math.min(fileLines.length, match.line + context);
    for (let current = start; current <= end; current++) {
      const text = fileLines[current - 1] ?? "";
      lines.push(current === match.line ? `${match.file}:${current}: ${text}` : `${match.file}-${current}- ${text}`);
    }
  }
  if (limitReached) {
    lines.push(`\n[达到 ${effectiveLimit} 条匹配上限。用 limit=${effectiveLimit * 2} 扩大，或细化 pattern]`);
  }
  return lines;
}
