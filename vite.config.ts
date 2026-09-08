import { defineConfig, type Plugin } from "vite";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// 版本号单一来源 package.json，注入 __APP_VERSION__ 供设置页展示
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };

/** dev/build 启动时把 src/i18n（唯一主本）同步到 public/i18n，防止两份手工镜像漂移 */
function syncI18nAssets(): Plugin {
  return {
    name: "sync-i18n-assets",
    buildStart() {
      mkdirSync("public/i18n", { recursive: true });
      for (const name of readdirSync("src/i18n")) {
        if (name.endsWith(".json")) copyFileSync(join("src/i18n", name), join("public/i18n", name));
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [syncI18nAssets()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            "codemirror",
            "@codemirror/commands",
            "@codemirror/lang-markdown",
            "@codemirror/language",
            "@codemirror/state",
            "@codemirror/view",
          ],
          // highlight.js 已改为首次遇到代码块时动态 import，交给 Rollup 自动分包
          markdown: ["marked", "dompurify"],
          diff: ["diff"],
        },
      },
    },
  },
}));
