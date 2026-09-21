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

/** ISO 4217 で補助通貨単位が3桁の通貨。 */
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

export function currencyDecimals(code: string): number {
  const currency = String(code || "").toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

/** 金額入力欄の step。通貨の補助通貨単位に合わせる。 */
export function currencyStep(code: string): string {
  const decimals = currencyDecimals(code);
  return decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
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

/**
 * 通貨コードと国旗の対応。「MOP」「XPF」だけでは何の通貨か分からないため、
 * 選択肢には旗を添える。ユーロのように国が特定できないものはEU旗を使う。
 */
const CURRENCY_FLAG: Record<string, string> = {
  JPY: "🇯🇵", USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", CHF: "🇨🇭",
  HKD: "🇭🇰", MOP: "🇲🇴", TWD: "🇹🇼", KRW: "🇰🇷", CNY: "🇨🇳", MNT: "🇲🇳",
  THB: "🇹🇭", VND: "🇻🇳", LAK: "🇱🇦", KHR: "🇰🇭", MMK: "🇲🇲", MYR: "🇲🇾", BND: "🇧🇳",
  PHP: "🇵🇭", IDR: "🇮🇩", SGD: "🇸🇬",
  INR: "🇮🇳", NPR: "🇳🇵", BTN: "🇧🇹", BDT: "🇧🇩", LKR: "🇱🇰", MVR: "🇲🇻", PKR: "🇵🇰",
  KZT: "🇰🇿", UZS: "🇺🇿", GEL: "🇬🇪", AMD: "🇦🇲", AZN: "🇦🇿",
  AED: "🇦🇪", SAR: "🇸🇦", QAR: "🇶🇦", KWD: "🇰🇼", BHD: "🇧🇭", OMR: "🇴🇲",
  JOD: "🇯🇴", ILS: "🇮🇱", LBP: "🇱🇧", TRY: "🇹🇷",
  CZK: "🇨🇿", PLN: "🇵🇱", HUF: "🇭🇺", BAM: "🇧🇦", RSD: "🇷🇸", MKD: "🇲🇰", ALL: "🇦🇱",
  BGN: "🇧🇬", RON: "🇷🇴", MDL: "🇲🇩", UAH: "🇺🇦", BYN: "🇧🇾", RUB: "🇷🇺",
  DKK: "🇩🇰", SEK: "🇸🇪", NOK: "🇳🇴", ISK: "🇮🇸",
  MAD: "🇲🇦", TND: "🇹🇳", DZD: "🇩🇿", EGP: "🇪🇬", XOF: "🇸🇳", GHS: "🇬🇭", NGN: "🇳🇬",
  ETB: "🇪🇹", KES: "🇰🇪", TZS: "🇹🇿", UGX: "🇺🇬", RWF: "🇷🇼",
  ZAR: "🇿🇦", NAD: "🇳🇦", BWP: "🇧🇼", MUR: "🇲🇺",
  CAD: "🇨🇦", MXN: "🇲🇽", GTQ: "🇬🇹", CRC: "🇨🇷", CUP: "🇨🇺", DOP: "🇩🇴", JMD: "🇯🇲", BSD: "🇧🇸",
  COP: "🇨🇴", VES: "🇻🇪", PEN: "🇵🇪", BOB: "🇧🇴", BRL: "🇧🇷", PYG: "🇵🇾", UYU: "🇺🇾",
  CLP: "🇨🇱", ARS: "🇦🇷",
  AUD: "🇦🇺", NZD: "🇳🇿", FJD: "🇫🇯", PGK: "🇵🇬", XPF: "🇵🇫",
};

export function currencyFlag(code: string): string {
  return CURRENCY_FLAG[String(code || "").toUpperCase()] || "";
}

/** 選択肢に出す「🇭🇰 HKD」。旗を知らない通貨はコードだけを返す。 */
export function currencyLabel(code: string): string {
  const currency = String(code || "").toUpperCase();
  const flag = currencyFlag(currency);
  return flag ? `${flag} ${currency}` : currency;
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
