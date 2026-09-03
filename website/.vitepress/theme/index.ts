import DefaultTheme from "vitepress/theme";
import HomePage from "../../components/HomePage.vue";
import Layout from "./Layout.vue";
import "./style.css";

/** 终端工程风主题：基于 VitePress 默认主题，覆盖配色/字体/局部版式（见 style.css）。 */
export default {
  ...DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("HomePage", HomePage);
  },
};
