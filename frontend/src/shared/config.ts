// 旅行設定（window.TRIP_CONFIG）の型と、既定値・マージ・正規化ユーティリティ。
// trip-config.js（public/）が実行時に window.TRIP_CONFIG を設定する。

export type TripMode = "sample" | "local";

export interface AuthConfig {
  enabled: boolean;
  mode: "local";
  passwordHash: string;
  storageKey: string;
  rememberDays: number;
}

export interface MapDefaults {
  center: [number, number];
  zoom: number;
  overviewRadiusKm: number;
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
  /** local=端末保存のみ / api=共有ストア API（MySQL）へ同期 */
  mode: "local" | "api";
  /** true のとき共有ストアから読み込む */
  enabled: boolean;
  /**
   * mode="api" のときのベースURL（例 https://travel-api.example.com）。
   * 空なら同一オリジンの /api を使う。末尾スラッシュ不要。
   */
  apiBaseUrl?: string;
}

export interface TripConfig {
  mode: TripMode;
  tripSlug: string;
  tripTitle: string;
  tripDates: string;
  tripRoute: string;
  tripMembers: string;
  tripCover: string;
  defaultParticipants: string[];
  currencies: string[];
  mapEmbed: MapEmbedConfig;
  todayOverride: string;
  refreshMinutes: number;
  refreshOnFocus: boolean;
  minRefreshSeconds: number;
  auth: AuthConfig;
  /**
   * 公開済み計画の本文をログイン済み利用者が共同編集できるようにする。
   * true でも正式な参加者にはならず、メンバー・費用・精算・公開設定は操作できない。
   */
  openEditing: boolean;
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
  tripDates: "",
  tripRoute: "",
  tripMembers: "",
  tripCover: "",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY", "USD", "EUR", "KRW", "TWD", "CNY", "THB", "SGD", "AUD", "GBP"],
  mapEmbed: {
    mode: "leaflet",
    myMapsEmbedUrl: "",
    mapsEmbedApiKey: "",
  },
  todayOverride: "",
  refreshMinutes: 3,
  refreshOnFocus: true,
  minRefreshSeconds: 90,
  auth: {
    enabled: true,
    mode: "local",
    passwordHash: "",
    storageKey: "",
    rememberDays: 14,
  },
  openEditing: false,
  profile: { storageKey: "" },
  expenseCache: { storageKey: "" },
  mapDefaults: {
    center: [35.6812, 139.7671],
    zoom: 5,
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

/**
 * 既定値と実行時設定をマージした、ページ共通の確定設定。
 * override を渡すと、開いている計画などページ側の上書きを最後に重ねる。
 */
export function resolvedTripConfig(override?: Partial<TripConfig>): TripConfig {
  const runtime = mergeConfig(
    readGlobalTripConfig() as Record<string, unknown>,
    (override || {}) as Record<string, unknown>,
  );
  return normalizeTripConfig(
    mergeConfig(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      runtime,
    ) as unknown as TripConfig,
  );
}
