/**
 * 12 章产品工具：edit（定位字符串替换，Pi 蓝本 harness/tools/edit.ts 全文 140 行）。
 *
 * 与 Pi 对齐的机制：
 * - parameters schema（Pi editSchema L28-37）：path + edits[]（oldText/newText）
 * - 兼容层 prepareArguments（Pi L55-77）：edits 为 JSON 字符串或单个编辑对象时归一为数组
 * - 语义（Pi 描述原文）：每个 oldText 必须在原文件唯一匹配、互不重叠；
 *   所有 edits 都基于原文件匹配（非增量），重叠/嵌套编辑要求合并
 * - 匹配失败/不唯一/重叠全部抛错（Pi L79-84 validate + applyEditsToNormalizedContent），转错误 toolResult
 * - 成功回执与 details（Pi L130-136：Successfully replaced N block(s) + diff/patch/firstChangedLine）
 *
 * 教学剪裁：
 * - diff 队列全量剪裁：不做 fuzzy 匹配（normalizeForFuzzyMatch）、统一 patch 生成、
 *   BOM/行尾检测与还原（edit-diff.ts 全量），details 只给行级 diff 与首个变更行
 * - 文件并发写队列（Pi withFileMutationQueue）不教，同 write_file
 * - env 抽象（Pi ExecutionEnv.fileInfo/readTextFile）简化为直接 fs 调用
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolParameters } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** 单次替换（Pi replaceEditSchema L17-26）。 */
export interface EditItem {
  oldText: string;
  newText: string;
}

/** edit 工具参数（Pi EditToolInput；type 别名以获得隐式索引签名，满足 00 基座 Tool 泛型约束）。 */
export type EditInput = {
  path: string;
  edits: EditItem[];
};

/** 定位结果：原文件中的一处匹配。 */
interface Match extends EditItem {
  start: number;
}

/** 创建 edit 工具（Pi createEditTool，harness/tools/edit.ts）。 */
export function createEditTool(cwd: string): Tool<EditInput> {
  return {
    name: "edit",
    description:
      "在单个文件中做定位字符串替换：每个 edits[].oldText 必须在原文件唯一匹配且互不重叠；两处改动相邻时合并为一个编辑。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要编辑的文件路径（相对或绝对）" },
        // 00 基座 ToolParameters 为极简 schema（type/description），数组元素细节经类型断言保留
        edits: { type: "array", description: "一个或多个定位替换，每个含 oldText 与 newText" },
      },
      required: ["path", "edits"],
    } as ToolParameters,
    prepareArguments(args) {
      return prepareEditArguments(args);
    },
    async execute(args) {
      const { path, edits } = validateEditInput(args);
      const absolutePath = resolveToolPath(cwd, path);
      let content: string;
      try {
        content = await readFile(absolutePath, "utf-8");
      } catch (error) {
        throw new Error(`无法编辑文件: ${path}（${describeError(error)}）`);
      }

      // 全部基于原文件匹配（Pi：Each edit is matched against the original file, not incrementally）
      const matches = edits.map((edit) => findUniqueMatch(content, edit));
      matches.sort((a, b) => a.start - b.start);
      assertNoOverlap(matches);

      const newContent = applyMatches(content, matches);
      await writeFile(absolutePath, newContent, "utf-8");

      const details = buildDetails(content, matches);
      return {
        content: `成功替换 ${matches.length} 处块到 ${path}`,
        details,
      };
    },
  };
}

/** 兼容层：edits 为 JSON 字符串、单个编辑对象或顶层 oldText/newText 时归一为数组（Pi prepareEditArguments L55-77）。 */
export function prepareEditArguments(input: unknown): EditInput {
  if (!input || typeof input !== "object") {
    return input as EditInput;
  }
  const args = input as Record<string, unknown>;
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      const parsed: unknown = JSON.parse(edits);
      if (Array.isArray(parsed) || isSingleEdit(parsed)) edits = parsed;
    } catch {
      // 解析失败保持原值，校验阶段报错
    }
  }
  if (isSingleEdit(edits)) {
    edits = [edits];
  }
  // 旧式顶层参数（Pi L71-76：legacy.oldText/newText 追加进 edits）
  const { oldText, newText, ...rest } = args;
  if (typeof oldText === "string" && typeof newText === "string") {
    const base = Array.isArray(edits) ? [...edits] : [];
    return { ...rest, edits: [...base, { oldText, newText }] } as EditInput;
  }
  return { ...rest, edits } as EditInput;
}

/** 单个编辑对象（未带 edits 数组的旧式参数）。 */
function isSingleEdit(value: unknown): value is EditItem {
  if (!value || typeof value !== "object") return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** 校验：path 与 edits 必须有效（Pi validateEditInput L79-84）。 */
function validateEditInput(input: EditInput): EditInput {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edit 工具参数无效：edits 必须包含至少一个替换。");
  }
  return input;
}

/** 在原文件查找唯一匹配（Pi：must be unique in the original file）。 */
function findUniqueMatch(content: string, edit: EditItem): Match {
  if (edit.oldText === "") {
    throw new Error("oldText 不能为空字符串");
  }
  const positions: number[] = [];
  let index = content.indexOf(edit.oldText);
  while (index !== -1) {
    positions.push(index);
    index = content.indexOf(edit.oldText, index + 1);
  }
  if (positions.length === 0) {
    throw new Error(`oldText 未找到: ${preview(edit.oldText)}`);
  }
  if (positions.length > 1) {
    throw new Error(`oldText 不唯一（找到 ${positions.length} 处）: ${preview(edit.oldText)}`);
  }
  return { ...edit, start: positions[0] };
}

/** 重叠检查：后一处匹配的开始不得落在前一处区间内（Pi：Do not include overlapping or nested edits）。 */
function assertNoOverlap(matches: Match[]): void {
  for (let i = 1; i < matches.length; i++) {
    const prev = matches[i - 1];
    if (matches[i].start < prev.start + prev.oldText.length) {
      throw new Error("edits 存在重叠或嵌套，请合并为同一个编辑");
    }
  }
}

/** 应用全部匹配（按位置顺序拼接原文件分段与新文本）。 */
function applyMatches(content: string, matches: Match[]): string {
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += content.slice(cursor, match.start) + match.newText;
    cursor = match.start + match.oldText.length;
  }
  return result + content.slice(cursor);
}

/** 行级 diff 与首个变更行（Pi generateDiffString/generateUnifiedPatch 的教学子集）。 */
function buildDetails(content: string, matches: Match[]): { diff: string; firstChangedLine: number } {
  const diffLines: string[] = [];
  for (const match of matches) {
    for (const line of match.oldText.split("\n")) diffLines.push(`- ${line}`);
    for (const line of match.newText.split("\n")) diffLines.push(`+ ${line}`);
  }
  const firstChangedLine = content.slice(0, matches[0].start).split("\n").length;
  return { diff: diffLines.join("\n"), firstChangedLine };
}

/** 匹配片段预览（截断长文本）。 */
function preview(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
