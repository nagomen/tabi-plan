/** AI・編集画面・DBで共通利用する移動時間の表示/保存変換。 */
export function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (!hours) return `${rest}分`;
  return rest ? `${hours}時間${rest}分` : `${hours}時間`;
}

export function parseDurationMinutes(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const hours = /([0-9]+(?:\.[0-9]+)?)\s*(?:h|時間)/i.exec(raw);
  const minutes = /([0-9]+)\s*(?:m|分)/i.exec(raw);
  if (!hours && !minutes) return null;
  return Math.round(Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0));
}
