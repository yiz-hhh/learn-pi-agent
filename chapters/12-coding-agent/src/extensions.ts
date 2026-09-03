/**
 * 复用 Chapter 09 的扩展点，让产品组装保持轻量。
 * 10 章组装复用：本文件与 09 章 extensions.ts 保持同步。
 *
 * 1. **Skill**（Pi harness/types.ts L46-56）：name/description/content/filePath。
 *    content 只存在于技能文件里，系统提示词只列目录（name/description/location），
 *    模型匹配描述后用 read 工具按需读取（Pi system-prompt.ts L3-25 的机制）。
 * 2. **formatSkillsForSystemPrompt**（Pi harness/system-prompt.ts）：目录块。
 *    教学简化：属性格式 `<skill name=… location=…>`（Pi 为子元素格式）、无 XML 转义。
 * 3. **readSkillContent / loadSkillFromFile**（Pi harness/skills.ts L50-76）：按需读取技能文件。
 *    教学简化：直接读文件，不做目录扫描/frontmatter/ignore 解析。
 * 4. **formatSkillInvocation**（Pi harness/skills.ts L38-41）：读取后注入的完整技能块。
 * 5. **addedToolNames**（Pi types.ts L368-369 + ToolResultMessage 注释）：工具结果引入新工具
 *    （配 00 基座的 loadTools 钩子与循环侧动态合并）。
 *
 * 加上 00 基座的 uiOnly 消息过滤（Pi 注释示例：Filter out UI-only messages），
 * 09 章覆盖三种扩展形态：消息模型扩展、提示词扩展、工具集扩展。
 */
import { readFileSync } from "node:fs";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";

/** 技能：Pi `Skill`（harness/types.ts L46-56）的教学子集（4 字段，disableModelInvocation 不教）。 */
export interface Skill {
  /** 稳定的技能名（模型可见列表用）。 */
  name: string;
  /** 何时使用该技能的简短说明（模型据此决定是否读取）。 */
  description: string;
  /** 完整技能指令（加载自技能文件；不注入系统提示词）。 */
  content: string;
  /** 技能文件位置：目录块里的 location，模型按此读取（Pi filePath）。 */
  filePath: string;
}

/**
 * 技能 → 系统提示词目录块（Pi `formatSkillsForSystemPrompt`，system-prompt.ts L3-25）。
 * 与 Pi 对齐的机制：只列 name/description/location，content 留在技能文件里，
 * 模型匹配描述后按需读取（Pi L9 指令：Read the full skill file when the task matches its description）。
 * 教学简化：属性格式（Pi 子元素格式）、无 XML 转义。
 */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "以下技能提供特定任务的专门指令。当任务与技能描述匹配时，先读取对应技能文件（location），遵循其中的完整指令。",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push(`  <skill name="${skill.name}" location="${skill.filePath}">`);
    lines.push(`    <description>${skill.description}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** 按需读取技能文件（Pi：技能是文件，模型匹配描述后用工具读取；教学版直接读文件）。 */
export function readSkillContent(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/**
 * 从技能文件加载技能：content = 文件正文（Pi `loadSkills` 的最小版；
 * 目录扫描/SKILL.md/frontmatter/ignore 等文件发现细节不教）。
 */
export function loadSkillFromFile(filePath: string, name: string, description: string): Skill {
  return { name, description, content: readSkillContent(filePath), filePath };
}

/** 技能调用块（Pi `formatSkillInvocation`，skills.ts L38-41）：读取后注入的完整指令格式。
 * 与 09 章/Pi 对齐：additionalInstructions 用真值判定（传 "" 不追加，skills.ts L40）；
 * references 引导行（skills.ts L39）教学剪裁。 */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>`;
  return additionalInstructions ? `${block}\n\n${additionalInstructions}` : block;
}

/** 简易工具注册表：供 loadTools 钩子实现使用（name → Tool）。 */
export function createToolRegistry(initial: Tool[]): { find: (name: string) => Tool | undefined; load: (names: string[]) => Tool[] } {
  const tools = new Map(initial.map((t) => [t.name, t]));
  return {
    find: (name) => tools.get(name),
    load: (names) => names.map((name) => tools.get(name)).filter((t): t is Tool => t !== undefined),
  };
}
