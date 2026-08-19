import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
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
          highlight: ["highlight.js"],
          markdown: ["marked", "dompurify"],
          diff: ["diff"],
        },
      },
    },
  },
}));
