/**
 * 12 章产品工具：bash（执行 shell 命令，Pi 蓝本 harness/tools/bash.ts 全文 161 行
 * 与 coding-agent/src/core/tools/bash.ts 全文 545 行的教学子集）。
 *
 * 与 Pi 对齐的机制：
 * - parameters schema（Pi bashSchema L11-14）：command / timeout（秒，可选）
 * - timeout 校验（Pi L41-49：有限正数、上限 MAX_TIMEOUT_SECONDS=2147483.647 秒，bash.ts L8）
 * - 非零退出码抛错（Pi harness L152-154：Command exited with code X），由 01 章流水线转错误 toolResult
 * - 超时抛错（Pi L146-150：Command timed out after N seconds）
 * - stdout 与 stderr 合并返回（Pi createLocalShellOperations L126-127：两路都进输出）
 * - 输出截断保留末尾（Pi 保留最后 N 行，truncate.ts DEFAULT_MAX_LINES=2000 / DEFAULT_MAX_BYTES=50KB，L11-12）
 *
 * 教学剪裁：
 * - 工具不设防（Pi 同款：权限策略在扩展，permission-gate 在 execute 前拦截，本工具执行任意命令）
 * - onUpdate 流式输出（Pi BASH_UPDATE_THROTTLE_MS 100ms 节流，L74-105）不教
 * - 截断后的完整输出落盘（Pi fullOutputPath 临时文件，L130-141）不教，只给截断提示
 * - 进程树管理（Pi killProcessTree/trackDetachedChildPid）、命令前缀、PI_* 环境变量注入不教
 */
import { spawn } from "node:child_process";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";

/** 输出截断上限（教学自取 64KB；Pi DEFAULT_MAX_BYTES=50KB，truncate.ts L12）。 */
export const BASH_MAX_BYTES = 64 * 1024;
/** 超时上限（Pi MAX_TIMEOUT_SECONDS L8 = 2_147_483_647 / 1000 = 2147483.647，教学取整）。 */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** 创建 bash 工具（Pi createBashTool，harness/tools/bash.ts）。 */
export function createBashTool(cwd: string): Tool<{ command: string; timeout?: number }> {
  return {
    name: "bash",
    description: "在项目目录执行 shell 命令。返回 stdout 与 stderr 合并输出。可选 timeout（秒）。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
        timeout: { type: "number", description: "超时秒数（可选，默认不限制）" },
      },
      required: ["command"],
    },
    async execute(args, _onUpdate, signal) {
      validateTimeout(args.timeout);
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", args.command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        });
        let output = "";
        let timedOut = false;
        const timer =
          args.timeout !== undefined
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
              }, args.timeout * 1000)
            : undefined;

        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`无法启动 shell: ${error.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(new Error(`${output}\n\n命令在 ${args.timeout} 秒后超时`));
            return;
          }
          if (signal?.aborted) {
            reject(new Error(`${output}\n\n命令被中止`));
            return;
          }
          const truncated = output.length > BASH_MAX_BYTES;
          const body = truncated
            ? `（输出截断，仅保留最后 ${BASH_MAX_BYTES} 字节）\n${output.slice(-BASH_MAX_BYTES)}`
            : output;
          if (code !== 0) {
            reject(new Error(`${body}\n\n命令退出码 ${code}`));
            return;
          }
          resolve({
            content: body || "(无输出)",
            details: truncated ? { truncation: { truncated: true } } : undefined,
          });
        });
      });
    },
  };
}

/** 校验 timeout（Pi validateTimeout L41-49）。 */
function validateTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("无效的 timeout：必须是正数秒");
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`无效的 timeout：最大 ${MAX_TIMEOUT_SECONDS} 秒`);
  }
}
