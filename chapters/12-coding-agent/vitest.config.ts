/**
 * 12 章 vitest 配置：只跑 test/ 目录，排除 fixture/。
 * fixture 是 E2E 的临时项目，其中的 tests/calculator.test.ts 是给产品 bash 工具
 * （npm test）执行的脚本式断言，不是 vitest 用例（且其含 bug 时本就应失败）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
