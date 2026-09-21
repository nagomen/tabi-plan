import type mysql from "mysql2/promise";
import { config } from "./config.js";
import { all, pool } from "./db.js";
import { decryptAiCredential, encryptAiCredential } from "./ai-credential-crypto.js";

interface AiCredentialRow extends mysql.RowDataPacket {
  encrypted_key: Buffer;
  encryption_iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  key_last4: string;
  verified_at: string;
  updated_at: string;
}

export interface AiCredentialStatus {
  configured: boolean;
  last_four: string;
  verified_at: string | null;
  updated_at: string | null;
  service_available: boolean;
}

export interface ResolvedAiCredential {
  apiKey: string;
  source: "user" | "service";
}

export async function credentialStatus(userId: string): Promise<AiCredentialStatus> {
  const rows = await all<Pick<AiCredentialRow, "key_last4" | "verified_at" | "updated_at">>(
    "SELECT key_last4, verified_at, updated_at FROM user_ai_credentials WHERE user_id = ? LIMIT 1",
    [userId],
  );
  const row = rows[0];
  return {
    configured: Boolean(row),
    last_four: row?.key_last4 || "",
    verified_at: row?.verified_at || null,
    updated_at: row?.updated_at || null,
    service_available: Boolean(config.ai.apiKey),
  };
}

export async function saveCredential(userId: string, apiKey: string): Promise<AiCredentialStatus> {
  const encrypted = encryptAiCredential(userId, apiKey);
  await pool.query(
    `INSERT INTO user_ai_credentials
       (user_id, encrypted_key, encryption_iv, auth_tag, key_version, key_last4, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       encrypted_key = VALUES(encrypted_key), encryption_iv = VALUES(encryption_iv),
       auth_tag = VALUES(auth_tag), key_version = VALUES(key_version),
       key_last4 = VALUES(key_last4), verified_at = CURRENT_TIMESTAMP`,
    [userId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion, encrypted.lastFour],
  );
  return credentialStatus(userId);
}

export async function deleteCredential(userId: string): Promise<void> {
  await pool.query("DELETE FROM user_ai_credentials WHERE user_id = ?", [userId]);
}

/** 本人キーを優先し、未登録なら従来のサービス共通キーへフォールバックする。 */
export async function resolveAiCredential(userId: string): Promise<ResolvedAiCredential | null> {
  const rows = await all<AiCredentialRow>(
    `SELECT encrypted_key, encryption_iv, auth_tag, key_version, key_last4, verified_at, updated_at
       FROM user_ai_credentials WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (row) {
    return {
      apiKey: decryptAiCredential(userId, {
        ciphertext: row.encrypted_key,
        iv: row.encryption_iv,
        authTag: row.auth_tag,
        keyVersion: Number(row.key_version),
      }),
      source: "user",
    };
  }
  return config.ai.apiKey ? { apiKey: config.ai.apiKey, source: "service" } : null;
}
