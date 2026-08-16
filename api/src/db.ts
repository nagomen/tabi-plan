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
  charset: "utf8mb4",
  dateStrings: true,
  supportBigNumbers: true,
});

export type Row = mysql.RowDataPacket;

export async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<Row[]>(sql, params);
  return rows as unknown as T[];
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

export async function withTransaction<T>(
  work: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
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
    throw error;
  } finally {
    connection.release();
  }
}
