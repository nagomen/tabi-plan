// 旅行計画レジストリ。永続化は db.ts（MySQL の plans / plan_members / itinerary_items …）。
//
// 画面が使う PlanMeta / LocalPlanData は「ビュー型」として維持する。
// 中身は関係テーブルから組み立て、保存時に行へ戻す。こうすることで
// 各画面の書き換えを抑えつつ、保存側は正規化された状態にできる。
//
// 旧構造との違い:
//   - 計画メタ35件を1配列で持たない（1件更新で全体を書かない）
//   - members は連結文字列ではなく plan_members（多対多）。表示用に名前へ解決する
//   - 行程は id を持つ行なので、行単位の更新・並び替えができる

import type { TripConfig, MapDefaults } from "./config";
import { safeTripSlug } from "./config";
import * as db from "./db";
import { currentUserId } from "./identity";
import type {
  TripData, TripInfo, ItineraryItem, TripLink, ChecklistItem, LocalInfoItem,
  RouteCity, Candidate, ItemType,
} from "./types";

export { coordsFor, TYPES } from "./geo";

export type PlanSource = "local" | "googleSheets" | "appsScript" | "sample";
export type PlanVisibility = "public" | "invite";

export interface PlanMeta {
  /** DB(plans) の主キー。slug は URL 用の別キー。 */
  id?: string;
  /** 参加者の user_id。表示名ではなくこちらを操作に使う。 */
  memberIds?: string[];
  slug: string;
  title: string;
  dates: string;
  route?: string;
  members?: string;
  note?: string;
  cover?: string;
  source: PlanSource;
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

export interface LocalPlanData {
  trip: TripInfo;
  itinerary: ItineraryItem[];
  links?: TripLink[];
  checklist?: ChecklistItem[];
  localInfo?: LocalInfoItem[];
  cities?: RouteCity[];
  candidates?: Candidate[];
}

export const ACTIVE_KEY = "trip-dashboard-active-plan";
export const safeSlug = safeTripSlug;

const SOURCE_TO_VIEW: Record<db.PlanRow["source"], PlanSource> = {
  local: "local", google_sheets: "googleSheets", apps_script: "appsScript", sample: "sample",
};
const SOURCE_TO_ROW: Record<PlanSource, db.PlanRow["source"]> = {
  local: "local", googleSheets: "google_sheets", appsScript: "apps_script", sample: "sample",
};
const KINDS = new Set<string>(["sight", "move", "food", "stay", "todo", "form"]);

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : iso;
}

function datesLabel(row: db.PlanRow): string {
  if (row.dates_label) return row.dates_label;
  if (row.start_date && row.end_date) {
    return row.start_date === row.end_date
      ? fmtDate(row.start_date)
      : `${fmtDate(row.start_date)} - ${fmtDate(row.end_date)}`;
  }
  return row.start_date ? fmtDate(row.start_date) : "";
}

function parseDatesLabel(label: string): { start: string | null; end: string | null; label: string | null } {
  const one = (part: string): string | null => {
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(part.trim());
    return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null;
  };
  const s = String(label || "").trim();
  if (!s) return { start: null, end: null, label: null };
  const parts = s.split(/\s*[-–~～]\s*/);
  if (parts.length === 2) {
    const a = one(parts[0]);
    const b = one(parts[1]);
    if (a && b) return { start: a, end: b, label: null };
  }
  const single = one(s);
  if (single) return { start: single, end: single, label: null };
  return { start: null, end: null, label: s.slice(0, 64) };
}

function memberIdsOf(planId: string): string[] {
  return db.members().filter((m) => m.plan_id === planId).map((m) => m.user_id);
}

function toMeta(row: db.PlanRow): PlanMeta {
  const ids = memberIdsOf(row.id);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    dates: datesLabel(row),
    route: db.cities().filter((c) => c.plan_id === row.id).map((c) => c.name).join("、"),
    members: ids.map((id) => db.nameOf(id)).filter(Boolean).join("、"),
    memberIds: ids,
    note: row.note || "",
    cover: row.cover_url || "",
    source: SOURCE_TO_VIEW[row.source] || "local",
    visibility: row.visibility,
    spreadsheetId: row.external_spreadsheet_id || "",
    appsScriptUrl: row.external_apps_script_url || "",
    schema: row.external_schema || "",
    builtIn: row.source !== "local",
    published: row.status === "published",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function planVisibility(meta: Pick<PlanMeta, "visibility">): PlanVisibility {
  return meta.visibility === "invite" ? "invite" : "public";
}

export function isPublished(meta: Pick<PlanMeta, "published">): boolean {
  return meta.published !== false;
}

// ---- 読み取り -----------------------------------------------------------

export function list(): PlanMeta[] {
  return db.plans().map(toMeta);
}

export function get(slug: string): PlanMeta | null {
  const row = db.planBySlug(safeSlug(slug));
  return row ? toMeta(row) : null;
}

/** この計画の DB 上の id。無ければ空文字。 */
export function planIdOf(slug: string): string {
  return db.planBySlug(safeSlug(slug))?.id || "";
}

/** 自分が参加している計画。利用者が未確定なら空。 */
export function listMine(): PlanMeta[] {
  const me = currentUserId();
  if (!me) return [];
  const mine = new Set(db.members().filter((m) => m.user_id === me).map((m) => m.plan_id));
  return db.plans().filter((p) => mine.has(p.id)).map(toMeta);
}

/** みんなの公開計画: public かつ published かつ自分が参加していないもの。 */
export function listPublic(): PlanMeta[] {
  const me = currentUserId();
  const mine = new Set(me ? db.members().filter((m) => m.user_id === me).map((m) => m.plan_id) : []);
  return db
    .plans()
    .filter((p) => p.source === "local" && p.status === "published" && p.visibility === "public" && !mine.has(p.id))
    .map(toMeta);
}

/** 計画本体（行程・リンク・チェックリスト・都市・候補）をビュー型で組み立てる。 */
export function getData(slug: string): LocalPlanData | null {
  const row = db.planBySlug(safeSlug(slug));
  if (!row) return null;
  const votes = db.candidateVotes();
  return {
    trip: {
      title: row.title,
      dates: datesLabel(row),
      members: memberIdsOf(row.id).map((id) => db.nameOf(id)).filter(Boolean).join("、"),
      note: row.note || "",
      cover: row.cover_url || "",
    } as TripInfo,
    itinerary: db.itinerary().filter((i) => i.plan_id === row.id).map((it) => ({
      day: it.day_index ?? undefined,
      date: it.item_date || "",
      time: (it.start_time || "").slice(0, 5),
      type: it.kind,
      title: it.title,
      place: it.place || "",
      area: it.area || "",
      note: it.note || "",
      mapQuery: it.map_query || "",
      lat: it.lat ?? NaN,
      lng: it.lng ?? NaN,
      from: it.from_place || "",
      to: it.to_place || "",
      transport: it.transport || "",
      duration: it.duration_minutes != null ? String(it.duration_minutes) : "",
    })) as unknown as ItineraryItem[],
    links: db.links().filter((l) => l.plan_id === row.id).map((l) => ({
      key: l.link_key, label: l.label, url: l.url, caption: l.caption || "", icon: "",
    })) as unknown as TripLink[],
    checklist: db.checklist().filter((c) => c.plan_id === row.id).map((c) => ({
      label: c.label, done: c.status === "done", status: c.status,
    })) as unknown as ChecklistItem[],
    localInfo: [],
    cities: db.cities().filter((c) => c.plan_id === row.id).map((c) => ({ name: c.name })) as unknown as RouteCity[],
    candidates: db.candidates().filter((c) => c.plan_id === row.id).map((c) => ({
      id: c.id,
      title: c.title,
      place: c.place || "",
      proposer: db.nameOf(c.proposed_by_id) || undefined,
      adopted: Boolean(c.adopted_at),
      votes: votes.filter((v) => v.candidate_id === c.id).map((v) => db.nameOf(v.user_id)).filter(Boolean),
      createdAt: "",
    })) as unknown as Candidate[],
  };
}

// ---- 書き込み -----------------------------------------------------------

/** 表示名の並びを user_id へ解決する（未登録の名前は users に作る）。 */
function resolveMemberIds(members: string | undefined): string[] {
  const names = String(members || "")
    .split(/[、,／/]|\s*\/\s*|\s*･\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ids: string[] = [];
  for (const name of names) {
    const user = db.ensureUserLocal(name);
    if (!ids.includes(user.id)) ids.push(user.id);
  }
  return ids;
}

/** メタを追加または更新する。 */
export function upsert(meta: Partial<PlanMeta> & { slug: string }): PlanMeta | null {
  // 読み込み前に書くと、既にある計画を二重に作ってしまう（409）。
  if (db.isEnabled() && !db.isLoaded()) return null;
  const slug = safeSlug(meta.slug);
  const existing = db.planBySlug(slug);
  const me = currentUserId();
  if (!existing && db.isEnabled() && !me) return null;
  const dates = meta.dates !== undefined ? parseDatesLabel(meta.dates) : null;
  const patch: Partial<db.PlanRow> = {
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.note !== undefined ? { note: meta.note } : {}),
    ...(meta.cover !== undefined ? { cover_url: meta.cover || null } : {}),
    ...(dates ? { start_date: dates.start, end_date: dates.end, dates_label: dates.label } : {}),
    ...(meta.source !== undefined ? { source: SOURCE_TO_ROW[meta.source] } : {}),
    ...(meta.visibility !== undefined ? { visibility: meta.visibility } : {}),
    ...(meta.published !== undefined ? { status: meta.published ? "published" : "draft" } : {}),
    ...(meta.spreadsheetId !== undefined ? { external_spreadsheet_id: meta.spreadsheetId || null } : {}),
    ...(meta.appsScriptUrl !== undefined ? { external_apps_script_url: meta.appsScriptUrl || null } : {}),
    ...(meta.schema !== undefined ? { external_schema: meta.schema || null } : {}),
  };

  if (existing) {
    db.updatePlan(existing.id, patch);
  } else {
    db.createPlanLocal({
      slug,
      title: meta.title || "無題の旅行",
      base_currency: "JPY",
      owner_user_id: me || null,
      status: meta.published ? "published" : "draft",
      ...patch,
    });
    const created = db.planBySlug(slug);
    if (created && me) db.replaceMembers(created.id, [{ user_id: me, role: "owner" }]);
  }

  if (meta.members !== undefined) {
    const row = db.planBySlug(slug);
    if (row) {
      const canReplaceMembers = Boolean(
        me && db.members().some((member) =>
          member.plan_id === row.id && member.user_id === me && member.role === "owner" && member.status === "active"
        )
      );
      if (canReplaceMembers) {
        const ids = meta.memberIds !== undefined
          ? [...new Set(meta.memberIds.filter(Boolean))]
          : resolveMemberIds(meta.members);
        const owner = row.owner_user_id || me;
        // 操作中の owner は必ず残す。所有権移譲は汎用のメンバー編集では扱わない。
        if (me && !ids.includes(me)) ids.unshift(me);
        const current = memberIdsOf(row.id);
        const same = current.length === ids.length && ids.every((id) => current.includes(id));
        if (!same) {
          db.replaceMembers(row.id, ids.map((id) => {
            const currentMember = db.members().find((member) => member.plan_id === row.id && member.user_id === id);
            return {
              user_id: id,
              role: id === owner ? "owner" : currentMember?.role === "viewer" ? "viewer" : "editor",
            };
          }));
        }
      }
    }
  }
  return get(slug);
}

export async function remove(slug: string): Promise<void> {
  const row = db.planBySlug(safeSlug(slug));
  if (!row) return;
  await db.deletePlan(row.id);
  if (getActiveSlug() === row.slug) clearActive();
}

export function uniqueSlug(base: string): string {
  const slug = safeSlug(base);
  const existing = new Set(db.plans().map((p) => p.slug));
  if (!existing.has(slug)) return slug;
  for (let n = 2; n < 999; n += 1) {
    const candidate = `${slug}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

/** ビュー型の計画本体を行へ戻して保存する。 */
export function saveLocalPlan(slug: string, data: LocalPlanData, memberIds?: string[]): PlanMeta | null {
  if (db.isEnabled() && !db.isLoaded()) return null;
  const target = safeSlug(slug);
  const trip = data.trip || ({} as TripInfo);
  const areas = (data.cities || []).map((c) => c.name).filter(Boolean);
  if (!areas.length) {
    for (const it of data.itinerary || []) {
      const area = (it as { area?: string }).area || "";
      if (area && !areas.includes(area)) areas.push(area);
    }
  }
  const existing = get(target);

  const canManageMembers = !existing || Boolean(
    existing.id && currentUserId() && db.members().some((member) =>
      member.plan_id === existing.id && member.user_id === currentUserId() && member.role === "owner" && member.status === "active"
    )
  );
  const savedMeta = upsert({
    slug: target,
    title: trip.title || "無題の旅行",
    dates: trip.dates || "",
    ...(canManageMembers ? { members: trip.members || "", ...(memberIds ? { memberIds } : {}) } : {}),
    note: trip.note || "",
    cover: (trip as { cover?: string }).cover || "",
    ...(!existing ? { source: "local" as const, published: false } : {}),
  });
  if (!savedMeta) return null;

  const row = db.planBySlug(target);
  if (!row) return null;
  const canEditWorkspace = !existing || Boolean(
    currentUserId() && db.members().some((member) =>
      member.plan_id === row.id && member.user_id === currentUserId() &&
      (member.role === "owner" || member.role === "editor") && member.status === "active"
    )
  );

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const planContent: db.PlanContent = {
    itinerary: (data.itinerary || []).map((it) => {
      const item = it as unknown as Record<string, unknown>;
      const kind = String(item.type || "sight");
      const time = String(item.time || "");
      return {
        item_date: /^\d{4}-\d{2}-\d{2}/.test(String(item.date || "")) ? String(item.date).slice(0, 10) : null,
        day_index: num(item.day),
        kind: (KINDS.has(kind) ? kind : "sight") as ItemType,
        start_time: /^\d{1,2}:\d{2}/.test(time) ? `${time.slice(0, 5)}:00` : null,
        title: String(item.title || ""),
        place: (item.place as string) || null,
        area: (item.area as string) || null,
        note: (item.note as string) || null,
        map_query: (item.mapQuery as string) || null,
        lat: num(item.lat),
        lng: num(item.lng),
        from_place: (item.from as string) || null,
        to_place: (item.to as string) || null,
        transport: (item.transport as string) || null,
        duration_minutes: num(item.duration),
      };
    }),
    cities: areas.map((name) => ({ name })),
    links: (data.links || []).filter((l) => l.url).map((l) => ({
      link_key: l.key || "", label: l.label || l.key || "", url: l.url, caption: l.caption || null,
    })),
    checklist: (data.checklist || []).filter((c) => c.label).map((c) => ({
      label: c.label,
      status: ((c as { status?: string }).status as "todo" | "doing" | "done") || (c.done ? "done" : "todo"),
    })),
    candidates: (data.candidates || []).map((c) => ({
      id: c.id,
      title: c.title,
      place: c.place || null,
      proposed_by_id: c.proposer ? db.ensureUserLocal(c.proposer).id : null,
      adopted: Boolean(c.adopted),
      votes: [...new Set((c.votes || []).map((n) => db.ensureUserLocal(n).id))],
    })),
  };
  db.replacePlanContent(row.id, canEditWorkspace
    ? planContent
    : { itinerary: planContent.itinerary, cities: planContent.cities });

  return get(target);
}

export function saveData(slug: string, data: LocalPlanData): PlanMeta | null {
  return saveLocalPlan(slug, data);
}

export function duplicate(slug: string): PlanMeta | null {
  const meta = get(slug);
  if (!meta) return null;
  const newSlug = uniqueSlug(`${meta.slug}-copy`);
  const data = getData(slug);
  if (!data) return upsert({ ...meta, slug: newSlug, title: `${meta.title} のコピー`, published: false });
  const copy = JSON.parse(JSON.stringify(data)) as LocalPlanData;
  copy.trip = copy.trip || ({} as TripInfo);
  copy.trip.title = `${copy.trip.title || meta.title || "旅行"} のコピー`;
  return saveLocalPlan(newSlug, copy);
}

/** 招待リンクから受け取った計画を取り込む。DB が正なので上書き競合は起きない。 */
export function mergeLocalPlan(
  slug: string,
  incoming: LocalPlanData,
): { meta: PlanMeta | null; existed: boolean; outcome: "created" | "updated" } {
  const target = safeSlug(slug);
  const existed = Boolean(db.planBySlug(target));
  const meta = saveLocalPlan(target, incoming);
  return { meta, existed, outcome: existed ? "updated" : "created" };
}

/** 候補を id でマージし votes は和集合（招待リンクの取り込み用）。 */
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
    byId.set(c.id, {
      ...prev, ...c,
      votes: Array.from(new Set([...(prev.votes || []), ...(c.votes || [])])),
      adopted: Boolean(prev.adopted || c.adopted),
    });
  });
  return Array.from(byId.values());
}

// ---- 選択中プラン（端末固有なので localStorage 直） ---------------------

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

/** trip-config.js の組み込み計画のメタ。 */
export function seedMeta(config: Partial<TripConfig>): PlanMeta | null {
  if (!config.tripSlug && !config.tripTitle) return null;
  const mode = config.mode || "sample";
  return {
    slug: safeSlug(config.tripSlug || config.tripTitle),
    title: config.tripTitle || "旅行",
    dates: config.tripDates || "",
    route: config.tripRoute || "",
    members: config.tripMembers || "",
    cover: config.tripCover || "",
    source: mode === "appsScript" ? "appsScript" : mode === "googleSheets" ? "googleSheets" : "sample",
    visibility: "public",
    spreadsheetId: config.spreadsheetId || "",
    appsScriptUrl: config.appsScriptUrl || "",
    schema: config.schema || "trip",
    builtIn: true,
    published: true,
  };
}

/** 組み込み計画が DB に無ければ作る。 */
export function ensureSeed(config: Partial<TripConfig>): void {
  if (db.isEnabled() && !db.isLoaded()) return;
  const seed = seedMeta(config);
  if (!seed || db.planBySlug(seed.slug)) return;
  upsert(seed);
}

/** ダッシュボード用に、選択中プランの設定上書きを返す。 */
export function resolveConfigOverride(config: Partial<TripConfig>): Partial<TripConfig> {
  const slug = getActiveSlug();
  let meta = slug ? get(slug) : null;
  // データ読み込み前でも URL/保存済みの slug は信用する。
  // ここで種計画へ落とすと、読み終えたあとも別の計画を開いたままになる。
  if (!meta && slug) return { tripSlug: slug };
  if (!meta) meta = list()[0] || seedMeta(config);
  if (!meta) return {};
  setActiveSlug(meta.slug);
  const override: Partial<TripConfig> = { tripSlug: meta.slug, tripTitle: meta.title || config.tripTitle };
  if (meta.source === "local") {
    override.mode = "local";
  } else {
    override.mode = meta.source === "appsScript" ? "appsScript" : meta.source === "sample" ? "sample" : "googleSheets";
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
