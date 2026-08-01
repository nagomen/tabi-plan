// 旅行計画レジストリ（複数プランの保存・選択）。
// index / plans / plan-editor / dashboard が共有する localStorage ストア。
// バックエンド不要で動き、source:"local" のプランはこのストアだけで完結する。

import type { TripConfig, MapDefaults } from "./config";
import { safeTripSlug } from "./config";
import * as Backend from "./backend";
import { getUser } from "./user-store";
import * as Permissions from "./permissions-store";
import type {
  TripData,
  TripInfo,
  ItineraryItem,
  TripLink,
  ChecklistItem,
  LocalInfoItem,
  RouteCity,
  Candidate,
  ItemType,
  LatLng,
} from "./types";

export type PlanSource = "local" | "googleSheets" | "appsScript" | "sample";

/** 計画の公開範囲。public=公開 / invite=招待されたメンバーのみ。 */
export type PlanVisibility = "public" | "invite";

export interface PlanMeta {
  slug: string;
  title: string;
  dates: string;
  route?: string;
  members?: string;
  note?: string;
  /** 手動設定のサムネ画像（WebP の data URL）。空/未設定なら自動判定/デフォルト。 */
  cover?: string;
  source: PlanSource;
  /** 公開範囲。未設定は「公開」とみなす（既存計画はすべて公開扱い）。 */
  visibility?: PlanVisibility;
  spreadsheetId?: string;
  appsScriptUrl?: string;
  schema?: string;
  mapDefaults?: MapDefaults | null;
  builtIn?: boolean;
  published?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** 公開範囲を返す（未設定は public）。 */
export function planVisibility(meta: Pick<PlanMeta, "visibility">): PlanVisibility {
  return meta.visibility === "invite" ? "invite" : "public";
}

/** 完成品として公開/発見対象に出せる計画か。自動保存のみの新規計画は false。 */
export function isPublished(meta: Pick<PlanMeta, "published">): boolean {
  return meta.published !== false;
}

/** plan-editor が保存し、dashboard が local モードで読むプランデータ */
export interface LocalPlanData {
  trip: TripInfo;
  itinerary: ItineraryItem[];
  links?: TripLink[];
  checklist?: ChecklistItem[];
  localInfo?: LocalInfoItem[];
  cities?: RouteCity[];
  /** 「行きたい候補」ボード（任意）。投票は再共有でマージされる */
  candidates?: Candidate[];
}

export const PLANS_KEY = "trip-dashboard-plans";
export const ACTIVE_KEY = "trip-dashboard-active-plan";
export const DATA_PREFIX = "trip-dashboard-plan-";

export const safeSlug = safeTripSlug;

// 保存は backend（差し替え口）経由。localStorage を直接触らない。
function readJSON<T>(key: string, fallback: T): T {
  return Backend.getJSON<T>(key, fallback);
}

function writeJSON(key: string, value: unknown): boolean {
  return Backend.setJSON(key, value);
}

function nowISO(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

export function list(): PlanMeta[] {
  const arr = readJSON<PlanMeta[]>(PLANS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function saveList(arr: PlanMeta[]): boolean {
  return writeJSON(PLANS_KEY, Array.isArray(arr) ? arr : []);
}

// ---- ホーム用の振り分け（自分の計画 / みんなの公開計画） ------------------
// 開発時は list() が共有プール（data/plans/*.json）全体を返すため、これを
// 「サーバー代用」として自分/他人に振り分ける。将来バックエンドが入ったら
// listPublic() は `GET /api/plans?visibility=public` 等のリモート照会に、
// listMine() はアカウント単位の照会に差し替える（シグネチャは維持）。

// 循環 import 回避のため、メンバー分割は friend-store を使わずここに小さく持つ。
function planMembers(meta: PlanMeta): string[] {
  return String(meta.members || "")
    .split(/[、,／/]|\s*\/\s*|\s*･\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function currentUserIsMember(meta: PlanMeta): boolean {
  if (Permissions.isParticipant(meta.slug, planMembers(meta))) return true;
  const name = getUser().name;
  return Boolean(name) && planMembers(meta).includes(name);
}

/**
 * 自分の計画: 現在ユーザーがメンバー。
 * 「自分」が居ない（未ログインかつ名前未設定）ときだけ空にする。
 * ログイン中は名前が空でもアカウントの権限で判定できるので currentPrincipal を見る。
 */
export function listMine(): PlanMeta[] {
  return Permissions.currentPrincipal() ? list().filter(currentUserIsMember) : [];
}

/**
 * みんなの公開計画: visibility===public かつ 自分がメンバーでない。
 * dev では実ユーザーの計画のみ発見対象にするため source:"local" に限定
 * （組み込み sample/appsScript の seed は除外）。
 */
export function listPublic(): PlanMeta[] {
  return list().filter(
    (m) => m.source === "local" && isPublished(m) && planVisibility(m) === "public" && !Permissions.canEdit(m.slug) && !currentUserIsMember(m),
  );
}

/** window.TRIP_CONFIG から組み込みプランのメタを作る */
export function seedMeta(config: Partial<TripConfig>): PlanMeta | null {
  if (!config.tripSlug && !config.tripTitle) return null;
  const mode = config.mode || "sample";
  const source: PlanSource =
    mode === "appsScript" ? "appsScript" : mode === "googleSheets" ? "googleSheets" : "sample";
  return {
    slug: safeSlug(config.tripSlug || config.tripTitle),
    title: config.tripTitle || "旅行",
    dates: config.tripDates || "",
    route: config.tripRoute || "",
    members: config.tripMembers || "",
    note: "",
    cover: config.tripCover || "",
    source,
    visibility: "public",
    spreadsheetId: config.spreadsheetId || "",
    appsScriptUrl: config.appsScriptUrl || "",
    schema: config.schema || "trip",
    mapDefaults: config.mapDefaults || null,
    builtIn: true,
    createdAt: "",
    updatedAt: "",
  };
}

/** 組み込みプランをシードする。既存の builtIn は trip-config.js の表示メタへ追従させる。 */
export function ensureSeed(config: Partial<TripConfig>): PlanMeta[] {
  const seed = seedMeta(config);
  if (!seed) return list();
  const arr = list();
  const i = arr.findIndex((p) => p.slug === seed.slug);
  if (i < 0) {
    arr.unshift(seed);
    saveList(arr);
  } else if (arr[i].builtIn && arr[i].source !== "local") {
    arr[i] = {
      ...arr[i],
      ...seed,
      visibility: arr[i].visibility || seed.visibility,
      published: arr[i].published,
      createdAt: arr[i].createdAt || seed.createdAt,
      updatedAt: arr[i].updatedAt || seed.updatedAt,
    };
    saveList(arr);
  }
  return list();
}

export function get(slug: string): PlanMeta | null {
  const target = safeSlug(slug);
  return list().find((p) => p.slug === target) || null;
}

/** メタを追加または更新（既存は浅くマージ） */
export function upsert(meta: Partial<PlanMeta> & { slug: string }): PlanMeta | null {
  if (!meta.slug) return null;
  const slug = safeSlug(meta.slug);
  const next: Partial<PlanMeta> = { ...meta, slug };
  const arr = list();
  const i = arr.findIndex((p) => p.slug === slug);
  if (i >= 0) {
    arr[i] = { ...arr[i], ...next, updatedAt: nowISO() };
  } else {
    arr.push({ createdAt: nowISO(), ...next, updatedAt: nowISO() } as PlanMeta);
  }
  saveList(arr);
  return get(slug);
}

export function remove(slug: string): void {
  const target = safeSlug(slug);
  saveList(list().filter((p) => p.slug !== target));
  Backend.removeJSON(DATA_PREFIX + target);
  deleteDevFile(target);
  if (getActiveSlug() === target) clearActive();
}

/** 利用可能な一意 slug を返す（衝突したら -2, -3 ... を付ける） */
export function uniqueSlug(base: string): string {
  const slug = safeSlug(base);
  const existing = new Set(list().map((p) => p.slug));
  if (!existing.has(slug)) return slug;
  for (let n = 2; n < 999; n++) {
    const candidate = `${slug}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${slug}-${nowISO().replace(/[^0-9]/g, "").slice(0, 12)}`;
}

// ---- ローカルプランの完全データ ----
export function getData(slug: string): LocalPlanData | null {
  return readJSON<LocalPlanData | null>(DATA_PREFIX + safeSlug(slug), null);
}

export function saveData(slug: string, data: LocalPlanData): boolean {
  return writeJSON(DATA_PREFIX + safeSlug(slug), data);
}

/** 候補を id でマージし、votes（投票者名）は和集合で残す。 */
export function mergeCandidates(
  existing: Candidate[] | undefined,
  incoming: Candidate[] | undefined,
): Candidate[] | undefined {
  if (!existing && !incoming) return undefined;
  const byId = new Map<string, Candidate>();
  (existing || []).forEach((c) => {
    if (c && c.id) byId.set(c.id, { ...c, votes: [...(c.votes || [])] });
  });
  (incoming || []).forEach((c) => {
    if (!c || !c.id) return;
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, { ...c, votes: [...(c.votes || [])] });
      return;
    }
    const votes = Array.from(new Set([...(prev.votes || []), ...(c.votes || [])]));
    byId.set(c.id, { ...prev, ...c, votes, adopted: Boolean(prev.adopted || c.adopted) });
  });
  return Array.from(byId.values());
}

/** mergeLocalPlan の結果。kept-* は本文を上書きしなかったことを表す。 */
export type MergeOutcome = "created" | "updated" | "kept-newer" | "kept-unknown";

/**
 * 招待リンク等で受け取ったプランを保存する。既存があればマージする。
 * 本文（行程・リンク・チェックリスト）は受信側で上書きしつつ、
 * 候補ボードの votes だけは和集合で残す（再共有で各自の票が消えないように）。
 *
 * 上書き事故の防止:
 *   古いリンクを開き直すだけで、後から入った編集が消えてしまうため、
 *   リンクに埋めた更新時刻が手元より古ければ本文を触らない（kept-newer）。
 *   更新時刻を持たない旧リンクは判断できないので kept-unknown を返し、
 *   force: true で呼び直すかどうかは呼び出し側（＝利用者への確認）に委ねる。
 */
export function mergeLocalPlan(
  slug: string,
  incoming: LocalPlanData,
  options: { incomingUpdatedAt?: string; force?: boolean } = {},
): { meta: PlanMeta | null; existed: boolean; outcome: MergeOutcome } {
  const target = safeSlug(slug);
  const existing = getData(target);
  const existingMeta = get(target);
  if (existing && !options.force) {
    const mine = existingMeta?.updatedAt || "";
    const theirs = options.incomingUpdatedAt || "";
    if (!theirs) {
      return { meta: existingMeta, existed: true, outcome: "kept-unknown" };
    }
    if (mine && theirs < mine) {
      return { meta: existingMeta, existed: true, outcome: "kept-newer" };
    }
  }
  const merged: LocalPlanData = {
    ...incoming,
    candidates: mergeCandidates(existing?.candidates, incoming.candidates),
  };
  const meta = saveLocalPlan(target, merged);
  return { meta, existed: Boolean(existing), outcome: existing ? "updated" : "created" };
}

// ---- 開発時のファイル保存（data/plans/<slug>.json） --------------------
// Vite dev プラグインが window.__DEV_PLANS__ を注入し、/api/plans で書込みする。
// 本番ビルドでも読み取り用に __DEV_PLANS__ を埋め込む。書込み API は dev server のみ。

interface DevPlanFile extends PlanMeta {
  data: LocalPlanData;
}

function devPlanFiles(): DevPlanFile[] | null {
  const value = (window as unknown as { __DEV_PLANS__?: unknown }).__DEV_PLANS__;
  return Array.isArray(value) ? (value as DevPlanFile[]) : null;
}

function persistDevFile(slug: string): void {
  if (!devPlanFiles()) return;
  const meta = get(slug);
  const data = getData(slug);
  if (!meta || !data) return;
  fetch("/api/plans/" + encodeURIComponent(slug), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...meta, data }, null, 2),
  }).catch(() => {
    /* dev only, best-effort */
  });
}

function deleteDevFile(slug: string): void {
  if (!devPlanFiles()) return;
  fetch("/api/plans/" + encodeURIComponent(slug), { method: "DELETE" }).catch(() => {
    /* ignore */
  });
}

/**
 * 起動時にファイル（data/plans/*.json）から localStorage を再構築する。
 *
 * dev: ファイルが真実。アプリの保存は /api/plans でファイルへ書き戻るので、
 *      ローカルプランはファイルの内容で丸ごと置き換えてよい。
 * 本番: ファイルは git で配る「種」でしかなく、書き戻す先が無い。
 *      置き換えにすると、訪問者が自分で作った計画がリロードのたびに消える
 *      （実際にそうなっていた）。種に含まれる slug だけ更新し、他は残す。
 */
function hydrateFromDevFiles(): void {
  const files = devPlanFiles();
  if (!files) return;
  const metas: PlanMeta[] = files.map((f) => {
    const meta: PlanMeta = { ...f, source: "local" };
    delete (meta as Partial<DevPlanFile>).data;
    return meta;
  });
  const seeded = new Set(metas.map((m) => m.slug));
  const kept = import.meta.env.DEV
    ? list().filter((p) => p.source !== "local")
    : list().filter((p) => !seeded.has(p.slug));
  saveList([...kept, ...metas]);
  files.forEach((f) => {
    if (f.slug && f.data) writeJSON(DATA_PREFIX + safeSlug(f.slug), f.data);
  });
}

/** ローカルプランを保存（メタ＋データ）。data から title/dates/route を導出する */
export function saveLocalPlan(slug: string, data: LocalPlanData): PlanMeta | null {
  const target = safeSlug(slug);
  const trip = data.trip || ({} as TripInfo);
  const existing = get(target);
  const areas: string[] = (data.cities || []).map((city) => city.name || "").filter(Boolean);
  if (!areas.length) {
    (data.itinerary || []).forEach((item) => {
      const area = item.area || "";
      if (area && areas.indexOf(area) === -1) areas.push(area);
    });
  }
  saveData(target, data);
  upsert({
    slug: target,
    title: trip.title || "無題の旅行",
    dates: trip.dates || "",
    members: trip.members || "",
    note: trip.note || "",
    cover: trip.cover || "",
    route: areas.join("、"),
    source: "local",
    builtIn: false,
    published: existing ? existing.published : false,
  });
  persistDevFile(target);
  return get(target);
}

/** ローカルプランを複製 */
export function duplicate(slug: string): PlanMeta | null {
  const meta = get(slug);
  if (!meta) return null;
  const newSlug = uniqueSlug(`${meta.slug}-copy`);
  const data = getData(slug);
  if (data) {
    const copy = JSON.parse(JSON.stringify(data)) as LocalPlanData;
    copy.trip = copy.trip || ({} as TripInfo);
    copy.trip.title = `${copy.trip.title || meta.title || "旅行"} のコピー`;
    return saveLocalPlan(newSlug, copy);
  }
  return upsert({
    ...meta,
    slug: newSlug,
    title: `${meta.title || "旅行"} のコピー`,
    builtIn: false,
    createdAt: "",
    updatedAt: "",
  });
}

// ---- 選択中プラン ----
// これは「この端末でいまどのプランを開いているか」という端末固有の UI 状態であり、
// 共有すべきドメインデータではないため、あえて backend を通さず localStorage に直接持つ。
function urlSlug(): string {
  try {
    return new URLSearchParams(location.search).get("plan") || "";
  } catch {
    return "";
  }
}

export function getActiveSlug(): string {
  const fromUrl = urlSlug();
  if (fromUrl) return safeSlug(fromUrl);
  try {
    return localStorage.getItem(ACTIVE_KEY) || "";
  } catch {
    return "";
  }
}

export function setActiveSlug(slug: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, safeSlug(slug));
  } catch {
    /* ignore */
  }
}

export function clearActive(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * ダッシュボード用に、選択中プランの設定上書きを返す。
 * 同時に組み込みプランのシードと選択中 slug の確定も行う。
 */
export function resolveConfigOverride(config: Partial<TripConfig>): Partial<TripConfig> {
  ensureSeed(config);
  const slug = getActiveSlug();
  let meta = slug ? get(slug) : null;
  if (!meta) meta = list()[0] || seedMeta(config);
  if (!meta) return {};
  setActiveSlug(meta.slug);

  const override: Partial<TripConfig> = {
    tripSlug: meta.slug,
    tripTitle: meta.title || config.tripTitle,
  };
  if (meta.source === "local") {
    override.mode = "local";
  } else {
    override.mode =
      meta.source === "appsScript" ? "appsScript" : meta.source === "sample" ? "sample" : "googleSheets";
    if (meta.spreadsheetId) override.spreadsheetId = meta.spreadsheetId;
    if (meta.appsScriptUrl) override.appsScriptUrl = meta.appsScriptUrl;
    if (meta.schema) override.schema = meta.schema as TripConfig["schema"];
  }
  if (meta.mapDefaults) override.mapDefaults = meta.mapDefaults;
  return override;
}

/** ローカルプランデータをダッシュボードが期待する形に整える */
export function toDashboardData(data: LocalPlanData | null): TripData {
  const source = data || ({} as LocalPlanData);
  const trip = source.trip || ({} as TripInfo);
  return {
    trip: {
      title: trip.title || "旅行",
      dates: trip.dates || "",
      members: trip.members || "",
      note: trip.note || "",
    },
    itinerary: Array.isArray(source.itinerary) ? source.itinerary : [],
    links: Array.isArray(source.links) ? source.links : [],
    checklist: Array.isArray(source.checklist) ? source.checklist : [],
    localInfo: Array.isArray(source.localInfo) ? source.localInfo : [],
    settlement: {},
    cities: Array.isArray(source.cities) ? source.cities : undefined,
  };
}

// ---- 地名→緯度経度（エディタの自動補完用。空でも地図は名前検索でフォールバック） ----
const COORDS: Record<string, [number, number]> = {
  東京: [35.6812, 139.7671], 東京駅: [35.6812, 139.7671],
  品川: [35.6285, 139.7387], 新宿: [35.6896, 139.7006],
  羽田: [35.5494, 139.7798], 羽田空港: [35.5494, 139.7798], HND: [35.5494, 139.7798],
  成田: [35.772, 140.3929], 成田空港: [35.772, 140.3929], NRT: [35.772, 140.3929],
  横浜: [35.4437, 139.638], 鎌倉: [35.3192, 139.5466],
  名古屋: [35.1815, 136.9066], 京都: [35.0116, 135.7681], 京都駅: [34.9858, 135.7588],
  大阪: [34.6937, 135.5023], 新大阪: [34.7335, 135.5002], 神戸: [34.6901, 135.1955],
  奈良: [34.6851, 135.8048], 金沢: [36.5613, 136.6562], 富山: [36.6953, 137.2113],
  広島: [34.3853, 132.4553], 福岡: [33.5902, 130.4017], 博多: [33.5898, 130.4207],
  札幌: [43.0618, 141.3545], 函館: [41.7687, 140.7288], 仙台: [38.2682, 140.8694],
  盛岡: [39.7036, 141.1527], 青森: [40.8246, 140.7406], 弘前: [40.6031, 140.464],
  秋田: [39.7186, 140.1024], 山形: [38.2554, 140.3396], 福島: [37.7503, 140.4676],
  平泉: [38.987, 141.1122], 八戸: [40.5124, 141.4884], 五所川原: [40.8081, 140.4406],
  酒田: [38.9145, 139.8364], 鶴岡: [38.727, 139.8266], 山寺: [38.3107, 140.4366],
  松島: [38.369, 141.0606], 那覇: [26.2124, 127.6792], 石垣: [24.3448, 124.1572],
  日光: [36.7198, 139.6982], 箱根: [35.2324, 139.1069], 軽井沢: [36.3486, 138.6359],
  高山: [36.1408, 137.252], 松本: [36.238, 137.972], 長野: [36.6485, 138.181],
  ハワイ: [21.3069, -157.8583], ホノルル: [21.3069, -157.8583],
  ニューヨーク: [40.7128, -74.006], マンハッタン: [40.7831, -73.9712], リバティ島: [40.6892, -74.0445],
  ロサンゼルス: [34.0522, -118.2437], ロサ: [34.0522, -118.2437],
  パリ: [48.8566, 2.3522], ロンドン: [51.5072, -0.1276], "london hotel": [51.5072, -0.1276],
  ベルリン: [52.52, 13.405], ドイツ: [51.1657, 10.4515],
  スペイン: [40.4168, -3.7038], マドリード: [40.4168, -3.7038], バルセロナ: [41.3874, 2.1686],
  ローマ: [41.9028, 12.4964], ニース: [43.7102, 7.262], ヨーロッパ: [50.1109, 8.6821],
  インド: [28.6139, 77.209], デリー: [28.6139, 77.209],
  モンゴル: [47.8864, 106.9057], ウランバートル: [47.8864, 106.9057],
  台北: [25.033, 121.5654], 台湾: [25.033, 121.5654], シドニー: [-33.8688, 151.2093],
  ソウル: [37.5665, 126.978], バンコク: [13.7563, 100.5018],
  サンフランシスコ: [37.7749, -122.4194], SFO: [37.6213, -122.379],
};

function normalizeName(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "")
    .replace(/・/g, "")
    .replace(/駅$/, "");
}

export function coordsFor(name: string | undefined): LatLng | null {
  const raw = String(name || "").trim();
  if (COORDS[raw]) return { lat: COORDS[raw][0], lng: COORDS[raw][1] };
  const norm = normalizeName(raw);
  for (const key of Object.keys(COORDS)) {
    if (normalizeName(key) === norm) {
      return { lat: COORDS[key][0], lng: COORDS[key][1] };
    }
  }
  return null;
}

/** 種別（ダッシュボードのチップと一致） */
export const TYPES: { value: ItemType; label: string }[] = [
  { value: "sight", label: "観光" },
  { value: "move", label: "移動" },
  { value: "food", label: "食事" },
  { value: "stay", label: "宿泊" },
  { value: "todo", label: "予定" },
  { value: "form", label: "手続き" },
];

/**
 * 既存の計画（visibility 未設定）をすべて「公開」に確定させる一度きりの移行。
 * 以後に作る計画は plan-editor の保存時に公開/招待制を選んで設定する。
 */
export function migrateExistingToPublic(): void {
  const arr = list();
  let changed = false;
  arr.forEach((p) => {
    if (!p.visibility) {
      p.visibility = "public";
      changed = true;
    }
  });
  if (changed) saveList(arr);
}

// 開発時のみ: ファイルから localStorage を再構築（モジュール読込時に1回）。
hydrateFromDevFiles();

// 既存計画の公開範囲を確定（未設定→公開）。
migrateExistingToPublic();

// backend のキャッシュをウォームしておく（全ページが本モジュールを読むため、ここで1回）。
// localStorage 実装では同期完了。将来 API 実装に差し替えたら、各ページ起動で
// `await Backend.preload()` を待つように変更する（backend.ts のコメント参照）。
// ストアが温まったら、未ログイン時に名前で得ていた権限をアカウントへ引き継ぐ（冪等）。
// permissions-store 側ではなくここで呼ぶのは、account-store との循環 import を避けるため。
void Backend.preload().then(() => {
  Permissions.adoptNamePermissions();
});
