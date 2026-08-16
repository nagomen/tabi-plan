import mysql from "mysql2/promise";
import { pool, type Row } from "./db.js";
import { BadRequest } from "./errors.js";

export function safeUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString().slice(0, 1024);
  } catch {
    // Relative URLs are allowed for local static assets.
  }
  if (/^(?:\.{0,2}\/|\/)[^\s<>"']{1,1024}$/.test(raw) && !raw.startsWith("//")) return raw.slice(0, 1024);
  return "";
}

export async function activeMemberIds(
  planId: string,
  conn: mysql.PoolConnection | mysql.Pool = pool,
): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    "SELECT user_id FROM plan_members WHERE plan_id = ? AND status = 'active'",
    [planId],
  );
  return (rows as unknown as { user_id: string }[]).map((row) => row.user_id);
}

export async function activeMemberSet(
  planId: string,
  conn: mysql.PoolConnection | mysql.Pool = pool,
): Promise<Set<string>> {
  return new Set(await activeMemberIds(planId, conn));
}

export function assertMember(memberIds: Set<string>, userId: string, label: string): void {
  if (!userId || !memberIds.has(userId)) throw new BadRequest(`${label} は有効な計画参加者である必要があります`);
}

export function friendshipPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
