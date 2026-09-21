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
  const consultation = read("src/plan-editor/ai-consultation.ts");
  assert.match(consultation, /showAiError\(error, "candidates"\)/);
  assert.match(consultation, /showAiError\(error, "itinerary"\)/);
  assert.match(consultation, /retryWaitLabel\(/);
  assert.match(consultation, /問い合わせ番号/);
});

test("APIのエラー契約(code/action/retry_after/request_id)を画面操作へ変換する", () => {
  const guidance = read("src/plan-editor/ai-error-guidance.ts");
  const consultation = read("src/plan-editor/ai-consultation.ts");
  for (const code of [
    "ai_rate_limited", "ai_quota_exceeded", "ai_content_filtered", "ai_refused",
    "ai_daily_limit", "ai_output_too_long", "ai_cooldown", "ai_timeout",
    "client_offline", "client_timeout", "client_network_failed",
    "session_required", "invalid_ai_input",
    "ai_key_required",
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
  assert.match(guidance, /code === "ai_output_too_long"/);
  assert.match(guidance, /ChatGPTで旅行案を作る/);
  assert.match(guidance, /action: "update_api_key"/);
  assert.match(consultation, /mypage\.html\?tab=pay#ai-key/);
  const external = read("src/shared/external-ai.ts");
  assert.match(external, /buildExternalAiCreatePrompt/);
  assert.match(external, /buildExternalAiRefinePrompt/);
  assert.match(external, /tabi-plan-external-ai-v1/);
  assert.match(external, /parseExternalAiCreateJson/);
  assert.match(external, /parseExternalAiRefineJson/);
  assert.match(external, /clipboard\.writeText/);
  const dashboardChat = read("src/dashboard/ai-chat.ts");
  assert.match(dashboardChat, /latestExternalPrompt/);
  assert.match(dashboardChat, /showApiKeySetup/);
  assert.match(dashboardChat, /mypage\.html\?tab=pay#ai-key/);
});

test("ChatGPTを開く操作はリンクにして、ポップアップ遮断で無反応にならない", () => {
  // window.open はモバイルブラウザでポップアップとして塞がれ、押しても
  // 何も起きない見え方になる。既定動作で開くリンクに固定する。
  const dashboardHtml = read("index.html");
  assert.match(dashboardHtml, /<a[^>]*data-ai-chat-import-open[^>]*href="https:\/\/chatgpt\.com\/"[^>]*target="_blank"/);
  const editorHtml = read("plan-editor.html");
  assert.match(editorHtml, /<a[^>]*data-ai-import-open[^>]*href="https:\/\/chatgpt\.com\/"[^>]*target="_blank"/);
  const dashboardChat = read("src/dashboard/ai-chat.ts");
  assert.match(dashboardChat, /data-ai-external="\$\{index\}" href="\$\{externalAiUrl\("chatgpt"\)\}"/);
  assert.doesNotMatch(dashboardChat, /openExternalAi/);
  const consultation = read("src/plan-editor/ai-consultation.ts");
  assert.doesNotMatch(consultation, /onAiImportOpenClick[\s\S]{0,200}openExternalAi/);
  // 自分のAPIキーへの導線を、AIを使う画面の両方から常に出す。
  assert.match(dashboardHtml, /mypage\.html\?tab=pay#ai-key/);
  assert.match(editorHtml, /mypage\.html\?tab=pay#ai-key/);
  assert.match(read("src/mypage/main.ts"), /scrollToHashTarget/);
});

test("ポップアップ遮断を見分けられる形で開き、塞がれても行き止まりにしない", () => {
  // window.open の第3引数に noopener を渡すと戻り値が常に null になり、
  // 遮断されたのかどうかを判定できなくなる。
  const external = read("src/shared/external-ai.ts");
  assert.doesNotMatch(external, /window\.open\([^)]*noopener/);
  assert.match(external, /opened\.opener = null/);
  const consultation = read("src/plan-editor/ai-consultation.ts");
  assert.doesNotMatch(consultation, /window\.open\([^)]*noopener/);
  // 同一オリジンの行き先は同じタブへ、ChatGPT は貼り付け先を失うので案内に留める。
  assert.match(consultation, /function openSitePage[\s\S]*location\.assign\(url\)/);
  assert.match(consultation, /ChatGPT（chatgpt\.com）を開いて貼り付けてください/);
});

test("AI利用枠切れは管理者待ちにせずAPIキー設定へ案内する", () => {
  const guidance = read("src/plan-editor/ai-error-guidance.ts");
  const support = /const SUPPORT_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(guidance);
  assert.ok(support, "SUPPORT_CODES を読み取れる");
  assert.doesNotMatch(support[1], /ai_quota_exceeded/);
  assert.match(guidance, /const API_KEY_CODES = new Set\(\["ai_key_required", "ai_quota_exceeded"\]\)/);
  assert.match(guidance, /API_KEY_CODES\.has\(code\) \|\| error\.action === "update_api_key"/);
});
