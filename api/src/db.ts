import mysql from "mysql2/promise";
import { config } from "./config.js";

/** APIプロセス全体で共有する唯一のMySQL接続プール。 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 8,
  // 詰まったときは待ち行列を無限に伸ばさず、待機50件で即エラーにして
  // 503（db_unavailable）へ変換する。無限待ちは前段プロキシの
  // タイムアウトで CORS 無しの切断になり、原因が画面から見えなくなる。
  queueLimit: 50,
  // maxIdle を connectionLimit 未満にすると mysql2 が unref されない常駐タイマーを
  // 張り、プロセスが終了できなくなるため使わない。MySQL 側で切られた接続は
  // keepalive と、失敗時の 503（retry_after 付き）分類で吸収する。
  enableKeepAlive: true,
  connectTimeout: 10_000,
  charset: "utf8mb4",
  dateStrings: true,
  supportBigNumbers: true,
});

export type Row = mysql.RowDataPacket;

export async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<Row[]>(sql, params);
  return rows as unknown as T[];
}

/** 単一行取得。トランザクション接続でもプールでも使える（`... LIMIT 1`／`FOR UPDATE` 向け）。 */
export async function firstRow<T>(
  executor: mysql.Pool | mysql.PoolConnection,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const [rows] = await executor.query<Row[]>(sql, params);
  return (rows as unknown as T[])[0];
}

export function inClause(ids: string[]): { sql: string; params: string[] } {
  return { sql: ids.map(() => "?").join(","), params: ids };
}

export async function pingDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/**
 * デッドロックはロールバック済みなら再実行しても安全なので、短い待ちを挟んで
 * 限定回数だけやり直す。ロック待ちタイムアウトは再試行しても待ちが延びるだけ
 * なので、即座に 503（server_busy）へ分類させる。
 */
const TRANSACTION_RETRIES = 2;
const isDeadlock = (error: unknown): boolean =>
  String((error as { code?: string })?.code || "") === "ER_LOCK_DEADLOCK";

export async function withTransaction<T>(
  work: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      // MySQL 既定の 50 秒待ちは全接続を巻き込むため、短く失敗させて再試行に回す。
      await connection.query("SET SESSION innodb_lock_wait_timeout = 10");
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("[travel-api] transaction rollback failed", rollbackError);
      }
      if (attempt < TRANSACTION_RETRIES && isDeadlock(error)) {
        console.warn("[travel-api] transaction retry", JSON.stringify({
          code: String((error as { code?: string }).code || ""),
          attempt: attempt + 1,
        }));
        await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt) + Math.random() * 50));
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
