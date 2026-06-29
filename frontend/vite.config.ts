import { defineConfig, type Plugin } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const rootDir = dirname(fileURLToPath(import.meta.url));
// 開発中のローカルプラン保存先（リポジトリ直下 data/plans/*.json）。将来は DB へ。
const plansDir = resolve(rootDir, "../data/plans");

function safeSlug(value: string): string {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "trip"
  );
}

function readAllPlans(): unknown[] {
  try {
    fs.mkdirSync(plansDir, { recursive: true });
    return fs
      .readdirSync(plansDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(resolve(plansDir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((p) => p !== null);
  } catch {
    return [];
  }
}

/**
 * 開発専用: ローカルプランを data/plans/<slug>.json に永続化する。
 *  - transformIndexHtml で window.__DEV_PLANS__ に全ファイルを注入（同期読み取り用）
 *  - /api/plans への PUT/DELETE でファイルを書き込み/削除
 * `apply: "serve"` なので本番ビルドには一切含まれない。
 */
function devPlansFiles(): Plugin {
  return {
    name: "dev-plans-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/plans", (req, res) => {
        const rest = decodeURIComponent((req.url || "/").split("?")[0].replace(/^\//, ""));
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(readAllPlans()));
          return;
        }
        if (req.method === "PUT" && rest) {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              fs.mkdirSync(plansDir, { recursive: true });
              fs.writeFileSync(resolve(plansDir, safeSlug(rest) + ".json"), body || "{}");
              res.statusCode = 204;
              res.end();
            } catch (e) {
              res.statusCode = 500;
              res.end(String(e));
            }
          });
          return;
        }
        if (req.method === "DELETE" && rest) {
          try {
            fs.rmSync(resolve(plansDir, safeSlug(rest) + ".json"), { force: true });
          } catch {
            /* ignore */
          }
          res.statusCode = 204;
          res.end();
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          injectTo: "head-prepend",
          children: `window.__DEV_PLANS__=${JSON.stringify(readAllPlans())};`,
        },
      ];
    },
  };
}

// 複数ページ（ダッシュボード / 計画一覧 / 計画エディタ / 費用入力 / 行程編集）を
// それぞれ独立した HTML エントリとしてビルドする。
// GitHub Pages のプロジェクトサイトでも動くよう base は相対パスにする。
export default defineConfig({
  base: "./",
  root: ".",
  publicDir: "public",
  plugins: [devPlansFiles()],
  server: {
    open: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rootDir, "index.html"),
        plans: resolve(rootDir, "plans.html"),
        mypage: resolve(rootDir, "mypage.html"),
        planEditor: resolve(rootDir, "plan-editor.html"),
        expenseEntry: resolve(rootDir, "expense-entry.html"),
        itineraryEditor: resolve(rootDir, "itinerary-editor.html"),
      },
    },
  },
});
