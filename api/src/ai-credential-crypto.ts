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

export interface DecryptedAiCredential {
  apiKey: string;
  /** 旧マスターキーで復号した。現行鍵で保存し直す必要がある。 */
  needsReencrypt: boolean;
}

function encryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256")
    .update(`tabi-plan:user-ai-credential:v${VERSION}:`, "utf8")
    .update(secret, "utf8")
    .digest();
}

function additionalData(userId: string): Buffer {
  return Buffer.from(`tabi-plan:${userId}:openai:v${VERSION}`, "utf8");
}

/**
 * 復号で試すマスターキー。現行鍵を先に試し、ローテーション中だけ旧鍵も試す。
 * GCMの認証タグが合わない鍵は必ず失敗するため、取り違えは起こらない。
 */
function decryptionSecrets(): string[] {
  const current = config.ai.credentialEncryptionKey;
  const previous = config.ai.credentialEncryptionKeyPrevious;
  return previous && previous !== current ? [current, previous] : [current];
}

/** 任意のマスターキーで暗号化する。鍵ローテーションの検証と移行ツール専用。 */
export function encryptWithSecret(userId: string, apiKey: string, secret: string): EncryptedAiCredential {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
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

/** APIキーは認証情報専用テーブルへAES-256-GCMで暗号化して保存する。 */
export function encryptAiCredential(userId: string, apiKey: string): EncryptedAiCredential {
  return encryptWithSecret(userId, apiKey, config.ai.credentialEncryptionKey);
}

export function decryptAiCredential(userId: string, encrypted: {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}): DecryptedAiCredential {
  if (encrypted.keyVersion !== VERSION) throw new Error("unsupported AI credential key version");
  const secrets = decryptionSecrets();
  let lastError: unknown = new Error("no AI credential encryption key is configured");
  for (const [index, secret] of secrets.entries()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), encrypted.iv);
      decipher.setAAD(additionalData(userId));
      decipher.setAuthTag(encrypted.authTag);
      const apiKey = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
      return { apiKey, needsReencrypt: index > 0 };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function validOpenAiApiKey(value: string): boolean {
  // project keyを含む現在のsk-*形式を許可し、空白や制御文字、過大入力を拒否する。
  return !value.startsWith("sk-admin-") && /^sk-[A-Za-z0-9_-]{20,512}$/.test(value);
}
