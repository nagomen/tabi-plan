// kv_store へのアクセス。SQL はここだけに閉じる。

import mysql from "mysql2/promise";
import { config } from "./config.js";

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 8,
  charset: "utf8mb4",
  // JSON 列は mysql2 が自動で parse する
});

const SCOPE = "default";

export interface StoreEntry {
  value: unknown;
  version: number;
}

/** 全件を { key: value } と { key: version } で返す（preload 用）。 */
export async function dump(): Promise<{ store: Record<string, unknown>; versions: Record<string, number> }> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT k, v, version FROM kv_store WHERE scope = ?",
    [SCOPE],
  );
  const store: Record<string, unknown> = {};
  const versions: Record<string, number> = {};
  for (const row of rows) {
    // mysql2 は JSON 列を parse 済みで返すが、driver 設定次第で文字列のこともある
    store[row.k] = typeof row.v === "string" ? JSON.parse(row.v) : row.v;
    versions[row.k] = Number(row.version);
  }
  return { store, versions };
}

export async function get(key: string): Promise<StoreEntry | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT v, version FROM kv_store WHERE scope = ? AND k = ?",
    [SCOPE, key],
  );
  const row = rows[0];
  if (!row) return null;
  return { value: typeof row.v === "string" ? JSON.parse(row.v) : row.v, version: Number(row.version) };
}

export class VersionConflict extends Error {
  constructor(readonly current: StoreEntry) {
    super("version conflict");
  }
}

/**
 * 値を書き込む。
 * expectedVersion を渡した場合、手元の版と一致するときだけ更新する（楽観ロック）。
 * 一致しなければ VersionConflict を投げ、呼び出し側は現在値を受け取ってマージし直す。
 * expectedVersion を渡さなければ後勝ちで上書きする。
 */
export async function put(key: string, value: unknown, expectedVersion?: number): Promise<StoreEntry> {
  const json = JSON.stringify(value);

  if (expectedVersion === undefined) {
    await pool.query(
      `INSERT INTO kv_store (scope, k, v, version) VALUES (?, ?, CAST(? AS JSON), 1)
       ON DUPLICATE KEY UPDATE v = VALUES(v), version = version + 1`,
      [SCOPE, key, json],
    );
    const saved = await get(key);
    if (!saved) throw new Error("保存直後の読み出しに失敗しました");
    return saved;
  }

  if (expectedVersion === 0) {
    // 新規作成のつもり。既にあれば衝突として返す。
    try {
      await pool.query("INSERT INTO kv_store (scope, k, v, version) VALUES (?, ?, CAST(? AS JSON), 1)", [
        SCOPE,
        key,
        json,
      ]);
      return { value, version: 1 };
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        const current = await get(key);
        if (current) throw new VersionConflict(current);
      }
      throw error;
    }
  }

  const [result] = await pool.query<mysql.ResultSetHeader>(
    "UPDATE kv_store SET v = CAST(? AS JSON), version = version + 1 WHERE scope = ? AND k = ? AND version = ?",
    [json, SCOPE, key, expectedVersion],
  );
  if (result.affectedRows === 0) {
    const current = await get(key);
    throw new VersionConflict(current ?? { value: null, version: 0 });
  }
  return { value, version: expectedVersion + 1 };
}

export async function remove(key: string): Promise<void> {
  await pool.query("DELETE FROM kv_store WHERE scope = ? AND k = ?", [SCOPE, key]);
}

export async function ping(): Promise<void> {
  await pool.query("SELECT 1");
}
