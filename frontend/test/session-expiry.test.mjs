import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const source = (name) => fs.readFileSync(new URL(`src/${name}`, root), "utf8");

test("session_required clears the stale browser session and emits an expiry event", () => {
  const db = source("shared/db.ts");
  assert.match(db, /const code = responseErrorCode\(text\)[\s\S]*res\.status === 401 && code === "session_required"/);
  assert.match(db, /localStorage\.removeItem\(SESSION_STORAGE_KEY\)/);
  assert.match(db, /CustomEvent\("trip-session-expired"\)/);
});

test("account state and AI UI react to an expired API session", () => {
  const accounts = source("shared/account-store.ts");
  const editor = source("plan-editor/main.ts");
  assert.match(accounts, /addEventListener\("trip-session-expired"/);
  assert.match(accounts, /clearLocalSession\(\)/);
  assert.match(editor, /別タブで再ログイン/);
});
