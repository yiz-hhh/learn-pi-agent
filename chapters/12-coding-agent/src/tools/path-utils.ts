/**
 * 12 章产品工具公共工具：路径解析（Pi 蓝本 harness/tools/path-utils.ts resolveToolPath）。
 *
 * 产品工具按项目根目录（cwd）构造（Pi createGrepTool(cwd) / createBashTool(cwd) 同款）：
 * 相对路径相对 cwd 解析，绝对路径原样使用。
 */
import { resolve } from "node:path";

/** 解析工具参数里的路径：相对路径相对 cwd，绝对路径原样（Pi resolveToolPath）。 */
export function resolveToolPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath);
}

/** 错误对象 → 可读描述（Node 系统错误带 code，如 ENOENT）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return `错误码 ${(error as NodeJS.ErrnoException).code}`;
  }
  return error instanceof Error ? error.message : String(error);
}
