<script setup lang="ts">
import { withBase } from "vitepress";
import { onMounted, ref } from "vue";
import AgentOrbit from "./AgentOrbit.vue";

const codeWindow = ref<HTMLElement>();

onMounted(() => {
  // 代码窗进入视口时一次性轻微聚焦（reduced-motion 跳过）
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const el = codeWindow.value;
  if (!el || !("IntersectionObserver" in window)) return;

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        el.classList.add("is-focus");
        io.disconnect();
      }
    },
    { threshold: 0.55 },
  );

  io.observe(el);
});
</script>

<template>
  <main class="home-page">
    <section class="home-hero" aria-labelledby="home-title">
      <div class="home-copy">
        <h1 id="home-title">Learn Pi Agent</h1>

        <p class="home-tagline">
          Minimal core. Extensible by design.
        </p>

        <p>
          从一次 LLM 调用开始，<br />
          逐步重建 Pi 的 Agent Harness。
        </p>

        <a
          class="home-cta"
          :href="withBase('chapters/00-minimal-llm-call')"
        >
          开始阅读 <span aria-hidden="true">→</span>
        </a>
      </div>

      <AgentOrbit />
    </section>

    <section class="home-start" aria-labelledby="start-title">
      <header class="home-start-head">
        <h2 id="start-title">The Agent Loop</h2>
        <p class="home-start-desc">Call the model · Run its tools · Feed results back until it stops asking</p>
      </header>

      <div
        ref="codeWindow"
        class="home-code"
        aria-label="Agent loop 示例"
      >
        <div class="home-code-bar">
          <span class="home-code-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
          <span>agent-loop.ts</span>
        </div>

        <!-- span 之间不能有任何空白文本节点：pre 会把源码换行渲染成幻影空行 -->
        <pre><code><span class="line"><b>while</b> (<em>true</em>) {</span><span class="line">  <b>const</b> assistant = <em>await</em> callModel(context);</span><span class="line">  context.messages.push(assistant);</span><span class="line">  <b>if</b> (!hasToolCalls(assistant)) {</span><span class="line">    <em>break</em>;</span><span class="line">  }</span><span class="line">  <b>const</b> results = <em>await</em> executeTools(assistant.toolCalls);</span><span class="line">  context.messages.push(...results);</span><span class="line">}</span></code></pre>
      </div>
    </section>
  </main>
</template>

<style scoped>
.home-tagline {
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
  line-height: 1.5;
  font-weight: 500;
  letter-spacing: 0.01em;
  opacity: 0.72;
}
</style>