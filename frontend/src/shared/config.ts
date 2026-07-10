// 旅行設定（window.TRIP_CONFIG）の型と、既定値・マージ・正規化ユーティリティ。
// trip-config.js（public/）が実行時に window.TRIP_CONFIG を設定する。

export type TripMode = "sample" | "googleSheets" | "appsScript" | "local";
export type TripSchema = "standard" | "trip" | "southAmerica";

export interface AuthConfig {
  enabled: boolean;
  mode: "local" | "appsScript";
  passwordHash: string;
  storageKey: string;
  rememberDays: number;
}

export interface MapDefaults {
  center: [number, number];
  zoom: number;
  activeRadiusKm: number;
  overviewRadiusKm: number;
}

export interface SheetsConfig {
  basicInfo: string;
  itinerary: string;
  links: string;
  tripLinks: string;
  settlement: string;
  checklist: string;
  tripChecklist: string;
  tripItinerary: string;
  southAmericaItinerary: string;
  reservations: string;
  budget: string;
  localInfo: string;
}

export interface RangesConfig {
  basicInfo: string;
  tripItinerary: string;
  southAmericaItinerary: string;
  tripLinks: string;
  tripChecklist: string;
  reservations: string;
  budget: string;
  localInfo: string;
}

export interface LinkOverrides {
  itinerary: string;
  maps: string;
  expenseSheet: string;
  photos: string;
}

export interface MapEmbedConfig {
  mode: "leaflet" | "abstract" | "myMaps" | "mapsEmbedApi";
  myMapsEmbedUrl: string;
  mapsEmbedApiKey: string;
}

export interface GeocodingConfig {
  /** Mapbox の公開アクセストークン（pk.…）。設定すると場所検索が Mapbox になる */
  mapboxToken: string;
}

export interface SharedBackendConfig {
  /** local=端末保存のみ / appsScript=Apps Script の共有ストアへ同期 */
  mode: "local" | "appsScript";
  /** true のとき Apps Script から共有ストアを読み込む */
  enabled: boolean;
}

export interface TripConfig {
  mode: TripMode;
  tripSlug: string;
  tripTitle: string;
  spreadsheetId: string;
  schema: TripSchema;
  defaultParticipants: string[];
  currencies: string[];
  sheets: SheetsConfig;
  ranges: RangesConfig;
  linkOverrides: LinkOverrides;
  mapEmbed: MapEmbedConfig;
  appsScriptUrl: string;
  todayOverride: string;
  refreshMinutes: number;
  refreshOnFocus: boolean;
  minRefreshSeconds: number;
  auth: AuthConfig;
  profile: { storageKey: string };
  expenseCache: { storageKey: string };
  mapDefaults: MapDefaults;
  geocoding: GeocodingConfig;
  sharedBackend: SharedBackendConfig;
}

export const DEFAULT_CONFIG: TripConfig = {
  mode: "sample",
  tripSlug: "trip-template",
  tripTitle: "旅行",
  spreadsheetId: "",
  schema: "trip",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY", "USD", "EUR", "KRW", "TWD", "CNY", "THB", "SGD", "AUD", "GBP"],
  sheets: {
    basicInfo: "基本情報",
    itinerary: "Itinerary",
    links: "Links",
    tripLinks: "リンク管理",
    settlement: "Settlement",
    checklist: "Checklist",
    tripChecklist: "チェックリスト",
    tripItinerary: "行程表",
    southAmericaItinerary: "行程表",
    reservations: "予約管理",
    budget: "予算",
    localInfo: "現地実用情報",
  },
  ranges: {
    basicInfo: "A1:D",
    tripItinerary: "A2:X",
    southAmericaItinerary: "A2:X",
    tripLinks: "A1:G",
    tripChecklist: "A1:F",
    reservations: "A1:I",
    budget: "A1:F",
    localInfo: "A1:O",
  },
  linkOverrides: {
    itinerary: "",
    maps: "",
    expenseSheet: "",
    photos: "",
  },
  mapEmbed: {
    mode: "leaflet",
    myMapsEmbedUrl: "",
    mapsEmbedApiKey: "",
  },
  appsScriptUrl: "",
  todayOverride: "",
  refreshMinutes: 3,
  refreshOnFocus: true,
  minRefreshSeconds: 90,
  auth: {
    enabled: true,
    mode: "appsScript",
    passwordHash: "",
    storageKey: "",
    rememberDays: 14,
  },
  profile: { storageKey: "" },
  expenseCache: { storageKey: "" },
  mapDefaults: {
    center: [35.6812, 139.7671],
    zoom: 5,
    activeRadiusKm: 300,
    overviewRadiusKm: 800,
  },
  geocoding: {
    mapboxToken: "",
  },
  sharedBackend: {
    mode: "local",
    enabled: false,
  },
};

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** trip-config.js / プラン上書きの部分設定を深くマージする */
export function mergeConfig<T extends Dict>(base: T, override: Dict | undefined): T {
  const result: Dict = { ...base };
  const source = override || {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = mergeConfig(current, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

export function safeTripSlug(value: string | undefined): string {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "trip"
  );
}

/** マージ済み設定に storageKey 等を補完して正規化する */
export function normalizeTripConfig(config: TripConfig): TripConfig {
  const next = config;
  next.tripTitle = next.tripTitle || "旅行";
  next.tripSlug = safeTripSlug(next.tripSlug);
  if (!next.auth.storageKey) next.auth.storageKey = `trip-dashboard-auth-${next.tripSlug}`;
  if (!next.profile.storageKey) next.profile.storageKey = `trip-dashboard-profile-${next.tripSlug}`;
  if (!next.expenseCache.storageKey) {
    next.expenseCache.storageKey = `trip-dashboard-expense-entry-${next.tripSlug}`;
  }
  return next;
}

/** 実行時に trip-config.js が設定したグローバルを読む */
export function readGlobalTripConfig(): Partial<TripConfig> {
  return (window as Window & { TRIP_CONFIG?: Partial<TripConfig> }).TRIP_CONFIG || {};
}
