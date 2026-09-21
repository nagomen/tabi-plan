import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.AI_CREDENTIAL_ENCRYPTION_KEY ||= "test-ai-credential-encryption-key-0123456789";
// ローテーション中の状態を再現する。旧鍵の暗号文も開けなければならない。
const PREVIOUS_KEY = "test-ai-credential-previous-key-9876543210";
process.env.AI_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ||= PREVIOUS_KEY;
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const {
  decryptAiCredential, encryptAiCredential, encryptWithSecret, validOpenAiApiKey,
} = await import("../dist/ai-credential-crypto.js");

test("本人のAPIキーを認証付き暗号で往復し、平文を保存データへ残さない", () => {
  const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const encrypted = encryptAiCredential("usr_1", apiKey);
  assert.deepEqual(decryptAiCredential("usr_1", encrypted), { apiKey, needsReencrypt: false });
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.authTag.length, 16);
  assert.equal(encrypted.lastFour, "6789");
  assert.equal(encrypted.ciphertext.includes(Buffer.from(apiKey)), false);
});

test("旧マスターキーの暗号文も復号でき、再暗号化が必要だと分かる", () => {
  const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const encrypted = encryptWithSecret("usr_1", apiKey, PREVIOUS_KEY);
  assert.deepEqual(decryptAiCredential("usr_1", encrypted), { apiKey, needsReencrypt: true });
  // 現行鍵で入れ直した行は、もう旧鍵を必要としない。
  assert.equal(decryptAiCredential("usr_1", encryptAiCredential("usr_1", apiKey)).needsReencrypt, false);
});

test("現行でも旧でもないマスターキーの暗号文は復号できない", () => {
  const encrypted = encryptWithSecret(
    "usr_1",
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "test-ai-credential-retired-key-1111111111",
  );
  assert.throws(() => decryptAiCredential("usr_1", encrypted));
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
