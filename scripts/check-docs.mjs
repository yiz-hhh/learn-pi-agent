import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const chaptersDir = join(root, "chapters");
const readme = readFileSync(join(root, "README.md"), "utf8");
const readmeEn = readFileSync(join(root, "README.en.md"), "utf8");
const siteConfig = readFileSync(join(root, "website/.vitepress/config.ts"), "utf8");
const siteHome = readFileSync(join(root, "website/index.md"), "utf8");
const chapterDirs = readdirSync(chaptersDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const expected = chapterDirs.map((name) => `chapters/${name}`);
const allText = `${readme}\n${readmeEn}\n${siteConfig}\n${siteHome}`;
const stale = ["09-skills-extensions", "11-philosophy-in-practice", "chapter-09-skills-extensions", "chapter-11-philosophy-in-practice"];
const errors = [];

for (const name of chapterDirs) {
  const chapterReadmePath = join(chaptersDir, name, "README.md");
  const packagePath = join(chaptersDir, name, "package.json");
  const sitePagePath = join(root, "website", "chapters", `${name}.md`);
  if (!existsSync(chapterReadmePath)) errors.push(`${name}: missing README.md`);
  if (!existsSync(packagePath)) errors.push(`${name}: missing package.json`);
  if (!allText.includes(`chapters/${name}`) && !siteConfig.includes(`/chapters/${name}`)) {
    errors.push(`${name}: not referenced by public docs`);
  }

  if (existsSync(chapterReadmePath)) {
    const chapterText = readFileSync(chapterReadmePath, "utf8");
    const readmeTitle = chapterText.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const chapterNumber = name.slice(0, 2);
    const expectedPrefix = `Chapter ${chapterNumber}：`;
    if (!readmeTitle?.startsWith(expectedPrefix)) {
      errors.push(`${name}: README H1 must start with ${expectedPrefix}`);
    }

    if (existsSync(sitePagePath)) {
      const siteText = readFileSync(sitePagePath, "utf8");
      const siteTitle = siteText.match(/^title:\s*["']?(.+?)["']?$/m)?.[1]?.trim();
      const siteH1 = siteText.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (readmeTitle && siteTitle !== readmeTitle) errors.push(`${name}: site frontmatter title != README H1`);
      if (readmeTitle && siteH1 !== readmeTitle) errors.push(`${name}: site H1 != README H1`);
    } else {
      errors.push(`${name}: missing website/chapters/${name}.md`);
    }

    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageJson.name !== `chapter-${name}`) {
        errors.push(`${name}: package name ${packageJson.name} != chapter-${name}`);
      }
    }

    const displayTitle = readmeTitle?.replace(/^Chapter \d{2}：/, "");
    const navMatch = siteConfig.match(new RegExp(`\\{ text: "(\\d{2} · [^"]+)", link: "/chapters/${name}" \\}`));
    if (!navMatch) {
      errors.push(`${name}: missing sidebar entry`);
    } else if (displayTitle && navMatch[1] !== `${chapterNumber} · ${displayTitle}`) {
      errors.push(`${name}: sidebar label ${navMatch[1]} != README title ${displayTitle}`);
    }

    for (const [label, text] of [["README", readme], ["README.en", readmeEn]]) {
      const linkMatch = text.match(new RegExp(`\\[([^\\]]+)\\]\\((?:\\./|/)chapters/${name}\\)`));
      if (!linkMatch) {
        errors.push(`${name}: missing ${label} link`);
      } else if (displayTitle && linkMatch[1] !== `${chapterNumber} · ${displayTitle}`) {
        errors.push(`${name}: ${label} label ${linkMatch[1]} != README title ${displayTitle}`);
      }
    }
  }
}
for (const oldName of stale) {
  if (allText.includes(oldName)) errors.push(`stale path remains: ${oldName}`);
}

const chapterCount = (readme.match(/\| \[\d{2} ·/g) ?? []).length;
if (chapterCount !== chapterDirs.length) errors.push(`README chapter count ${chapterCount} != directory count ${chapterDirs.length}`);

if (errors.length) {
  console.error(errors.map((error) => `✗ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`✓ docs consistent: ${expected.length} chapters`);
