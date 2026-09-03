<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * 主题布局包装：在默认 Layout 上注入章节阅读进度条（顶部 2px 品牌色）。
 * 仅在章节页渲染；首页与列表页不出现。
 */
const { Layout } = DefaultTheme;
const { page } = useData();
const progress = ref(0);

let ticking = false;
const update = () => {
  ticking = false;
  const el = document.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  progress.value = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
};
const onScroll = () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(update);
  }
};

onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  update();
});
onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));
</script>

<template>
  <Layout>
    <template #layout-top>
      <div
        v-if="page.relativePath.startsWith('chapters/')"
        class="read-progress"
        :style="{ transform: `scaleX(${progress})` }"
        aria-hidden="true"
      />
    </template>
  </Layout>
</template>
