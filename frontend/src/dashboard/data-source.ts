// ダッシュボードのデータ取得層。
// sample / local / googleSheets(gviz) / appsScript の各モードから TripData を組み立てる。
// 描画（main.ts）からは loadData() だけを呼び、Sheets の列名や gviz の応答形式には触れない。

import * as TripPlans from "../shared/plans-store";
import { callAppsScript as callAppsScriptShared } from "../shared/apps-script";
import { getAuthToken as getAuthTokenShared } from "../shared/auth";
import type { TripConfig, LinkOverrides } from "../shared/config";
import type {
  TripData,
  TripLink,
  ItineraryItem,
  Settlement,
  ChecklistItem,
  LocalInfoItem,
  SheetRow,
} from "../shared/types";

/** gviz JSONP レスポンスの最小形 */
interface GvizResponse {
  status?: string;
  errors?: { detailed_message?: string }[];
  table?: {
    cols: { label?: string; id?: string }[];
    rows: { c: ({ f?: string; v?: unknown } | null)[] }[];
  };
}

export function numberOrNaN(value: unknown): number {
  if (value === "" || value === null || value === undefined) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function normalizeDate(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim().replace(/\//g, "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function formatYen(value: number): string {
  return value ? "¥" + Math.round(value).toLocaleString("ja-JP") : "未入力";
}

function valueByKeys(row: SheetRow, keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return "";
}

function rowsFromGviz(response: GvizResponse): SheetRow[] {
  if (!response || !response.table) return [];
  const labels = response.table.cols.map((col, index) => col.label || col.id || `col${index}`);
  return response.table.rows.map((row) => {
    const obj: SheetRow = {};
    labels.forEach((label, index) => {
      const cell = row.c[index];
      obj[label] = cell ? String(cell.f ?? cell.v ?? "") : "";
    });
    return obj;
  });
}

function loadGvizSheet(spreadsheetId: string, sheetName: string, range?: string): Promise<SheetRow[]> {
  return new Promise((resolve, reject) => {
    const callback = "__tripSheetCallback_" + Math.random().toString(36).slice(2);
    const globalScope = window as unknown as Record<string, unknown>;
    const script = document.createElement("script");
    globalScope[callback] = (response: GvizResponse): void => {
      delete globalScope[callback];
      script.remove();
      if (response.status && response.status !== "ok") {
        reject(new Error(response.errors && response.errors[0] ? response.errors[0].detailed_message || "Google Sheets response error" : "Google Sheets response error"));
        return;
      }
      resolve(rowsFromGviz(response));
    };
    const tqx = "out:json;responseHandler:" + callback;
    script.src = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(spreadsheetId) +
      "/gviz/tq?tqx=" + encodeURIComponent(tqx) +
      "&sheet=" + encodeURIComponent(sheetName) +
      (range ? "&range=" + encodeURIComponent(range) : "") +
      "&cachebust=" + Date.now();
    script.onerror = (): void => {
      delete globalScope[callback];
      script.remove();
      reject(new Error("Google Sheetsを読み込めませんでした"));
    };
    document.head.appendChild(script);
  });
}

// ---- Sheets スキーマ別データ構築 ---------------------------------------

interface BasicInfo {
  [key: string]: string;
}

function makeSheetUrl(config: TripConfig, sheetName: string): string {
  return "https://docs.google.com/spreadsheets/d/" + config.spreadsheetId + "/edit#gid=0&range=" + encodeURIComponent(sheetName + "!A1");
}

function buildBasicInfo(rows: SheetRow[]): BasicInfo {
  const info: BasicInfo = {};
  (rows || []).forEach((row) => {
    const key = valueByKeys(row, ["key", "キー"]);
    if (!key) return;
    const visible = String(valueByKeys(row, ["公開ページに表示", "表示", "enabled"]) || "TRUE").toUpperCase() !== "FALSE";
    if (!visible) return;
    info[key] = valueByKeys(row, ["value", "値"]);
  });
  return info;
}

function buildTripLinks(linkRows: SheetRow[], fallbackLinks: TripLink[], basicInfo: BasicInfo): TripLink[] {
  const rows = (linkRows || [])
    .filter((row) => String(valueByKeys(row, ["enabled", "有効", "公開ページに表示"]) || "TRUE").toUpperCase() !== "FALSE")
    .filter((row) => valueByKeys(row, ["key"]) || valueByKeys(row, ["label", "表示名"]));
  if (!rows.length) return fallbackLinks;
  return rows.map((row) => {
    const key = valueByKeys(row, ["key"]);
    let url = valueByKeys(row, ["url", "URL"]);
    if (key === "maps" && basicInfo.myMapsUrl) url = basicInfo.myMapsUrl;
    if (key === "photos" && basicInfo.photosUrl) url = basicInfo.photosUrl;
    return {
      key,
      label: valueByKeys(row, ["label", "表示名"]) || key,
      icon: valueByKeys(row, ["icon", "アイコン"]) || "↗",
      url,
      caption: valueByKeys(row, ["caption", "説明"]) || "",
    };
  });
}

function buildTripChecklist(rows: SheetRow[]): ChecklistItem[] {
  return (rows || [])
    .filter((row) => String(valueByKeys(row, ["有効", "enabled"]) || "TRUE").toUpperCase() !== "FALSE")
    .map((row) => ({
      label: valueByKeys(row, ["項目", "label", "チェック項目"]) || "",
      done: valueByKeys(row, ["完了", "done"]) || false,
    }))
    .filter((row) => row.label);
}

function buildTripSheetData(
  config: TripConfig,
  itineraryRows: SheetRow[],
  _reservationRows: SheetRow[],
  _budgetRows: SheetRow[],
  basicInfoRows: SheetRow[],
  linkRows: SheetRow[],
  checklistRows: SheetRow[],
): TripData {
  const basicInfo = buildBasicInfo(basicInfoRows);
  const tripSheetName = config.sheets.tripItinerary || config.sheets.southAmericaItinerary;
  const sheetUrl = makeSheetUrl(config, tripSheetName);
  const link = (key: keyof LinkOverrides, fallback: string): string => config.linkOverrides[key] || fallback || "";
  const itinerary: ItineraryItem[] = itineraryRows
    .filter((row) => row["日付"] && row["Day"])
    .filter((row) => String(valueByKeys(row, ["公開ページに表示", "表示", "enabled"]) || "TRUE").toUpperCase() !== "FALSE")
    .map((row) => {
      const origin = valueByKeys(row, ["移動元", "出発地"]) || "";
      const destination = valueByKeys(row, ["移動先", "到着地"]) || "";
      const city = valueByKeys(row, ["都市", "宿泊地", "エリア"]) || destination || origin || "";
      const purpose = valueByKeys(row, ["主目的", "目的"]) || "予定";
      const displayTime = valueByKeys(row, ["表示時刻", "時刻", "開始時刻", "出発時刻", "集合時刻"]);
      const displayPlace = valueByKeys(row, ["表示場所", "場所", "集合場所"]) || destination || city || origin;
      const displayTitle = valueByKeys(row, ["表示タイトル", "タイトル", "予定名"]);
      const displayNote = valueByKeys(row, ["表示メモ", "当日メモ", "メモ"]);
      const needed = valueByKeys(row, ["必要情報", "当日必要情報", "持ち物/注意", "確認事項"]);
      const weather = valueByKeys(row, ["天気", "気温", "weather"]);
      const moving = origin && destination;
      const type = valueByKeys(row, ["type", "種別"]) || (moving ? "move" : (purpose === "宿泊" ? "stay" : (purpose === "休養" ? "todo" : "sight")));
      const title = displayTitle || (moving ? `${origin} → ${destination}` : `${city} / ${purpose}`);
      const noteParts = displayNote ? [displayNote] : [
        row["移動手段"],
        row["所要時間"],
        row["予約状況"],
        row["確定度"],
        row["メモ"],
      ];
      const rowLat = numberOrNaN(valueByKeys(row, ["lat", "緯度"]));
      const rowLng = numberOrNaN(valueByKeys(row, ["lng", "経度"]));
      const coords = Number.isFinite(rowLat) && Number.isFinite(rowLng) ? { lat: rowLat, lng: rowLng } : TripPlans.coordsFor(displayPlace);
      const originCoords = TripPlans.coordsFor(origin);
      const destinationCoords = TripPlans.coordsFor(destination || city);
      return {
        date: normalizeDate(row["日付"]),
        day: row["Day"] || row["day"],
        area: city,
        time: displayTime,
        type,
        typeLabel: valueByKeys(row, ["表示ラベル", "ラベル"]) || (moving ? "移動" : purpose),
        title,
        place: displayPlace,
        note: noteParts.filter(Boolean).join(" / "),
        needed,
        origin,
        destination,
        originLat: originCoords ? originCoords.lat : NaN,
        originLng: originCoords ? originCoords.lng : NaN,
        destinationLat: destinationCoords ? destinationCoords.lat : NaN,
        destinationLng: destinationCoords ? destinationCoords.lng : NaN,
        lat: coords ? coords.lat : NaN,
        lng: coords ? coords.lng : NaN,
        mapQuery: valueByKeys(row, ["地図検索", "mapQuery"]) || displayPlace,
        weather,
      };
    });

  const fallbackLinks: TripLink[] = [
    { key: "itinerary", label: "旅程", icon: "旅", url: link("itinerary", sheetUrl), caption: "Google Sheets" },
    { key: "maps", label: "My Maps", icon: "地", url: link("maps", basicInfo.myMapsUrl || "https://www.google.com/maps/d/"), caption: "Google My Maps" },
    { key: "expenseSheet", label: "費用", icon: "￥", url: link("expenseSheet", makeSheetUrl(config, config.sheets.budget)), caption: "Google Sheets" },
    { key: "photos", label: "写真", icon: "写", url: link("photos", basicInfo.photosUrl || "https://photos.google.com/"), caption: "Google Photos" },
    { key: "reservations", label: "予約管理", icon: "予", url: makeSheetUrl(config, config.sheets.reservations), caption: "Google Sheets" },
    { key: "budget", label: "予算", icon: "￥", url: makeSheetUrl(config, config.sheets.budget), caption: "Google Sheets" },
  ];
  const checklist = buildTripChecklist(checklistRows);

  return {
    trip: {
      title: basicInfo.tripTitle || config.tripTitle || "旅行",
      dates: basicInfo.dateStart && basicInfo.dateEnd ? `${normalizeDate(basicInfo.dateStart)} - ${normalizeDate(basicInfo.dateEnd)}` : (itinerary[0] && itinerary[itinerary.length - 1] ? `${itinerary[0].date} - ${itinerary[itinerary.length - 1].date}` : ""),
      members: basicInfo.members || "共有メンバー",
      note: basicInfo.dashboardNote ? `共有メモ: ${basicInfo.dashboardNote}` : "共有メモ: 詳細な予約番号や宿泊先住所は公開ページに載せず、スプレッドシート側で管理してください。",
    },
    links: buildTripLinks(linkRows, fallbackLinks, basicInfo),
    settlement: {
      paid: formatYen(0),
      paidLabel: "精算額",
      expenseTotal: "¥0",
      expenseByPerson: {},
      progress: 0,
      yourPaid: "-",
      yourDue: "精算不要",
      photoTitle: basicInfo.photoTitle || `${config.tripTitle || "旅行"}アルバム`,
      photoMeta: "Google Photos",
    },
    checklist: checklist.length ? checklist : [
      { label: "航空券・宿の予約状況確認", done: false },
      { label: "保険と緊急連絡先の確認", done: false },
      { label: "パスポート・ビザ・入国条件の確認（海外のみ）", done: false },
      { label: "現地通信手段の確認", done: false },
    ],
    localInfo: [],
    itinerary,
  };
}

function buildLocalInfo(rows: SheetRow[]): LocalInfoItem[] {
  return (rows || [])
    .filter((row) => String(valueByKeys(row, ["有効", "enabled"]) || "TRUE").toUpperCase() !== "FALSE")
    .filter((row) => valueByKeys(row, ["国", "country"]))
    .map((row) => ({
      country: valueByKeys(row, ["国", "country"]),
      currencyCode: valueByKeys(row, ["通貨コード", "currencyCode", "currency"]),
      currencyName: valueByKeys(row, ["通貨名", "currencyName"]),
      approxRate: valueByKeys(row, ["概算円レート", "rateToJpy", "円換算レート"]),
      rateUpdatedAt: valueByKeys(row, ["レート更新日", "rateUpdatedAt", "更新日"]),
      feeFreeAtm: valueByKeys(row, ["手数料無料ATM候補", "無料ATM候補", "feeFreeAtm"]),
      atmBest: valueByKeys(row, ["ATMおすすめ", "atmBest"]),
      atmFee: valueByKeys(row, ["ATM手数料目安", "atmFee"]),
      atmNote: valueByKeys(row, ["避けたい/注意", "注意", "atmNote"]),
      rideBest: valueByKeys(row, ["配車おすすめ", "rideBest"]),
      rideAlt: valueByKeys(row, ["代替アプリ", "rideAlt"]),
      paymentNote: valueByKeys(row, ["支払いメモ", "paymentNote"]),
      source: valueByKeys(row, ["情報ソース", "source"]),
      order: Number(valueByKeys(row, ["表示順", "order"]) || 999),
    }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.country).localeCompare(String(b.country), "ja"));
}

/**
 * CONFIG.mode に応じてデータ取得元を切り替え、TripData を返す。
 * sample: 呼び出し側が渡す sample をそのまま返す。
 * local: plan-editor が保存したローカル計画。
 * googleSheets: gviz 経由でシートを直接読む（サーバー不要・閲覧専用）。
 * appsScript: Apps Script Web App の action=data。
 */
export async function loadData(config: TripConfig, sample: TripData): Promise<TripData> {
  if (config.mode === "local") {
    const local = TripPlans.getData(config.tripSlug);
    return TripPlans.toDashboardData(local);
  }
  if (config.mode === "googleSheets" && config.spreadsheetId) {
    if (config.schema === "trip" || config.schema === "southAmerica") {
      const tripSheetName = config.sheets.tripItinerary || config.sheets.southAmericaItinerary;
      const tripRange = config.ranges.tripItinerary || config.ranges.southAmericaItinerary;
      const [itineraryRows, reservationRows, budgetRows, localInfoRows, basicInfoRows, linkRows, checklistRows] = await Promise.all([
        loadGvizSheet(config.spreadsheetId, tripSheetName, tripRange),
        loadGvizSheet(config.spreadsheetId, config.sheets.reservations, config.ranges.reservations),
        loadGvizSheet(config.spreadsheetId, config.sheets.budget, config.ranges.budget),
        loadGvizSheet(config.spreadsheetId, config.sheets.localInfo, config.ranges.localInfo).catch(() => [] as SheetRow[]),
        loadGvizSheet(config.spreadsheetId, config.sheets.basicInfo, config.ranges.basicInfo).catch(() => [] as SheetRow[]),
        loadGvizSheet(config.spreadsheetId, config.sheets.tripLinks, config.ranges.tripLinks).catch(() => [] as SheetRow[]),
        loadGvizSheet(config.spreadsheetId, config.sheets.tripChecklist, config.ranges.tripChecklist).catch(() => [] as SheetRow[]),
      ]);
      const data = buildTripSheetData(config, itineraryRows, reservationRows, budgetRows, basicInfoRows, linkRows, checklistRows);
      data.localInfo = buildLocalInfo(localInfoRows);
      return data;
    }
    const [itinerary, links, settlementRows, checklist] = await Promise.all([
      loadGvizSheet(config.spreadsheetId, config.sheets.itinerary),
      loadGvizSheet(config.spreadsheetId, config.sheets.links),
      loadGvizSheet(config.spreadsheetId, config.sheets.settlement),
      loadGvizSheet(config.spreadsheetId, config.sheets.checklist),
    ]);
    const settlement: Record<string, string> = {};
    settlementRows.forEach((row) => { settlement[row.key] = row.value; });
    return {
      trip: {
        title: settlement.title || sample.trip.title,
        dates: settlement.dates || sample.trip.dates,
        members: settlement.members || sample.trip.members,
        note: settlement.note || sample.trip.note,
      },
      itinerary: itinerary as unknown as ItineraryItem[],
      links: links as unknown as TripLink[],
      checklist: checklist as unknown as ChecklistItem[],
      settlement: settlement as Settlement,
      localInfo: [],
    };
  }
  if (config.mode === "appsScript" && config.appsScriptUrl) {
    const response = await callAppsScriptShared(config.appsScriptUrl, {
      action: "data",
      token: getAuthTokenShared(config.auth.storageKey),
    });
    return response.data || sample;
  }
  return sample;
}
