import crypto from "node:crypto";
import { config } from "./config.js";
import { createDebtShareToken, debtShareTokenHash, isDebtShareToken } from "./debt-share-token.js";

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function key(): Buffer {
  return crypto.createHash("sha256")
    .update("tabi-plan:debt-action-token:v1:", "utf8")
    .update(config.sessionSecret, "utf8")
    .digest();
}

function aad(planId: string): Buffer {
  return Buffer.from(`tabi-plan:${planId}:debt-action:v${VERSION}`, "utf8");
}

export function createDebtActionToken(): string {
  return createDebtShareToken();
}

export function debtActionTokenHash(token: string): Buffer {
  return debtShareTokenHash(token);
}

export function isDebtActionToken(token: string): boolean {
  return isDebtShareToken(token);
}

/** リマインダーメールへ操作URLを載せるため、生トークンはAES-GCMで暗号化して保存する。 */
export function encryptDebtActionToken(planId: string, token: string): Buffer {
  if (!isDebtActionToken(token)) throw new Error("invalid debt action token");
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(planId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptDebtActionToken(planId: string, packed: Buffer): string {
  if (packed.length <= 1 + IV_LENGTH + TAG_LENGTH || packed[0] !== VERSION) {
    throw new Error("unsupported debt action token ciphertext");
  }
  const iv = packed.subarray(1, 1 + IV_LENGTH);
  const tag = packed.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(1 + IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(aad(planId));
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (!isDebtActionToken(token)) throw new Error("invalid decrypted debt action token");
  return token;
}
