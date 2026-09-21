import crypto from "node:crypto";
import { config } from "./config.js";

const VERSION = 1;

export interface EncryptedAiCredential {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
  lastFour: string;
}

function encryptionKey(): Buffer {
  return crypto.createHash("sha256")
    .update(`tabi-plan:user-ai-credential:v${VERSION}:`, "utf8")
    .update(config.ai.credentialEncryptionKey, "utf8")
    .digest();
}

function additionalData(userId: string): Buffer {
  return Buffer.from(`tabi-plan:${userId}:openai:v${VERSION}`, "utf8");
}

/** APIキーは認証情報専用テーブルへAES-256-GCMで暗号化して保存する。 */
export function encryptAiCredential(userId: string, apiKey: string): EncryptedAiCredential {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(additionalData(userId));
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion: VERSION,
    lastFour: apiKey.slice(-4),
  };
}

export function decryptAiCredential(userId: string, encrypted: {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}): string {
  if (encrypted.keyVersion !== VERSION) throw new Error("unsupported AI credential key version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), encrypted.iv);
  decipher.setAAD(additionalData(userId));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}

export function validOpenAiApiKey(value: string): boolean {
  // project keyを含む現在のsk-*形式を許可し、空白や制御文字、過大入力を拒否する。
  return !value.startsWith("sk-admin-") && /^sk-[A-Za-z0-9_-]{20,512}$/.test(value);
}
