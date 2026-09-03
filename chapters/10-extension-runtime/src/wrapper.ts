/**
 * 10 章核心：扩展工具包装（Pi wrapper.ts 全文 45 行的复刻）。
 *
 * 两件事：
 * 1. ctx 注入：把扩展工具的 execute(..., ctx) 适配成 00 基座 Tool 的 execute(args, onUpdate, signal)，
 *    ctx 在调用时从 runner.createContext() 取（Pi wrapper.ts L17-18：wrapToolDefinition(() => runner.createContext())）；
 * 2. addedToolNames 联动：execute 前后对比 runner.getActiveTools()，把新增的工具名并入结果
 *    （Pi wrapper.ts L22-35：扩展工具执行中改变 active tools，结果自动声明「从这条消息起可用」，
 *    与 09 章 addedToolNames 机制衔接：09 是数据级声明，10 是运行时级捕获）。
 */
import type { Tool, ToolResult } from "../../00-minimal-llm-call/src/index.ts";
import type { ExtensionTool } from "./extension-api.ts";
import type { ExtensionRunner } from "./runner.ts";

/** 包装单个扩展工具（Pi wrapRegisteredTool，wrapper.ts L17-37）。 */
export function wrapRegisteredTool(registeredTool: ExtensionTool, runner: ExtensionRunner): Tool {
  return {
    name: registeredTool.name,
    description: registeredTool.description,
    parameters: registeredTool.parameters,
    async execute(args: Record<string, unknown>, onUpdate?: (partial: ToolResult) => void, signal?: AbortSignal) {
      const activeBefore = runner.getActiveTools();
      const result = await registeredTool.execute(args, runner.createContext(), onUpdate, signal);
      const activeAfter = runner.getActiveTools();
      // Pi wrapper.ts L26 守卫：任一工具被移除则不报告新增（增删同时发生时抑制 addedToolNames）
      if (!activeBefore.every((name) => activeAfter.includes(name))) {
        return result;
      }
      // execute 中扩展通过 ctx.setActiveTools 引入的新工具 → 并入结果（Pi wrapper.ts L27-34）
      const beforeNames = new Set(activeBefore);
      const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
      if (addedToolNames.length === 0) {
        return result;
      }
      return {
        ...result,
        addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
      };
    },
  };
}

/** 包装全部扩展工具（Pi wrapRegisteredTools，wrapper.ts L43-45）。 */
export function wrapRegisteredTools(registeredTools: ExtensionTool[], runner: ExtensionRunner): Tool[] {
  return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
