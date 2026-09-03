/**
 * 10 章核心：扩展加载器（Pi loader.ts 的教学子集）。
 *
 * Pi 的发现逻辑（loader.ts）：resolveExtensionEntries 检查 package.json 的 pi.extensions 字段
 * 或 index.ts 入口（L758 附近），loadExtensions（L648）逐文件动态 import，default export 即扩展工厂。
 * 教学简化：目录下所有 .ts/.js 文件都是扩展入口（package.json 字段发现不教）。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "./extension-api.ts";

/** 从目录加载全部扩展工厂（Pi loadExtensions L648 教学简化版）。
 *
 * 失败隔离（Pi 逐路径收集错误、继续加载，loader.ts L566-588 教学版）：
 * 单个文件 import 失败 / default export 非函数，只 warn + 跳过，不杀其余扩展。
 * factory 执行期的失败隔离在 runner.load 的临时注册区（commit/discard）。
 */
export async function loadExtensionsFromDir(dir: string): Promise<ExtensionFactory[]> {
  const factories: ExtensionFactory[] = [];
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
    try {
      const mod = await import(pathToFileURL(join(dir, name)).href);
      const factory = mod.default as unknown;
      if (typeof factory === "function") {
        factories.push(factory as ExtensionFactory);
      } else {
        // Pi 对非函数 default export 报 loader error（loader.ts L578-580）；教学 skip + warn
        console.warn(`扩展文件 ${name} 的 default export 不是函数，跳过`);
      }
    } catch (error) {
      console.warn(`扩展文件 ${name} 加载失败，跳过:`, error instanceof Error ? error.message : String(error));
    }
  }
  return factories;
}
