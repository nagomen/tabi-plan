// リクエストボディなど型の緩い値を安全な型へ寄せる共有ヘルパー。
// HTTP層（server.ts / routes.ts）とrepo層で同じ実装を使い、検証規則の分裂を防ぐ。

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

export const strArr = (v: unknown): string[] => Array.isArray(v)
  ? v.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
  : [];

/** min〜max の有限数だけ通す。それ以外（空・不正・範囲外）は null。座標・日数・分数で共用する。 */
export function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

/** "YYYY-MM-DD" 形式だけ通す。それ以外（空・不正）は null。 */
export function safeDate(value: unknown): string | null {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
