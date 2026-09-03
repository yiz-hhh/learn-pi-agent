<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * 首屏轨道图：Agent Loop 居中，六个核心机制沿椭圆轨道真实运转。
 * - 节点位置由 rAF 参数方程驱动（外轨 46s、中轨 38s 一圈），hover 暂停便于点击；
 * - 标签连续绕节点滑动，始终朝向轨道中心一侧：无翻转跳变，也永不触及视口边缘；
 * - 指针在轨道上移动时，星点/光环/节点分层视差；
 * - prefers-reduced-motion：不启动动画，停留在 SSR 静态位置（即首帧），无闪烁。
 */
/**
 * 三条轨道按「离 Agent Loop 的语义距离」分配：
 * 内轨 Provider/Context（循环直接调用的模型与数据），
 * 中轨 Tool Runtime/Session（循环内执行与持久化），
 * 外轨 Skills/Extensions（外层能力注入与扩展）。
 */
const nodes = [
  { key: "skills", label: "Skills", slug: "chapters/09-skills", ring: 0, angle: -100 },
  { key: "session", label: "Session", slug: "chapters/07-session-tree", ring: 1, angle: 155 },
  { key: "extensions", label: "Extensions", slug: "chapters/10-extension-runtime", ring: 0, angle: 25 },
  { key: "context", label: "Context", slug: "chapters/06-context-transform", ring: 2, angle: 20 },
  { key: "tools", label: "Tool Runtime", slug: "chapters/03-tool-runtime", ring: 1, angle: -25 },
  { key: "provider", label: "Provider", slug: "chapters/00-minimal-llm-call", ring: 2, angle: 200 },
];

/** 轨道几何：与 SVG viewBox（720×280）同一坐标系，写入样式时换算为百分比。 */
const CENTER = { x: 360, y: 140 };
const RINGS = [
  { rx: 330, ry: 118, degPerSec: 360 / 46 },
  { rx: 258, ry: 88, degPerSec: 360 / 38 },
  { rx: 186, ry: 60, degPerSec: 360 / 30 },
];
const pointAt = (ring: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return {
    rad,
    x: ((CENTER.x + RINGS[ring].rx * Math.cos(rad)) / 720) * 100,
    y: ((CENTER.y + RINGS[ring].ry * Math.sin(rad)) / 280) * 100,
  };
};
/**
 * 标签锚点：沿轨道切线方向尾随节点（与运动方向相反），
 * 标签始终留在本轨道的高度带——不压中心文字、不跨环碰撞、连续无跳变。
 * SSR 按字符数估算标签宽度，挂载后实测纠正。
 */
const LABEL_GAP = 11;
const estimateLabelW = (label: string) => label.length * 7.4 + 4;
const labelAnchor = (rad: number, labelW: number, gap = LABEL_GAP) => {
  const dist = labelW / 2 + gap;
  return { lx: Math.sin(rad) * dist, ly: -Math.cos(rad) * dist };
};
const initial = nodes.map((n) => {
  const p = pointAt(n.ring, n.angle);
  const a = labelAnchor(p.rad, estimateLabelW(n.label));
  return { x: p.x, y: p.y, ...a };
});

/** 星点：固定坐标撒在轨道间隙，CSS 里按各自 delay 呼吸闪烁。[x, y, r, delay(s)] */
const stars: [number, number, number, number][] = [
  [52, 36, 1.2, 0], [96, 78, 0.9, 1.2], [86, 210, 1.4, 0.6], [160, 250, 0.8, 2],
  [230, 30, 1.0, 1.6], [300, 14, 1.3, 0.3], [440, 14, 0.9, 2.4], [516, 34, 1.2, 1],
  [606, 58, 0.8, 1.8], [672, 108, 1.3, 0.9], [692, 198, 1.0, 2.2], [622, 246, 1.4, 0.4],
  [480, 258, 0.9, 1.4], [350, 264, 1.1, 2.6], [196, 184, 0.8, 0.2], [560, 160, 0.7, 1.9],
];

const orbitRoot = ref<HTMLElement>();
const orbitNav = ref<HTMLElement>();
/** hover 的节点：既用于 rAF 暂停，也驱动中心文字联动（reactive）。 */
const hovered = ref<string | null>(null);
const setHovered = (key: string | null) => { hovered.value = key; };
const centerLabel = computed(() => (hovered.value ? nodes.find((n) => n.key === hovered.value)?.label : null) ?? "Agent Loop");
const centerColor = computed(() => (hovered.value ? `var(--acc-${hovered.value})` : undefined));
/** 窄屏（≤719px）：标签朝外、深度压差放宽（见 tick）。 */
const compact = ref(false);
let dispose: () => void = () => {};

onMounted(() => {
  // 减弱动态效果：保持 SSR 静态位置，不启动任何循环
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const root = orbitRoot.value;
  const els = Array.from(orbitNav.value?.querySelectorAll<HTMLElement>(".orbit-node") ?? []);
  if (!root || els.length !== nodes.length) return;

  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointerMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    parallax.tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    parallax.ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
  };
  const onPointerLeave = () => { parallax.tx = 0; parallax.ty = 0; };
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", onPointerLeave);

  // 窄屏模式：标签朝外、间距收紧
  const mq = window.matchMedia("(max-width: 719px)");
  compact.value = mq.matches;
  const onMqChange = (e: MediaQueryListEvent) => { compact.value = e.matches; };
  mq.addEventListener("change", onMqChange);

  // 实测标签宽度（随断点字号变化），用于计算标签锚点距离
  let labelW = els.map((el) => el.querySelector<HTMLElement>(".node-label")?.getBoundingClientRect().width ?? 0);
  const onResize = () => {
    labelW = els.map((el) => el.querySelector<HTMLElement>(".node-label")?.getBoundingClientRect().width ?? 0);
  };
  window.addEventListener("resize", onResize);
  // 入场动画结束后交还 opacity/scale 控制权（fill:both 否则会一直压住内联值）
  els.forEach((el) => el.addEventListener("animationend", () => { el.style.animation = "none"; }, { once: true }));

  let raf = 0;
  let last = 0;
  const tick = (now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    parallax.x += (parallax.tx - parallax.x) * 0.06;
    parallax.y += (parallax.ty - parallax.y) * 0.06;
    root.style.setProperty("--px", parallax.x.toFixed(4));
    root.style.setProperty("--py", parallax.y.toFixed(4));
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (hovered.value !== n.key) n.angle += RINGS[n.ring].degPerSec * dt;
      const { rad, x, y } = pointAt(n.ring, n.angle);
      const { lx, ly } = labelAnchor(rad, labelW[i], compact.value ? 8 : LABEL_GAP);
      const el = els[i];
      el.style.left = `${x + parallax.x * 1.1}%`;
      el.style.top = `${y + parallax.y * 2.2}%`;
      el.style.setProperty("--lx", `${lx.toFixed(1)}px`);
      el.style.setProperty("--ly", `${ly.toFixed(1)}px`);
      // 深度线索：顶部为远侧（小、暗、退到核心光晕后方），底部为近侧（大、亮、在前）；
      // 窄屏放宽压差保证可读性
      const depth = (Math.sin(rad) + 1) / 2;
      if (compact.value) {
        el.style.scale = (0.94 + depth * 0.1).toFixed(3);
        el.style.opacity = (0.75 + depth * 0.25).toFixed(3);
      } else {
        el.style.scale = (0.88 + depth * 0.18).toFixed(3);
        el.style.opacity = (0.5 + depth * 0.5).toFixed(3);
      }
      el.style.zIndex = depth < 0.45 ? "1" : "4";
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  dispose = () => {
    cancelAnimationFrame(raf);
    mq.removeEventListener("change", onMqChange);
    window.removeEventListener("resize", onResize);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onPointerLeave);
  };
});
onBeforeUnmount(() => dispose());
</script>

<template>
  <div ref="orbitRoot" class="agent-orbit">
    <div class="orbit-aurora" aria-hidden="true"></div>
    <svg class="orbit-svg" viewBox="0 0 720 280" fill="none" aria-hidden="true">
      <defs>
        <!-- 环描边纵向渐变：顶部（远侧）暗 → 底部（近侧）亮，俯视角度的光照暗示 -->
        <linearGradient id="ring-depth" x1="0" y1="0" x2="0" y2="1">
          <stop class="stop-far" offset="0%" />
          <stop class="stop-near" offset="62%" />
        </linearGradient>
      </defs>
      <circle
        v-for="([x, y, r, d]) in stars"
        :key="`${x}-${y}`"
        class="star"
        :style="{ animationDelay: `${d}s` }"
        :cx="x"
        :cy="y"
        :r="r"
      />
      <ellipse class="ring ring-outer" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="ring ring-middle" cx="360" cy="140" rx="258" ry="88" pathLength="100" />
      <ellipse class="ring ring-inner" cx="360" cy="140" rx="186" ry="60" pathLength="100" />
      <ellipse class="ring-core" cx="360" cy="140" rx="104" ry="38" />
      <ellipse class="comet comet-one-tail" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="comet comet-one-mid" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="comet comet-one" cx="360" cy="140" rx="330" ry="118" pathLength="100" />
      <ellipse class="comet comet-two" cx="360" cy="140" rx="258" ry="88" pathLength="100" />
      <ellipse class="comet comet-three" cx="360" cy="140" rx="186" ry="60" pathLength="100" />
    </svg>
    <div class="orbit-glow" aria-hidden="true"></div>
    <div class="orbit-core">
      <Transition name="core-fade" mode="out-in">
        <span :key="centerLabel" :style="centerColor ? { color: centerColor } : undefined">{{ centerLabel }}</span>
      </Transition>
    </div>
    <nav ref="orbitNav" class="orbit-nav" aria-label="核心机制直达章节">
      <a
        v-for="(node, i) in nodes"
        :key="node.key"
        class="orbit-node"
        :class="`node-${node.key}`"
        :style="{
          left: `${initial[i].x}%`,
          top: `${initial[i].y}%`,
          '--lx': `${initial[i].lx.toFixed(1)}px`,
          '--ly': `${initial[i].ly.toFixed(1)}px`,
        }"
        :href="withBase(node.slug)"
        @mouseenter="setHovered(node.key)"
        @mouseleave="setHovered(null)"
        @focus="setHovered(node.key)"
        @blur="setHovered(null)"
      ><span class="node-dot" aria-hidden="true"></span><span class="node-label">{{ node.label }}</span></a>
    </nav>
  </div>
</template>
