import { defineConfig, type Plugin } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const rootDir = dirname(fileURLToPath(import.meta.url));
// 開発中のローカルプラン保存先（リポジトリ直下 data/plans/*.json）。将来は DB へ。
const plansDir = resolve(rootDir, "../data/plans");
// プラン以外のドメインデータ（ユーザー・費用・送金リンク）の保存先。
// backend.ts が write-through する。1キー=1ファイル（data/store/<key>.json）。
const storeDir = resolve(rootDir, "../data/store");

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
 * ローカルプランを data/plans/<slug>.json から読み込む。
 *  - transformIndexHtml で window.__DEV_PLANS__ に全ファイルを注入（同期読み取り用）
 *  - 開発サーバでは /api/plans への PUT/DELETE でファイルを書き込み/削除
 */
function devPlansFiles(): Plugin {
  return {
    name: "dev-plans-files",
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

function safeKey(value: string): string {
  return String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "value";
}

function readAllStore(): Record<string, unknown> {
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    const out: Record<string, unknown> = {};
    for (const f of fs.readdirSync(storeDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(resolve(storeDir, f), "utf8"));
      } catch {
        /* 壊れたファイルは無視 */
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 開発専用: backend.ts のドメインデータ（プラン以外: ユーザー・費用・送金リンク）を
 * data/store/<key>.json に永続化する。
 *  - transformIndexHtml で window.__DEV_STORE__ に全ファイルを注入（preload の真実）
 *  - /api/store/<key> への PUT/DELETE でファイルを書き込み/削除
 * `apply: "serve"` なので本番ビルドには含まれない（本番は localStorage のまま）。
 */
function devStoreFiles(): Plugin {
  return {
    name: "dev-store-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/store", (req, res) => {
        const rest = decodeURIComponent((req.url || "/").split("?")[0].replace(/^\//, ""));
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(readAllStore()));
          return;
        }
        if (req.method === "PUT" && rest) {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              fs.mkdirSync(storeDir, { recursive: true });
              // git 差分が読めるよう整形して書き出す
              const pretty = JSON.stringify(JSON.parse(body || "null"), null, 2);
              fs.writeFileSync(resolve(storeDir, safeKey(rest) + ".json"), pretty);
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
            fs.rmSync(resolve(storeDir, safeKey(rest) + ".json"), { force: true });
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
          children: `window.__DEV_STORE__=${JSON.stringify(readAllStore())};`,
        },
      ];
    },
  };
}

/**
 * 画面遷移をなめらかにするインライン <style>（head 先頭 = render-blocking, dev/本番共通）。
 *
 * 1) 対応ブラウザ: クロスドキュメント View Transitions（@view-transition: navigation auto）。
 *    旧画面のスナップショットを保持したまま新画面へスライドするので、白画面が出ず
 *    GPU 合成でなめらか。MPA で「スライドアウト→白→スライドイン」の分断が起きない。
 * 2) 非対応ブラウザ: ブートクローク（html:not(.ui-ready){opacity:0}）で初回描画を隠し、
 *    page-transition.ts が同期構築の完了直後に html.ui-ready を付けて表示する。
 *    JS が動かない場合も uiBootFailsafe が 0.8s 後に必ず表示へ戻す。
 * バンドルCSS(ui.css)に置くと dev では JS 注入でタイミングがずれるため、必ずインラインで入れる。
 */
function pageTransitionHead(): Plugin {
  const css = [
    "@view-transition{navigation:auto}",
    "::view-transition-old(root){animation:vtOut .18s cubic-bezier(.4,0,.2,1) both}",
    "::view-transition-new(root){animation:vtIn .24s cubic-bezier(.2,.8,.2,1) both}",
    "@keyframes vtOut{to{opacity:0;transform:translateX(-16px)}}",
    "@keyframes vtIn{from{opacity:0;transform:translateX(18px)}}",
    "@supports not (view-transition-name:none){",
    "@keyframes uiBootFailsafe{to{opacity:1}}",
    "html:not(.ui-ready){opacity:0;animation:uiBootFailsafe .001s linear .8s both}",
    "}",
    "@media (prefers-reduced-motion:reduce){",
    "::view-transition-old(root),::view-transition-new(root){animation:none}",
    "}",
  ].join("");
  return {
    name: "page-transition-head",
    transformIndexHtml() {
      return [{ tag: "style", injectTo: "head-prepend", children: css }];
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
  plugins: [pageTransitionHead(), devPlansFiles(), devStoreFiles()],
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
        person: resolve(rootDir, "person.html"),
        login: resolve(rootDir, "login.html"),
        planEditor: resolve(rootDir, "plan-editor.html"),
        expenseEntry: resolve(rootDir, "expense-entry.html"),
        itineraryEditor: resolve(rootDir, "itinerary-editor.html"),
      },
    },
  },
});
