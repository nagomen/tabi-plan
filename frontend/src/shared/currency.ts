// 通貨の最小単位と換算レートの扱い。費用の入力・保存・表示で同じ規則を使う。
//
// DB は amount_minor（その通貨の最小単位）と fx_rate を持つ。
// fx_rate は「base_currency の最小単位 ÷ その通貨の最小単位」で、
// amount_base_minor = round(amount_minor * fx_rate) が計画の基準通貨での額になる。
// 画面の入力欄は人が読む単位（major）なので、境界の変換はこのモジュールへ集約する。

/** ISO 4217 で小数部を持たない通貨。ここに無いものは 2 桁として扱う。 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function currencyDecimals(code: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(String(code || "").toUpperCase()) ? 0 : 2;
}

/** 金額入力欄の step。円は 1、セントを持つ通貨は 0.01。 */
export function currencyStep(code: string): string {
  return currencyDecimals(code) === 0 ? "1" : "0.01";
}

/** 人が入力した額（major）を保存単位（minor）へ。 */
export function toMinor(major: number, code: string): number {
  return Math.round((Number(major) || 0) * 10 ** currencyDecimals(code));
}

/** 保存単位（minor）を人が読む額（major）へ。 */
export function toMajor(minor: number, code: string): number {
  return (Number(minor) || 0) / 10 ** currencyDecimals(code);
}

/**
 * 「1 <currency> = unitRate <base>」という入力から fx_rate を求める。
 * 例: 1 HKD = 19.5 円 なら、HKD は 100 minor で 1950 円 minor なので 0.195。
 * 入力が不正なら 0 を返し、呼び出し側で保存を止める。
 */
export function fxRateFromUnitRate(unitRate: number, currency: string, baseCurrency: string): number {
  const rate = Number(unitRate) || 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate * 10 ** currencyDecimals(baseCurrency) / 10 ** currencyDecimals(currency);
}

/** 保存済みの fx_rate を入力欄の「1 <currency> = ? <base>」へ戻す。 */
export function unitRateFromFxRate(fxRate: number, currency: string, baseCurrency: string): number {
  const rate = Number(fxRate) || 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate * 10 ** currencyDecimals(currency) / 10 ** currencyDecimals(baseCurrency);
}

/** 最小単位の額を通貨つきで表示する。 */
export function formatMoneyMinor(minor: number, code: string): string {
  const currency = String(code || "JPY").toUpperCase();
  const decimals = currencyDecimals(currency);
  const text = toMajor(minor, currency).toLocaleString("ja-JP", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return currency === "JPY" ? `¥${text}` : `${currency} ${text}`;
}
