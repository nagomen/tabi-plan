import { type Item, type Day, type City, model, num, hasLatLng, cityForDate } from "./editor-state";
import { daysEl } from "./editor-dom";

export function countryFromText(text: string | undefined): CountryCode | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  return COUNTRY_TEXT_HINTS.find(([pattern]) => pattern.test(raw))?.[1] || null;
}

function countryFromCoords(latValue: string, lngValue: string): CountryCode | null {
  if (!hasLatLng(latValue, lngValue)) return null;
  const lat = num(latValue);
  const lng = num(lngValue);
  const inBox = (minLat: number, maxLat: number, minLng: number, maxLng: number): boolean =>
    lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  if (inBox(24, 46, 122, 154)) return "JP";
  if (inBox(5, 21, 97, 106)) return "TH";
  if (inBox(24, 50, -125, -66) || inBox(18, 23, -161, -154)) return "US";
  if (inBox(41, 52, -5.5, 10)) return "FR";
  if (inBox(49, 61, -8.5, 2.5)) return "GB";
  if (inBox(33, 39, 124, 132)) return "KR";
  // 台湾本島に加えて金門・馬祖（東経118度台）も台湾の検索文脈に含める。
  if (inBox(21, 27, 118, 123)) return "TW";
  if (inBox(22.1, 22.6, 113.8, 114.4)) return "HK";
  if (inBox(18, 54, 73, 135)) return "CN";
  if (inBox(1.1, 1.6, 103.5, 104.1)) return "SG";
  if (inBox(8, 24, 102, 110)) return "VN";
  if (inBox(0, 8, 99, 120)) return "MY";
  if (inBox(-11, 6, 95, 142)) return "ID";
  if (inBox(4, 22, 116, 127)) return "PH";
  if (inBox(6, 36, 68, 98)) return "IN";
  if (inBox(41, 53, 87, 120)) return "MN";
  if (inBox(47, 55, 5, 16)) return "DE";
  if (inBox(35, 44, -10, 5)) return "ES";
  if (inBox(36, 47, 6, 19)) return "IT";
  if (inBox(-44, -10, 112, 154)) return "AU";
  return null;
}

export function countryForCity(city: City | null): CountryCode | null {
  if (!city) return null;
  return countryFromText(city.name) || countryFromCoords(city.lat, city.lng);
}

function nextDifferentCityCountry(dayIndex: number, current: CountryCode | null): CountryCode | null {
  if (!current) return null;
  for (let i = dayIndex + 1; i < model.days.length; i++) {
    const nextCountry = countryForCity(cityForDate(model.days[i].date));
    if (nextCountry && nextCountry !== current) return nextCountry;
    if (nextCountry === current) return null;
  }
  return null;
}

function moveEndpointCountry(item: Item, target: "from" | "to", label = ""): CountryCode | null {
  if (target === "from") {
    return countryFromText(label) || countryFromText(item.from) || countryFromCoords(item.fromLat, item.fromLng);
  }
  return countryFromText(label) || countryFromText(item.to) || countryFromCoords(item.toLat, item.toLng);
}

function shouldDefaultMoveToAirplane(
  item: Item,
  day: Day,
  resultLabel = "",
  labelTarget?: "from" | "to",
  useDayTransition = false,
): boolean {
  if (item.kind !== "move" || item.transport.trim()) return false;
  const fromCountry = moveEndpointCountry(item, "from", labelTarget === "from" ? resultLabel : "");
  const toCountry = moveEndpointCountry(item, "to", labelTarget === "to" ? resultLabel : "");
  if (fromCountry && toCountry) return fromCountry !== toCountry;
  if (!useDayTransition) return false;
  const dayIndex = model.days.indexOf(day);
  const currentCountry = countryForCity(cityForDate(day.date));
  return Boolean(currentCountry && nextDifferentCityCountry(dayIndex, currentCountry));
}

export function maybeDefaultMoveTransport(
  item: Item,
  day: Day,
  resultLabel = "",
  labelTarget?: "from" | "to",
  useDayTransition = false,
): void {
  if (shouldDefaultMoveToAirplane(item, day, resultLabel, labelTarget, useDayTransition)) item.transport = "飛行機";
}

export function syncTransportSelect(item: Item): void {
  if (item.kind !== "move") return;
  const select = daysEl.querySelector<HTMLSelectElement>(`select[data-field="transport"][data-item="${item.id}"]`);
  if (select) select.value = item.transport;
}

export type CountryCode =
  | "JP" | "TH" | "US" | "FR" | "GB" | "KR" | "TW" | "CN" | "HK" | "SG"
  | "VN" | "MY" | "ID" | "PH" | "IN" | "MN" | "DE" | "ES" | "IT" | "AU";

const COUNTRY_TEXT_HINTS: [RegExp, CountryCode][] = [
  [/日本|japan|東京|大阪|京都|長野|札幌|福岡|沖縄|那覇|羽田|成田|関空|新千歳|新宿|品川|横浜|名古屋|仙台|盛岡|青森|八戸/i, "JP"],
  [/タイ王国|タイ|thailand|bangkok|バンコク|suvarnabhumi|スワンナプーム/i, "TH"],
  [/アメリカ|米国|united states|usa|u\.s\.a|new york|ニューヨーク|manhattan|マンハッタン|los angeles|ロサンゼルス|san francisco|サンフランシスコ|hawaii|ハワイ|honolulu|ホノルル/i, "US"],
  [/フランス|france|paris|パリ/i, "FR"],
  [/イギリス|英国|united kingdom|uk|london|ロンドン/i, "GB"],
  [/韓国|south korea|korea|seoul|ソウル/i, "KR"],
  [/台湾|taiwan|taipei|台北|桃園|taoyuan|金門|kinmen|馬祖|matsu/i, "TW"],
  [/香港|hong kong/i, "HK"],
  [/中国|china|shanghai|上海|beijing|北京/i, "CN"],
  [/シンガポール|singapore/i, "SG"],
  [/ベトナム|vietnam|hanoi|ハノイ|ho chi minh|ホーチミン/i, "VN"],
  [/マレーシア|malaysia|kuala lumpur|クアラルンプール/i, "MY"],
  [/インドネシア|indonesia|bali|バリ|jakarta|ジャカルタ/i, "ID"],
  [/フィリピン|philippines|manila|マニラ/i, "PH"],
  [/インド|india|delhi|デリー/i, "IN"],
  [/モンゴル|mongolia|ulaanbaatar|ウランバートル/i, "MN"],
  [/ドイツ|germany|berlin|ベルリン/i, "DE"],
  [/スペイン|spain|madrid|マドリード|barcelona|バルセロナ/i, "ES"],
  [/イタリア|italy|rome|ローマ/i, "IT"],
  [/オーストラリア|australia|sydney|シドニー/i, "AU"],
];
