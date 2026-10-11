import crypto from "node:crypto";

/** 256 bit の bearer token。base64url では常に43文字になる。 */
export function createDebtShareToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function isDebtShareToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** 生トークンはDBへ保存せず、照合用のSHA-256だけを保持する。 */
export function debtShareTokenHash(token: string): Buffer {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}
