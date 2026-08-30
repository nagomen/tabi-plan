// プロセス内・固定窓のレート制限。DB非依存で単体テストできる。

export interface RateBucket {
  count: number;
  resetAt: number;
}

/** key の窓を1つ消費する。上限を超えたら true（＝拒否）。 */
export function rateLimited(
  buckets: Map<string, RateBucket>,
  key: string,
  limit: number,
  now: number = Date.now(),
  windowMs = 60_000,
): boolean {
  const slot = buckets.get(key);
  if (!slot || now >= slot.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  slot.count += 1;
  return slot.count > limit;
}

/** 期限切れの窓を掃除して、溜まりっぱなしを防ぐ。 */
export function sweepExpired(buckets: Map<string, RateBucket>, now: number = Date.now()): void {
  for (const [key, slot] of buckets) if (now >= slot.resetAt) buckets.delete(key);
}
