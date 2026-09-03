/**
 * 12 章 E2E 临时项目工具：把 fixture/ 复制到系统临时目录。
 *
 * 为什么复制：E2E 场景（demo 与测试）会真实修改项目文件（edit 修复 bug、npm test 验证）。
 * 直接改仓库内 fixture 会污染工作区，复制到临时目录保证每次运行从干净状态开始。
 */
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** fixture 目录（仓库内模板，只读）。 */
export const FIXTURE_DIR = fileURLToPath(new URL("../fixture/", import.meta.url));
const WORKSPACE_NODE_MODULES = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

/** 复制 fixture 到临时目录，返回临时项目根路径。 */
export function copyFixtureToTemp(): string {
  const dest = join(tmpdir(), `lpia-ch12-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(FIXTURE_DIR, dest, { recursive: true });
  mkdirSync(join(dest, "node_modules"), { recursive: true });
  symlinkSync(WORKSPACE_NODE_MODULES, join(dest, "node_modules", "workspace"), "dir");
  symlinkSync(join(WORKSPACE_NODE_MODULES, "tsx"), join(dest, "node_modules", "tsx"), "dir");
  symlinkSync(join(WORKSPACE_NODE_MODULES, "esbuild"), join(dest, "node_modules", "esbuild"), "dir");
  return dest;
}
