// 緯度経度からおおまかに国を判定する（訪問国数・国旗表示のため）。
//
// サーバー無しの前提なので、逆ジオコーディングは使わず、国ごとの粗い緯度経度の
// バウンディングボックスで判定する。アプリに登場する行き先を網羅する精度で十分。
// 隣接・重なりがある国は、狭い方（判別しやすい方）を先に並べて先勝ちにする。
// 将来サーバーが入ったら、この関数を逆ジオコーディング API 呼び出しに差し替える。

export interface Country {
  name: string;
  flag: string;
}

interface Box extends Country {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

// 並び順が重要（先に一致した国を採用）。狭い/内側の国を上に。
const BOXES: Box[] = [
  // 東アジア・東南アジア
  { name: "韓国", flag: "🇰🇷", latMin: 33, latMax: 39, lngMin: 124.5, lngMax: 131 },
  { name: "台湾", flag: "🇹🇼", latMin: 21.5, latMax: 25.5, lngMin: 119.3, lngMax: 122.1 },
  { name: "日本", flag: "🇯🇵", latMin: 24, latMax: 46, lngMin: 122.5, lngMax: 146.5 },
  { name: "タイ", flag: "🇹🇭", latMin: 5.5, latMax: 20.6, lngMin: 97, lngMax: 106 },
  // ヨーロッパ
  { name: "イギリス", flag: "🇬🇧", latMin: 49.8, latMax: 59.5, lngMin: -8.7, lngMax: 1.9 },
  { name: "スペイン", flag: "🇪🇸", latMin: 35.9, latMax: 43.9, lngMin: -9.5, lngMax: 3.4 },
  { name: "フランス", flag: "🇫🇷", latMin: 42, latMax: 51.2, lngMin: -5.2, lngMax: 8.3 },
  { name: "イタリア", flag: "🇮🇹", latMin: 36.6, latMax: 47.1, lngMin: 6.6, lngMax: 18.6 },
  { name: "ギリシャ", flag: "🇬🇷", latMin: 34.7, latMax: 41.8, lngMin: 19.3, lngMax: 28.3 },
  // アフリカ
  { name: "モロッコ", flag: "🇲🇦", latMin: 27.6, latMax: 36, lngMin: -13.3, lngMax: -1 },
  { name: "ケニア", flag: "🇰🇪", latMin: -4.8, latMax: 5.1, lngMin: 33.9, lngMax: 41.9 },
  // 南北アメリカ（重なりがあるため内陸の小国を先に）
  { name: "ボリビア", flag: "🇧🇴", latMin: -22.9, latMax: -9.6, lngMin: -69.7, lngMax: -57.4 },
  { name: "ウルグアイ", flag: "🇺🇾", latMin: -35, latMax: -30, lngMin: -58.5, lngMax: -53 },
  { name: "パラグアイ", flag: "🇵🇾", latMin: -27.6, latMax: -19.2, lngMin: -62.7, lngMax: -54.2 },
  { name: "ペルー", flag: "🇵🇪", latMin: -18.4, latMax: 0, lngMin: -81.4, lngMax: -68.6 },
  { name: "チリ", flag: "🇨🇱", latMin: -56, latMax: -17.5, lngMin: -75.7, lngMax: -66.4 },
  { name: "アルゼンチン", flag: "🇦🇷", latMin: -55.1, latMax: -21.7, lngMin: -73.6, lngMax: -53.6 },
  { name: "ブラジル", flag: "🇧🇷", latMin: -33.8, latMax: 5.3, lngMin: -74, lngMax: -34.7 },
  { name: "アメリカ", flag: "🇺🇸", latMin: 24, latMax: 49.5, lngMin: -125, lngMax: -66.9 },
];

/** 緯度経度からおおまかな国を返す。判定できなければ null。 */
export function countryOf(lat: number, lng: number): Country | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const b of BOXES) {
    if (lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax) {
      return { name: b.name, flag: b.flag };
    }
  }
  return null;
}
