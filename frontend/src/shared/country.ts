// 緯度経度から国を判定する共有レジストリ。
// 人物ページの訪問国集計と、エディタの検索コンテキストで同じ定義を使う。
// 矩形が重なる地域は狭い国・地域を先に並べること。

export type CountryCode =
  | "HK" | "MO" | "SG" | "TW" | "KR" | "JP" | "IN" | "MN" | "CN" | "TH" | "VN" | "MY" | "PH" | "ID"
  | "NL" | "BE" | "CH" | "AT" | "CZ" | "PT" | "GB" | "ES" | "FR" | "DE" | "IT" | "GR" | "TR"
  | "AE" | "EG" | "MA" | "KE" | "ZA" | "NZ" | "AU" | "US" | "CA" | "MX"
  | "BO" | "UY" | "PY" | "PE" | "CL" | "AR" | "BR";

export interface Country {
  code: CountryCode;
  name: string;
  flag: string;
}

interface CountryBox extends Country {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

export const COUNTRY_BOXES: readonly CountryBox[] = [
  // 東アジア・東南アジア（小さい地域を先に）
  { code: "HK", name: "香港", flag: "🇭🇰", latMin: 22.1, latMax: 22.6, lngMin: 113.8, lngMax: 114.5 },
  { code: "MO", name: "マカオ", flag: "🇲🇴", latMin: 22.05, latMax: 22.25, lngMin: 113.5, lngMax: 113.65 },
  { code: "SG", name: "シンガポール", flag: "🇸🇬", latMin: 1.1, latMax: 1.6, lngMin: 103.5, lngMax: 104.1 },
  { code: "TW", name: "台湾", flag: "🇹🇼", latMin: 21, latMax: 27, lngMin: 118, lngMax: 123 },
  { code: "KR", name: "韓国", flag: "🇰🇷", latMin: 33, latMax: 39, lngMin: 124.5, lngMax: 131 },
  { code: "JP", name: "日本", flag: "🇯🇵", latMin: 24, latMax: 46, lngMin: 122.5, lngMax: 154 },
  { code: "IN", name: "インド", flag: "🇮🇳", latMin: 6, latMax: 36, lngMin: 68, lngMax: 98 },
  { code: "MN", name: "モンゴル", flag: "🇲🇳", latMin: 41, latMax: 53, lngMin: 87, lngMax: 120 },
  { code: "CN", name: "中国", flag: "🇨🇳", latMin: 18, latMax: 54, lngMin: 73, lngMax: 135 },
  { code: "TH", name: "タイ", flag: "🇹🇭", latMin: 5.5, latMax: 20.6, lngMin: 97, lngMax: 106 },
  { code: "VN", name: "ベトナム", flag: "🇻🇳", latMin: 8, latMax: 24, lngMin: 102, lngMax: 110 },
  { code: "MY", name: "マレーシア", flag: "🇲🇾", latMin: 0, latMax: 8, lngMin: 99, lngMax: 120 },
  { code: "PH", name: "フィリピン", flag: "🇵🇭", latMin: 4, latMax: 22, lngMin: 116, lngMax: 127 },
  { code: "ID", name: "インドネシア", flag: "🇮🇩", latMin: -11, latMax: 6, lngMin: 95, lngMax: 142 },

  // ヨーロッパ（小国を先に）
  { code: "NL", name: "オランダ", flag: "🇳🇱", latMin: 50.7, latMax: 53.7, lngMin: 3.2, lngMax: 7.3 },
  { code: "BE", name: "ベルギー", flag: "🇧🇪", latMin: 49.4, latMax: 51.6, lngMin: 2.4, lngMax: 6.5 },
  { code: "CH", name: "スイス", flag: "🇨🇭", latMin: 45.7, latMax: 47.9, lngMin: 5.8, lngMax: 10.6 },
  { code: "AT", name: "オーストリア", flag: "🇦🇹", latMin: 46.3, latMax: 49.1, lngMin: 9.4, lngMax: 17.2 },
  { code: "CZ", name: "チェコ", flag: "🇨🇿", latMin: 48.5, latMax: 51.1, lngMin: 12, lngMax: 18.9 },
  { code: "PT", name: "ポルトガル", flag: "🇵🇹", latMin: 36.8, latMax: 42.2, lngMin: -9.6, lngMax: -6.1 },
  { code: "GB", name: "イギリス", flag: "🇬🇧", latMin: 49.8, latMax: 59.5, lngMin: -8.7, lngMax: 1.9 },
  { code: "ES", name: "スペイン", flag: "🇪🇸", latMin: 35.9, latMax: 43.9, lngMin: -9.5, lngMax: 4.5 },
  { code: "FR", name: "フランス", flag: "🇫🇷", latMin: 42, latMax: 51.2, lngMin: -5.2, lngMax: 8.3 },
  { code: "DE", name: "ドイツ", flag: "🇩🇪", latMin: 47, latMax: 55.1, lngMin: 5.5, lngMax: 15.5 },
  { code: "IT", name: "イタリア", flag: "🇮🇹", latMin: 36.6, latMax: 47.1, lngMin: 6.6, lngMax: 18.6 },
  { code: "GR", name: "ギリシャ", flag: "🇬🇷", latMin: 34.7, latMax: 41.8, lngMin: 19.3, lngMax: 28.3 },
  { code: "TR", name: "トルコ", flag: "🇹🇷", latMin: 35.8, latMax: 42.2, lngMin: 25.5, lngMax: 45 },

  // 中東・アフリカ
  { code: "AE", name: "アラブ首長国連邦", flag: "🇦🇪", latMin: 22.5, latMax: 26.5, lngMin: 51.4, lngMax: 56.5 },
  { code: "EG", name: "エジプト", flag: "🇪🇬", latMin: 21.7, latMax: 31.8, lngMin: 24.5, lngMax: 36.9 },
  { code: "MA", name: "モロッコ", flag: "🇲🇦", latMin: 27.6, latMax: 36, lngMin: -13.3, lngMax: -1 },
  { code: "KE", name: "ケニア", flag: "🇰🇪", latMin: -4.8, latMax: 5.1, lngMin: 33.9, lngMax: 41.9 },
  { code: "ZA", name: "南アフリカ", flag: "🇿🇦", latMin: -35, latMax: -22, lngMin: 16, lngMax: 33 },

  // オセアニア
  { code: "NZ", name: "ニュージーランド", flag: "🇳🇿", latMin: -48, latMax: -33, lngMin: 165, lngMax: 179.9 },
  { code: "AU", name: "オーストラリア", flag: "🇦🇺", latMin: -44, latMax: -10, lngMin: 112, lngMax: 154 },

  // 南北アメリカ。ハワイ・アラスカは本土と別矩形で登録する。
  { code: "US", name: "アメリカ", flag: "🇺🇸", latMin: 18, latMax: 23, lngMin: -161, lngMax: -154 },
  { code: "US", name: "アメリカ", flag: "🇺🇸", latMin: 51, latMax: 72, lngMin: -170, lngMax: -130 },
  // 国境近くの主要都市は大きな矩形より先に判定する。
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 48.8, latMax: 49.4, lngMin: -123.5, lngMax: -122.4 },
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 43.4, latMax: 44, lngMin: -80, lngMax: -78.9 },
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 45.3, latMax: 45.8, lngMin: -74.1, lngMax: -73.2 },
  { code: "MX", name: "メキシコ", flag: "🇲🇽", latMin: 18.8, latMax: 20, lngMin: -99.8, lngMax: -98.5 },
  { code: "US", name: "アメリカ", flag: "🇺🇸", latMin: 24, latMax: 50, lngMin: -125, lngMax: -66.5 },
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 42, latMax: 84, lngMin: -141, lngMax: -52 },
  { code: "MX", name: "メキシコ", flag: "🇲🇽", latMin: 14, latMax: 33, lngMin: -118, lngMax: -86 },
  { code: "BO", name: "ボリビア", flag: "🇧🇴", latMin: -22.9, latMax: -9.6, lngMin: -69.7, lngMax: -57.4 },
  { code: "UY", name: "ウルグアイ", flag: "🇺🇾", latMin: -35, latMax: -30, lngMin: -58.5, lngMax: -53 },
  { code: "PY", name: "パラグアイ", flag: "🇵🇾", latMin: -27.6, latMax: -19.2, lngMin: -62.7, lngMax: -54.2 },
  { code: "PE", name: "ペルー", flag: "🇵🇪", latMin: -18.4, latMax: 0, lngMin: -81.4, lngMax: -68.6 },
  { code: "CL", name: "チリ", flag: "🇨🇱", latMin: -56, latMax: -17.5, lngMin: -75.7, lngMax: -66.4 },
  { code: "AR", name: "アルゼンチン", flag: "🇦🇷", latMin: -55.1, latMax: -21.7, lngMin: -73.6, lngMax: -53.6 },
  { code: "BR", name: "ブラジル", flag: "🇧🇷", latMin: -33.8, latMax: 5.3, lngMin: -74, lngMax: -34.7 },
];

export function countryOf(lat: number, lng: number): Country | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const match = COUNTRY_BOXES.find((box) =>
    lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax,
  );
  return match ? { code: match.code, name: match.name, flag: match.flag } : null;
}

export function countryCodeOf(lat: number, lng: number): CountryCode | null {
  return countryOf(lat, lng)?.code || null;
}

const COUNTRY_TEXT_HINTS: ReadonlyArray<readonly [RegExp, CountryCode]> = [
  [/日本|japan|東京|大阪|京都|長野|札幌|福岡|沖縄|那覇|羽田|成田|関空|新千歳|新宿|品川|横浜|名古屋|仙台|盛岡|青森|八戸/i, "JP"],
  [/韓国|south korea|korea|seoul|ソウル|仁川|incheon/i, "KR"],
  [/台湾|taiwan|taipei|台北|桃園|taoyuan|金門|kinmen|馬祖|matsu/i, "TW"],
  [/香港|hong kong/i, "HK"], [/マカオ|macau|macao/i, "MO"],
  [/中国|china|shanghai|上海|beijing|北京/i, "CN"],
  [/タイ王国|タイ|thailand|bangkok|バンコク|suvarnabhumi|スワンナプーム/i, "TH"],
  [/シンガポール|singapore/i, "SG"], [/ベトナム|vietnam|hanoi|ハノイ|ho chi minh|ホーチミン/i, "VN"],
  [/マレーシア|malaysia|kuala lumpur|クアラルンプール/i, "MY"],
  [/インドネシア|indonesia|bali|バリ|jakarta|ジャカルタ/i, "ID"],
  [/フィリピン|philippines|manila|マニラ/i, "PH"], [/インド|india|delhi|デリー/i, "IN"],
  [/モンゴル|mongolia|ulaanbaatar|ウランバートル/i, "MN"],
  [/アメリカ|米国|united states|usa|u\.s\.a|new york|ニューヨーク|manhattan|マンハッタン|los angeles|ロサンゼルス|san francisco|サンフランシスコ|hawaii|ハワイ|honolulu|ホノルル/i, "US"],
  [/カナダ|canada|toronto|トロント|vancouver|バンクーバー/i, "CA"],
  [/フランス|france|paris|パリ/i, "FR"], [/イギリス|英国|united kingdom|\buk\b|london|ロンドン/i, "GB"],
  [/ドイツ|germany|berlin|ベルリン/i, "DE"], [/スペイン|spain|madrid|マドリード|barcelona|バルセロナ/i, "ES"],
  [/イタリア|italy|rome|ローマ/i, "IT"], [/オーストラリア|australia|sydney|シドニー/i, "AU"],
  [/ニュージーランド|new zealand|auckland|オークランド/i, "NZ"],
];

/**
 * 国・地域ごとの法定通貨（ISO 4217）。費用入力の通貨候補を行き先から出すために使う。
 * 旅行ごとに通貨を設定へ書かなくて済むよう、判定はこの表だけに置く。
 */
const COUNTRY_CURRENCY: Record<CountryCode, string> = {
  HK: "HKD", MO: "MOP", SG: "SGD", TW: "TWD", KR: "KRW", JP: "JPY", IN: "INR", MN: "MNT",
  CN: "CNY", TH: "THB", VN: "VND", MY: "MYR", PH: "PHP", ID: "IDR",
  NL: "EUR", BE: "EUR", CH: "CHF", AT: "EUR", CZ: "CZK", PT: "EUR", GB: "GBP", ES: "EUR",
  FR: "EUR", DE: "EUR", IT: "EUR", GR: "EUR", TR: "TRY",
  AE: "AED", EG: "EGP", MA: "MAD", KE: "KES", ZA: "ZAR", NZ: "NZD", AU: "AUD",
  US: "USD", CA: "CAD", MX: "MXN",
  BO: "BOB", UY: "UYU", PY: "PYG", PE: "PEN", CL: "CLP", AR: "ARS", BR: "BRL",
};

export function currencyOfCountry(code: CountryCode | null): string {
  return code ? COUNTRY_CURRENCY[code] || "" : "";
}

export function countryCodeFromText(text: string | undefined): CountryCode | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  return COUNTRY_TEXT_HINTS.find(([pattern]) => pattern.test(raw))?.[1] || null;
}
