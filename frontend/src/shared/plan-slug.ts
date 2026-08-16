const MAX_PLAN_SLUG_LENGTH = 64;

type TokenFactory = (attempt: number) => string;

function randomToken(attempt: number): string {
  const values = new Uint32Array(1);
  try {
    globalThis.crypto.getRandomValues(values);
  } catch {
    values[0] = Math.floor(Math.random() * 0xffff_ffff);
  }
  return `${Date.now().toString(36)}${values[0].toString(36)}${attempt.toString(36)}`;
}

/**
 * 非公開計画のslug一覧をブラウザへ漏らさず、新規計画のURLを衝突しにくくする。
 * 可視計画の連番から「空き番号」を探す方式だと、不可視の招待制計画と衝突する。
 */
export function collisionResistantPlanSlug(
  normalizedBase: string,
  isTaken: (candidate: string) => boolean,
  tokenFactory: TokenFactory = randomToken,
): string {
  const root = (normalizedBase || "trip").slice(0, 45).replace(/-+$/g, "") || "trip";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const token = tokenFactory(attempt).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || String(attempt);
    const candidate = `${root}-${token}`.slice(0, MAX_PLAN_SLUG_LENGTH);
    if (!isTaken(candidate)) return candidate;
  }
  // tokenFactoryをテスト等で固定していても最後は時刻を足し、同じ候補を返さない。
  return `${root}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`
    .slice(0, MAX_PLAN_SLUG_LENGTH);
}
