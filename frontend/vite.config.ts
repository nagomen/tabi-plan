import { defineConfig, type Plugin } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const rootDir = dirname(fileURLToPath(import.meta.url));
const localApiProxyTarget = process.env.LOCAL_API_PROXY_TARGET?.trim() || "";
// プラン以外のドメインデータ（ユーザー・費用・送金リンク）の保存先。
// backend.ts が write-through する。1キー=1ファイル（data/store/<key>.json）。
const storeDir = resolve(rootDir, "../data/store");

/**
 * フルスタック開発時はブラウザから同一Originの /api を呼ばせる。
 * trip-config.js 本体は本番API設定のまま保ち、serve時のHTMLだけ上書きする。
 */
function devApiProxyConfig(): Plugin {
  return {
    name: "dev-api-proxy-config",
    apply: "serve",
    transformIndexHtml() {
      if (!localApiProxyTarget) return [];
      return [{
        tag: "script",
        injectTo: "body",
        children: `if(window.TRIP_CONFIG?.sharedBackend){window.TRIP_CONFIG.sharedBackend.apiBaseUrl="";}`,
      }];
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
 * 開発サーバー限定: backend.ts のドメインデータ（プラン以外）を
 * data/store/<key>.json に永続化する。
 *  - transformIndexHtml で window.__DEV_STORE__ に全ファイルを注入
 *  - /api/store/<key> への PUT/DELETE でファイルを書き込み/削除（dev サーバのみ）
 *
 * `apply: "serve"` なので本番ビルドには含まれない（本番は共有ストア API が正）。
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
    // ブートクロークは全ブラウザで当てる。組み立て前の素の HTML
    // （原寸のアイコン・素の見出し）が一瞬見えるのを防ぐ。
    // ネイティブ遷移があるブラウザでは page-transition.ts が
    // pagereveal で先に ui-ready を付けるので、遷移が空のページを
    // 写すことはない。JS が動かない場合も 0.8 秒で必ず表示へ戻す。
    "@keyframes uiBootFailsafe{to{opacity:1}}",
    "html:not(.ui-ready){opacity:0;animation:uiBootFailsafe .001s linear .8s both}",
    "@media (prefers-reduced-motion:reduce){",
    "::view-transition-old(root),::view-transition-new(root){animation:none}",
    "}",
  ].join("");
  return {
    name: "page-transition-head",
    transformIndexHtml() {
      return [
        { tag: "style", injectTo: "head-prepend", children: css },
      ];
    },
  };
}

/** GitHub Pagesでもブラウザが強制できる最低限のセキュリティポリシー。 */
function securityMetaHead(): Plugin {
  const content = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: ws: wss:",
    "frame-src 'self' https:",
    "form-action 'self' https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
  return {
    name: "security-meta-head",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          injectTo: "head-prepend",
          attrs: { "http-equiv": "Content-Security-Policy", content },
        },
        {
          tag: "meta",
          injectTo: "head-prepend",
          attrs: { name: "referrer", content: "strict-origin-when-cross-origin" },
        },
      ];
    },
  };
}

/** Service Worker が初回install時から、生成されたハッシュ付きJS/CSSを保存できる一覧。 */
function serviceWorkerAssetManifest(): Plugin {
  return {
    name: "service-worker-asset-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((file) => /\.(?:js|css)$/.test(file))
        .map((file) => `./${file}`)
        .sort();
      this.emitFile({
        type: "asset",
        fileName: "asset-manifest.json",
        source: JSON.stringify({ assets }),
      });
    },
  };
}

// 複数ページ（ダッシュボード / 計画一覧 / 計画エディタなど）を
// それぞれ独立した HTML エントリとしてビルドする。
// GitHub Pages のプロジェクトサイトでも動くよう base は相対パスにする。
export default defineConfig({
  base: "./",
  root: ".",
  publicDir: "public",
  plugins: [
    securityMetaHead(),
    pageTransitionHead(),
    serviceWorkerAssetManifest(),
    ...(!localApiProxyTarget ? [devStoreFiles()] : []),
    devApiProxyConfig(),
  ],
  server: {
    open: true,
    proxy: localApiProxyTarget
      ? {
          "/api": {
            target: localApiProxyTarget,
            // ブラウザには同一Origin。APIへはサーバー間通信として転送する。
            configure(proxy) {
              proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("origin"));
            },
          },
        }
      : undefined,
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
      },
    },
  },
});
