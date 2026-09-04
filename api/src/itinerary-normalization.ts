/** AI旅程の初回生成と会話修正で共有する正規化・検証。 */
export function normalizedPlaceName(value: string): string {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "");
}

/** 「盛岡」と「盛岡市」のように行政区分だけ補われた都市名を同一視する。 */
export function cityNamesEquivalent(left: string, right: string): boolean {
  const exactLeft = normalizedPlaceName(left);
  const exactRight = normalizedPlaceName(right);
  if (!exactLeft || !exactRight) return false;
  if (exactLeft === exactRight) return true;
  const cityKey = (value: string): string => normalizedPlaceName(value)
    .replace(/[・･,，.。'’"“”()（）\[\]＿_\-—–]/gu, "")
    .replace(/^.+?[都道府県](?=.+)/u, "")
    .replace(/(?:prefecture|city|ward|town|village)$/u, "")
    .replace(/[都道府県市区町村]$/u, "");
  const leftKey = cityKey(left);
  const rightKey = cityKey(right);
  return Boolean(leftKey) && leftKey === rightKey;
}

export function strictTimeMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function validCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}
