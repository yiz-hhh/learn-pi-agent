/**
 * 站点同步脚本：把各章节 README 复制为站点页面。
 *
 * 防漂移设计：站点页面不是手写副本，每次 docs:dev / docs:build 前重新生成。
 * 处理两件事：
 * 1. 复制：chapters 各目录的 README.md → website/chapters/
 * 2. frontmatter：从 H1 提取 title，从首段提取 description（SEO）
 *
 * 章节 README 相互引用一律用纯文本「Chapter NN」，不写仓库内相对链接，
 * 因此同步是纯机械复制，无需链接重写。
 * 3. canonical：每章页面注入 canonical URL（SEO，防重复内容判定）
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE_URL = "https://yiz-hhh.github.io/learn-pi-agent";
const OUT_DIR = join(ROOT, "website", "chapters");

let copied = 0;
const chapterDirs = readdirSync(join(ROOT, "chapters"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
mkdirSync(OUT_DIR, { recursive: true });
const currentPages = new Set(chapterDirs.map((name) => `${name}.md`));
for (const file of readdirSync(OUT_DIR)) {
  if (file.endsWith(".md") && !currentPages.has(file)) {
    unlinkSync(join(OUT_DIR, file));
    console.log(`移除过期页面: website/chapters/${file}`);
  }
}
for (const name of chapterDirs) {
  const readmePath = join(ROOT, "chapters", name, "README.md");
  const raw = readFileSync(readmePath, "utf-8"); // 章节目录必须带 README，缺文件直接报错（防静默漏页）
  const outFile = join(OUT_DIR, `${name}.md`);
  writeFileSync(outFile, buildPage(raw, `${SITE_URL}/chapters/${name}`), "utf-8");
  copied++;
  console.log(`同步: chapters/${name}/README.md → website/chapters/${name}.md`);
}
console.log(`\n完成：${copied} 个页面已同步到 website/chapters/`);

/** 组装页面：frontmatter（YAML 安全引用，含 canonical head）+ 正文。 */
function buildPage(raw, canonical) {
  const { title, description } = extractFrontmatter(raw);
  // YAML 安全引用：JSON 字符串语法与 YAML 双引号字符串兼容（转义 \n \t 等）
  const yamlString = (value) => JSON.stringify(value);
  const head = [["link", { rel: "canonical", href: canonical }]];
  const frontmatter = [
    "---",
    title ? `title: ${yamlString(title)}` : undefined,
    description ? `description: ${yamlString(description)}` : undefined,
    `head: ${yamlString(head)}`,
    "---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  return `${frontmatter}${raw}`;
}

function extractFrontmatter(text) {
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  const firstParagraph = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#") && !line.startsWith(">"))
    .find((line) => line.trim().length > 10);
  const description = firstParagraph ? firstParagraph.replace(/[*`]/g, "").trim().slice(0, 150) : undefined;
  return { title, description };
}
