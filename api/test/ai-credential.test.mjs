import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.AI_CREDENTIAL_ENCRYPTION_KEY ||= "test-ai-credential-encryption-key-0123456789";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const {
  decryptAiCredential, encryptAiCredential, validOpenAiApiKey,
} = await import("../dist/ai-credential-crypto.js");

test("本人のAPIキーを認証付き暗号で往復し、平文を保存データへ残さない", () => {
  const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const encrypted = encryptAiCredential("usr_1", apiKey);
  assert.equal(decryptAiCredential("usr_1", encrypted), apiKey);
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.authTag.length, 16);
  assert.equal(encrypted.lastFour, "6789");
  assert.equal(encrypted.ciphertext.includes(Buffer.from(apiKey)), false);
});

test("暗号文は別ユーザーへ移しても復号できない", () => {
  const encrypted = encryptAiCredential("usr_owner", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
  assert.throws(() => decryptAiCredential("usr_other", encrypted));
});

test("OpenAIキー形式は空白・短すぎる値・過大入力を拒否する", () => {
  assert.equal(validOpenAiApiKey("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"), true);
  assert.equal(validOpenAiApiKey(" sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(validOpenAiApiKey("sk-short"), false);
  assert.equal(validOpenAiApiKey("sk-admin-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(validOpenAiApiKey(`sk-${"a".repeat(513)}`), false);
});
