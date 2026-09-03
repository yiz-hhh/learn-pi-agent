/**
 * 12 章测试：五个产品工具的独立用例（离线，临时目录 + 受控命令）。
 *
 * 错误语义：工具失败一律抛错，由 01 章流水线转错误 toolResult（本文件直接断言 rejects）。
 * 每个工具对应 Pi 蓝本，锚点标注在各文件头注释。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import { createReadFileTool } from "../src/tools/read.ts";
import { createWriteFileTool } from "../src/tools/write.ts";

/** 每个用例独立的临时目录（项目根，即工具 cwd）。 */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lpia-ch12-tools-"));
  projectDirs.push(dir);
  return dir;
}

const projectDirs: string[] = [];
afterAll(() => {
  for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

describe("read_file（Pi harness/tools/read.ts）", () => {
  it("读取文件内容，offset/limit 按行切片", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "line1\nline2\nline3\n", "utf8");
    const tool = createReadFileTool(cwd);

    // 尾随换行与 Pi 一致（split/join 保留文件原样；Pi read.ts L97-98 同语义）
    const full = await tool.execute({ path: "a.txt" });
    expect(full.content).toBe("line1\nline2\nline3\n");

    const sliced = await tool.execute({ path: "a.txt", offset: 2, limit: 1 });
    expect(sliced.content).toContain("line2");
    expect(sliced.content).toContain("offset=3");

    // limit 未到末尾时提示续读
    const partial = await tool.execute({ path: "a.txt", limit: 2 });
    expect(partial.content).toContain("offset=3");
  });

  it("读不存在的文件 → 错误", async () => {
    const tool = createReadFileTool(tempProject());
    await expect(tool.execute({ path: "missing.ts" })).rejects.toThrow("无法读取文件");
  });

  it("offset 超出文件末尾 → 错误", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "one line", "utf8");
    const tool = createReadFileTool(cwd);
    await expect(tool.execute({ path: "a.txt", offset: 10 })).rejects.toThrow("超出文件末尾");
  });

  it("超长文件截断并提示续读 offset", async () => {
    const cwd = tempProject();
    const manyLines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(cwd, "big.txt"), manyLines + "\n", "utf8");
    const tool = createReadFileTool(cwd);

    const result = await tool.execute({ path: "big.txt" });
    expect(result.content).toContain("用 offset=501 继续");
    // 文件 600 行 + 尾换行 = 601 行（split 语义与 Pi 一致）
    expect(result.details).toMatchObject({ truncation: { truncated: true, totalLines: 601 } });
  });

  it("路径解析 contract：cwd 是解析基点而非沙箱（../ 可解析到 cwd 外，与 Pi resolveToolPath 同款）", async () => {
    const parent = tempProject();
    const cwd = join(parent, "project");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(parent, "outside.txt"), "outside\n", "utf8");
    const tool = createReadFileTool(cwd);

    const result = await tool.execute({ path: "../outside.txt" });
    expect(result.content).toBe("outside\n");
  });
});

describe("write_file（Pi harness/tools/write.ts）", () => {
  it("写文件 → 读回一致（自动创建父目录）", async () => {
    const cwd = tempProject();
    const tool = createWriteFileTool(cwd);
    const content = "export const answer = 42;\n";

    const result = await tool.execute({ path: "src/deep/answer.ts", content });
    expect(result.content).toContain("成功写入");

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "src/deep/answer.ts"), "utf8")).toBe(content);
  });

  it("覆盖已有文件", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.txt"), "old", "utf8");
    const tool = createWriteFileTool(cwd);

    await tool.execute({ path: "a.txt", content: "new" });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("new");
  });
});

describe("edit（Pi harness/tools/edit.ts）", () => {
  it("定位字符串替换 → 内容正确，details 带行级 diff", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b; // bug\n}\n", "utf8");
    const tool = createEditTool(cwd);

    const result = await tool.execute({
      path: "calc.ts",
      edits: [{ oldText: "a - b", newText: "a + b" }],
    });
    expect(result.content).toContain("成功替换 1 处块");
    const details = result.details as { firstChangedLine: number; diff: string } | undefined;
    expect(details).toMatchObject({ firstChangedLine: 2 });
    expect(details?.diff).toContain("- a - b");
    expect(details?.diff).toContain("+ a + b");

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "calc.ts"), "utf8")).toContain("return a + b;");
  });

  it("多个编辑互不重叠时一次应用（全部基于原文件匹配）", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "a\nb\nc\nd\n", "utf8");
    const tool = createEditTool(cwd);

    await tool.execute({ path: "m.ts", edits: [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }] });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, "m.ts"), "utf8")).toBe("A\nb\nC\nd\n");
  });

  it("oldText 不存在 → 错误", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "hello\n", "utf8");
    const tool = createEditTool(cwd);
    await expect(tool.execute({ path: "m.ts", edits: [{ oldText: "nope", newText: "x" }] })).rejects.toThrow("oldText 未找到");
  });

  it("oldText 不唯一 → 错误", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "dup\ndup\n", "utf8");
    const tool = createEditTool(cwd);
    await expect(tool.execute({ path: "m.ts", edits: [{ oldText: "dup", newText: "x" }] })).rejects.toThrow("不唯一");
  });

  it("edits 重叠 → 错误（要求合并）", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "abc\n", "utf8");
    const tool = createEditTool(cwd);
    await expect(
      tool.execute({ path: "m.ts", edits: [{ oldText: "ab", newText: "X" }, { oldText: "bc", newText: "Y" }] }),
    ).rejects.toThrow("重叠");
  });

  it("兼容层：单编辑对象参数归一为数组（03 章 prepareArguments）", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "m.ts"), "a\n", "utf8");
    const tool = createEditTool(cwd);
    const input = { path: "m.ts", oldText: "a", newText: "b" };
    await expect(tool.execute(tool.prepareArguments!(input) as never)).resolves.toMatchObject({
      content: "成功替换 1 处块到 m.ts",
    });
  });
});

describe("grep（Pi coding-agent/src/core/tools/grep.ts，只存在于产品层）", () => {
  it("匹配行号与内容（目录递归，跳过 node_modules）", async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "src", "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "const x = 1;\nexport function add(a: number, b: number) {\n  return a + b;\n}\n", "utf8");
    writeFileSync(join(cwd, "src", "node_modules", "dep.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n", "utf8");
    const tool = createGrepTool(cwd);

    const result = await tool.execute({ pattern: "function add", path: "src" });
    expect(result.content).toContain("a.ts:2: export function add");
    expect(result.content).not.toContain("node_modules");

    // 行号与内容随匹配行逐行给出（函数体行用另一个 pattern 命中）
    const body = await tool.execute({ pattern: "return a \\+ b", path: "src" });
    expect(body.content).toContain("a.ts:3:   return a + b;");
  });

  it("glob 过滤与 limit 上限提示", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "x\ny\n", "utf8");
    writeFileSync(join(cwd, "b.md"), "x\n", "utf8");
    const tool = createGrepTool(cwd);

    const globbed = await tool.execute({ pattern: "^x$", path: ".", glob: "*.ts" });
    expect(globbed.content).toContain("a.ts:1:");
    expect(globbed.content).not.toContain("b.md");

    const limited = await tool.execute({ pattern: "^x$", path: ".", limit: 1 });
    expect(limited.content).toContain("匹配上限");
    expect(limited.details).toMatchObject({ matchLimitReached: 1 });
  });

  it("literal 模式按字面量匹配", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "a.b\n", "utf8");
    const tool = createGrepTool(cwd);
    const result = await tool.execute({ pattern: "a.b", literal: true });
    expect(result.content).toContain("a.ts:1: a.b");
  });

  it("无匹配返回提示；路径不存在 → 错误", async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "hello\n", "utf8");
    const tool = createGrepTool(cwd);

    const none = await tool.execute({ pattern: "zzz" });
    expect(none.content).toBe("未找到匹配");

    await expect(tool.execute({ pattern: "x", path: "missing" })).rejects.toThrow("路径不存在");
  });

  it("无效正则 → 错误", async () => {
    const tool = createGrepTool(tempProject());
    await expect(tool.execute({ pattern: "(" })).rejects.toThrow("无效的正则");
  });
});

describe("bash（Pi harness/tools/bash.ts + coding-agent core/tools/bash.ts）", () => {
  it("执行命令返回输出（stdout 与 stderr 合并）", async () => {
    const cwd = tempProject();
    const tool = createBashTool(cwd);

    const ok = await tool.execute({ command: "echo hello" });
    expect(ok.content).toContain("hello");

    const merged = await tool.execute({ command: "echo out && echo err >&2" });
    expect(merged.content).toContain("out");
    expect(merged.content).toContain("err");
  });

  it("非零退出码 → 错误结果", async () => {
    const tool = createBashTool(tempProject());
    await expect(tool.execute({ command: "exit 3" })).rejects.toThrow("命令退出码 3");
  });

  it("超时 → 错误结果（Pi L146-150）", async () => {
    const tool = createBashTool(tempProject());
    await expect(tool.execute({ command: "sleep 3", timeout: 1 })).rejects.toThrow("超时");
  }, 10000);

  it("AbortSignal 中止长命令 → 错误结果（Pi bash signal 透传）", async () => {
    const tool = createBashTool(tempProject());
    const controller = new AbortController();
    const run = tool.execute({ command: "sleep 30" }, undefined, controller.signal);
    // 等 shell 真正启动后再 abort（sleep 30 提供数量级余量，不依赖精确 timing）；
    // 运行中 abort → close 路径「命令被中止」；abort 落在 spawn 窗口 → error 路径同样拒绝
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(run).rejects.toThrow(/被中止|aborted/);
  }, 10000);

  it("输出超 64KB 截断并保留末尾", async () => {
    const tool = createBashTool(tempProject());
    const result = await tool.execute({ command: "node -e \"process.stdout.write('a'.repeat(100 * 1024))\"" });
    expect(result.content).toContain("输出截断");
    expect(result.content.length).toBeLessThan(70 * 1024);
    expect(result.details).toMatchObject({ truncation: { truncated: true } });
  });

  it("工具本身不设防：危险命令白名单判定不在工具里（边界完整性 E）", async () => {
    // 教学点：权限策略在扩展（permission-gate），不在工具或 loop。
    // 工具对任意命令一视同仁（执行与策略分离），拦截由 beforeToolCall 钩子完成（见 e2e.test.ts）。
    const tool = createBashTool(tempProject());
    const result = await tool.execute({ command: "echo 工具只负责执行" });
    expect(result.content).toContain("工具只负责执行");
  });
});
