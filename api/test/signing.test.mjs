import test from "node:test";
import assert from "node:assert/strict";

// config.js を読む前に必須の環境変数を用意する。
process.env.API_TOKEN ||= "test-api-token";
process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { hmac } = await import("../dist/signing.js");

test("hmac is deterministic, 32 bytes, and input-sensitive", () => {
  const a = hmac("hello");
  assert.ok(Buffer.isBuffer(a));
  assert.equal(a.length, 32);
  assert.deepEqual(hmac("hello"), a);
  assert.notDeepEqual(hmac("hell0"), a);
  assert.notDeepEqual(hmac(""), a);
});
