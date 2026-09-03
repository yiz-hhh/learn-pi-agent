/**
 * learn-pi-agent 文档站配置（VitePress）。
 * SEO 要点：稳定 URL、唯一描述、OG 标签、JSON-LD、sitemap、章节地图侧栏。
 *
 * 发布：GitHub Actions 构建并部署到 GitHub Pages。
 */
import { defineConfig } from "vitepress";

/** GitHub Pages 项目站路径（仓库名 learn-pi-agent；发布到自定义域名或改部署方式时调整）。 */
const BASE = "/learn-pi-agent/";

export default defineConfig({
  title: "Learn Pi Agent",
  description: "从一次最小的 LLM 调用开始，逐步实现 Pi Agent 的核心机制。",
  lang: "zh-CN",
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  markdown: {
    // 代码块背景在两个主题下都是深色（--vp-code-block-bg），
    // 若用默认双主题 Shiki，light 模式下会套用浅色 token（深字-on-深底，不可读）。
    theme: "github-dark",
  },
  sitemap: {
    // GitHub Pages 实际地址（部署方式变化时同步调整）
    hostname: "https://yiz-hhh.github.io/learn-pi-agent/",
  },
  head: [
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "learn-pi-agent" }],
    ["meta", { property: "og:url", content: "https://yiz-hhh.github.io/learn-pi-agent/" }],
    ["meta", { name: "twitter:card", content: "summary" }],
    ["meta", { property: "og:title", content: "learn-pi-agent：Pi Agent 架构中文教程" }],
    ["meta", { property: "og:description", content: "从最小 LLM Loop 开始，用 TypeScript 和离线测试逐步重建 Pi Agent 的 Core、Harness、Extension 与 Coding Agent" }],
    ["meta", { property: "og:locale", content: "zh_CN" }],
    ["meta", { name: "keywords", content: "Pi Agent, LLM Agent 教程, Agent Loop, Tool Calling, TypeScript, Session Tree, Context Compaction, Extension Runtime, Coding Agent, 中文教程" }],
    ["meta", { property: "og:image", content: "https://yiz-hhh.github.io/learn-pi-agent/og-cover.svg" }],
    ["link", { rel: "icon", href: "/learn-pi-agent/favicon.svg", type: "image/svg+xml" }],
    ["script", { type: "application/ld+json" }, JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "learn-pi-agent",
      url: "https://yiz-hhh.github.io/learn-pi-agent/",
      description: "从最小 LLM 调用开始，逐步重建 Pi Agent Harness。",
    })],
  ],
  themeConfig: {
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索", buttonAriaLabel: "搜索" },
              modal: {
                displayDetails: "显示详细列表",
                resetButtonTitle: "重置搜索",
                backButtonTitle: "关闭搜索",
                noResultsText: "没有找到相关结果",
                footer: {
                  selectText: "选择",
                  selectKeyAriaLabel: "回车",
                  navigateText: "切换",
                  navigateUpKeyAriaLabel: "上箭头",
                  navigateDownKeyAriaLabel: "下箭头",
                  closeText: "关闭",
                  closeKeyAriaLabel: "Esc",
                },
              },
            },
          },
        },
      },
    },
    footer: {
      message: "MIT License · yiz-hhh",
    },
    outline: { label: "本章目录", level: [2, 3] },
    docFooter: { prev: "上一章", next: "下一章" },
    lastUpdated: { text: "最后更新", formatOptions: { dateStyle: "short", timeStyle: "short" } },
    darkModeSwitchLabel: "外观",
    sidebarMenuLabel: "菜单",
    returnToTopLabel: "回到顶部",
    nav: [
      { text: "章节", link: "/chapters/00-minimal-llm-call", activeMatch: "/chapters/" },
      { text: "GitHub", link: "https://github.com/yiz-hhh/learn-pi-agent" },
    ],
    sidebar: [
      {
        text: "Part I · Agent Core",
        collapsed: false,
        items: [
          { text: "00 · Minimal LLM Call", link: "/chapters/00-minimal-llm-call" },
          { text: "01 · Tool-driven Agent", link: "/chapters/01-tool-driven-agent" },
          { text: "02 · Agent Runtime", link: "/chapters/02-agent-runtime" },
          { text: "03 · Tool Runtime", link: "/chapters/03-tool-runtime" },
          { text: "04 · Parallel Tool Execution", link: "/chapters/04-parallel-tools" },
          { text: "05 · Steering & Follow-up", link: "/chapters/05-steering-followup" },
          { text: "06 · Context Transformation", link: "/chapters/06-context-transform" },
        ],
      },
      {
        text: "Part II · Agent Harness",
        collapsed: false,
        items: [
          { text: "07 · Session Tree", link: "/chapters/07-session-tree" },
          { text: "08 · Context Compaction", link: "/chapters/08-context-compaction" },
          { text: "09 · Skills", link: "/chapters/09-skills" },
        ],
      },
      {
        text: "Part III · Extensibility",
        collapsed: false,
        items: [
          { text: "10 · Extension Runtime", link: "/chapters/10-extension-runtime" },
          { text: "11 · Extension Composition", link: "/chapters/11-extension-composition" },
        ],
      },
      {
        text: "Part IV · Product",
        collapsed: false,
        items: [{ text: "12 · Coding Agent", link: "/chapters/12-coding-agent" }],
      },
    ],
  },
});
