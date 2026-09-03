# 验证技能（verify）

修复流程：修改 src/calculator.ts 后必须运行 `npm test` 验证，测试全部通过才算完成。

具体步骤：
1. 先用 read_file 读取 src/calculator.ts 与 tests/calculator.test.ts，理解期望行为；
2. 用 edit 或 write_file 修复 bug；
3. 用 bash 运行 `npm test`；
4. 若测试仍失败，读回测试输出与源码，继续修改，直到输出「全部测试通过」；
5. 在最终回复里说明修复内容与测试结果。
