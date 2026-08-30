import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * SESSION_SECRET を鍵にした HMAC-SHA256。
 * セッショントークン・LINE の state・AI相談トークンの署名で共有する。
 */
export function hmac(value: string): Buffer {
  return crypto.createHmac("sha256", config.sessionSecret).update(value, "utf8").digest();
}
