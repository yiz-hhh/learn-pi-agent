/**
 * 12 章产品工具集注册（Pi 蓝本 coding-agent/src/core/tools/index.ts createAllToolDefinitions 的组装视角）。
 *
 * 五个真实工具：
 * - read_file（Pi harness/tools/read.ts）：读取文件
 * - write_file（Pi harness/tools/write.ts）：写入文件
 * - edit（Pi harness/tools/edit.ts）：定位字符串替换
 * - grep（Pi coding-agent/src/core/tools/grep.ts）：搜索文件内容，只在产品层
 * - bash（Pi harness/tools/bash.ts + coding-agent core/tools/bash.ts）：执行命令
 *
 * 工具分层教学点：read/write/edit/bash 在 agent 包的 harness 层（带 env 抽象，可换后端），
 * grep 只在 coding-agent 产品层（依赖 ripgrep 的产品工具）。教学版五件都直接落 fs 与
 * child_process，分层差异在 README §4 讲解。
 */
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGrepTool } from "./grep.ts";
import { createReadFileTool } from "./read.ts";
import { createWriteFileTool } from "./write.ts";

/** 五个产品工具的名称（组装期注册进 RuntimeConfig.activeTools）。 */
export const PRODUCT_TOOL_NAMES = ["read_file", "write_file", "edit", "grep", "bash"] as const;

/** 创建全部产品工具（Pi createAllToolDefinitions 的教学版，cwd 为项目根目录）。 */
export function createProductTools(cwd: string): Tool[] {
  return [
    createReadFileTool(cwd),
    createWriteFileTool(cwd),
    createEditTool(cwd),
    createGrepTool(cwd),
    createBashTool(cwd),
  ];
}
