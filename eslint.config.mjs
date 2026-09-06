// 最小構成のESLint。スタイルはtscと手書きの規約に任せ、型検査では捕まらない
// 「非同期の取りこぼし」と「層の越境」だけを検査する。
//
//   - no-floating-promises: await忘れのDB書き込みはtscもテストも通過してしまう。
//     意図した投げっぱなしは `void promise.catch(...)` で明示する。
//   - no-misused-promises: voidコールバック（setInterval等）へのasync関数の誤用を防ぐ。
//   - eqeqeq: 暗黙の型変換つき比較を禁止する。
//   - no-restricted-properties / imports: repository-structure.test.mjs が正規表現で
//     照合している層の規則を、エディタ内でも即時に見えるようにする。
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // 生成物は検査しない。
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  {
    files: ["api/src/**/*.ts", "frontend/src/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/no-misused-promises": "error",
      // `== null` は「null または undefined」の意図的な同値イディオムとして許す。
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // フロントの async イベントハンドラは意図した書き方。拒否は
    // session-notice.ts の unhandledrejection ハンドラが帯表示へ流すため、
    // コールバック引数のvoidチェックだけ緩める（それ以外の誤用検査は維持）。
    files: ["frontend/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
  {
    // トランザクションと接続の取得は db.ts の withTransaction に集約する。
    files: ["api/src/**/*.ts"],
    ignores: ["api/src/db.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "beginTransaction", message: "トランザクションは db.ts の withTransaction を使ってください。" },
        { property: "getConnection", message: "接続の取得は db.ts に集約してください。" },
      ],
    },
  },
  {
    // HTTP層はrepoを経由し、DBドライバへ直接触れない。
    files: ["api/src/server.ts", "api/src/routes.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "mysql2/promise", message: "HTTP層はrepo経由でDBへアクセスしてください。" }] },
      ],
    },
  },
);
