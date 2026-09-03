/**
 * 计算器 CLI 入口：node --import tsx src/index.ts 2 3 输出 add(2, 3) 的结果。
 * 运行 npm test 前可先手动验证行为。
 */
import { add } from "./calculator.ts";

const [aRaw, bRaw] = process.argv.slice(2);
const a = Number(aRaw);
const b = Number(bRaw);
if (Number.isNaN(a) || Number.isNaN(b)) {
  console.error("用法: tsx src/index.ts <a> <b>");
  process.exit(1);
}
console.log(`${a} + ${b} = ${add(a, b)}`);
