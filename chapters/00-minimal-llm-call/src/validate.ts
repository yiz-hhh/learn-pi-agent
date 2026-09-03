/**
 * 极简 JSON Schema 校验器。
 *
 * 对应 Pi 的 `validateToolArguments`（agent-loop.ts L618，来自 pi-ai，typebox 实现）。
 * 教学版只实现教学需要的子集：对象类型、字段 type 检查、required 检查。
 * 04 章起工具参数校验进入流水线；这里提供纯函数，便于独立测试。
 */
import type { Tool, ToolParameters } from "./types.ts";

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** 校验工具参数是否符合 schema（Pi `validateToolArguments`，agent-loop.ts L618）。 */
export function validateToolArguments(tool: Tool, args: unknown): ValidationResult {
  return validateObject(tool.parameters, args);
}

/** 校验一个 object schema（递归到字段级）。 */
function validateObject(schema: ToolParameters, value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `参数必须是 object，实际是 ${describe(value)}` };
  }

  const record = value as Record<string, unknown>;

  // required 检查（Pi 契约：缺少必填字段直接拒绝）
  for (const key of schema.required ?? []) {
    if (!(key in record)) {
      return { ok: false, error: `缺少必填参数: ${key}` };
    }
  }

  // 字段级 type 检查
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key in record) {
      const check = checkType(prop.type, record[key]);
      if (!check.ok) {
        return { ok: false, error: `参数 ${key} ${check.error}` };
      }
    }
  }

  return { ok: true };
}

/** 单个字段的 type 检查。 */
function checkType(type: string, value: unknown): ValidationResult {
  const match = {
    string: typeof value === "string",
    number: typeof value === "number",
    boolean: typeof value === "boolean",
    integer: typeof value === "number" && Number.isInteger(value),
    object: typeof value === "object" && value !== null && !Array.isArray(value),
    array: Array.isArray(value),
  }[type];

  if (!match) {
    return { ok: false, error: `类型应为 ${type}，实际是 ${describe(value)}` };
  }
  return { ok: true };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}
