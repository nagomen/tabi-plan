import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("AIエラーは復旧操作つきパネルとして表示する", () => {
  const html = read("plan-editor.html");
  assert.match(html, /data-ai-error\b/);
  assert.match(html, /data-ai-error-action/);
  assert.match(html, /data-ai-error-reference/);
  const editor = read("src/plan-editor/main.ts");
  assert.match(editor, /showAiError\(error, "candidates"\)/);
  assert.match(editor, /showAiError\(error, "itinerary"\)/);
  assert.match(editor, /retryWaitLabel\(/);
  assert.match(editor, /問い合わせ番号/);
});

test("APIのエラー契約(code/action/retry_after/request_id)を画面操作へ変換する", () => {
  const guidance = read("src/plan-editor/ai-error-guidance.ts");
  for (const code of [
    "ai_rate_limited", "ai_quota_exceeded", "ai_content_filtered", "ai_refused",
    "ai_daily_limit", "ai_cooldown", "ai_timeout",
    "client_offline", "client_timeout", "client_network_failed",
    "session_required", "invalid_ai_input",
  ]) {
    assert.match(guidance, new RegExp(`"${code}"`), `${code} を画面契約が扱う`);
  }
  const db = read("src/shared/db.ts");
  assert.match(db, /retryable = parsed\.retryable === true/);
  assert.match(db, /request_id/);
  assert.match(db, /use_external_ai/);
  assert.match(db, /AI機能はログインユーザーのみ利用できます/);
  assert.match(db, /AbortSignal\.timeout\(aiPath \? 90_000 : 30_000\)/);
  assert.match(db, /navigator\.onLine === false/);
  assert.match(guidance, /action: "external_ai"/);
  assert.match(guidance, /プロンプトをコピーしてChatGPTを開く/);
  const external = read("src/shared/external-ai.ts");
  assert.match(external, /buildExternalAiCreatePrompt/);
  assert.match(external, /buildExternalAiRefinePrompt/);
  assert.match(external, /tabi-plan-external-ai-v1/);
  assert.match(external, /parseExternalAiCreateJson/);
  assert.match(external, /parseExternalAiRefineJson/);
  assert.match(external, /clipboard\.writeText/);
});
