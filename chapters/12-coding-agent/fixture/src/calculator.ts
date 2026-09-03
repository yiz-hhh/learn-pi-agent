/**
 * 计算器：E2E 场景的修复对象。
 * 注意：add 的实现含故意 bug（误写成减法），测试会失败，供 Coding Agent 定位与修复。
 */
export function add(a: number, b: number): number {
  return a - b; // bug：应为 a + b
}

export function multiply(a: number, b: number): number {
  return a * b;
}
