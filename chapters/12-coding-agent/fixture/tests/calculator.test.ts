/**
 * 计算器测试（脚本式断言：非零退出码即失败，bash npm test 的输出可读）。
 * add(2, 3) 应等于 5，当前实现误写成减法会断言失败，修复后通过。
 */
import { strict as assert } from "node:assert";
import { add, multiply } from "../src/calculator.ts";

const cases: Array<[number, number, number]> = [
  [2, 3, 5],
  [0, 0, 0],
  [-1, 1, 0],
  [10, 20, 30],
];

for (const [a, b, expected] of cases) {
  const actual = add(a, b);
  console.log(`add(${a}, ${b}) = ${actual}${actual === expected ? "" : `，期望 ${expected}`}`);
  assert.equal(actual, expected, `add(${a}, ${b}) 应该等于 ${expected}`);
}

assert.equal(multiply(3, 4), 12, "multiply(3, 4) 应该等于 12");
console.log("全部测试通过");
