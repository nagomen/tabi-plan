import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

// 複数ページ（ダッシュボード / 計画一覧 / 計画エディタ / 費用入力 / 行程編集）を
// それぞれ独立した HTML エントリとしてビルドする。
// GitHub Pages のプロジェクトサイトでも動くよう base は相対パスにする。
export default defineConfig({
  base: "./",
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, "index.html"),
        plans: resolve(rootDir, "plans.html"),
        planEditor: resolve(rootDir, "plan-editor.html"),
        expenseEntry: resolve(rootDir, "expense-entry.html"),
        itineraryEditor: resolve(rootDir, "itinerary-editor.html"),
      },
    },
  },
});
