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
import { formatDurationMinutes, parseDurationMinutes } from "./travel-duration";
import { collisionResistantPlanSlug } from "./plan-slug";
import { presentMemberIds, type MemberPeriod } from "./member-period";
import type {
  TripData, TripInfo, ItineraryItem, TripLink, ChecklistItem, LocalInfoItem,
  RouteCity, Candidate, ItemType,
} from "./types";

export { coordsFor, TYPES } from "./geo";

export type PlanSource = "local" | "sample";
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

const SOURCE_TO_ROW: Record<PlanSource, db.PlanRow["source"]> = {
  local: "local", sample: "sample",
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
    source: row.source === "sample" ? "sample" : "local",
    visibility: row.visibility,
    builtIn: row.source === "sample",
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
      origin: it.from_place || "",
      originLat: it.from_lat == null ? undefined : Number(it.from_lat),
      originLng: it.from_lng == null ? undefined : Number(it.from_lng),
      destination: it.to_place || "",
      destinationLat: it.to_lat == null ? undefined : Number(it.to_lat),
      destinationLng: it.to_lng == null ? undefined : Number(it.to_lng),
      transport: it.transport || "",
      duration: it.duration_minutes != null ? formatDurationMinutes(it.duration_minutes) : "",
      members: it.member_ids && it.member_ids.length ? it.member_ids : undefined,
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
              // 追加/削除で他メンバーの参加期間（途中合流/離脱）を消さない。
              from_date: currentMember?.from_date ?? null,
              to_date: currentMember?.to_date ?? null,
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
  const existing = new Set(db.plans().map((p) => p.slug));
  // bootstrapは権限上見えてよい計画だけを返す。可視一覧の連番から空きを
  // 探すと、見えていないinvite計画と衝突するため、新規slugには乱数を含める。
  return collisionResistantPlanSlug(safeSlug(base), (candidate) => existing.has(candidate));
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
    if (v === null || v === undefined || String(v).trim() === "") return null;
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
        from_place: (item.origin as string) || null,
        from_lat: num(item.originLat),
        from_lng: num(item.originLng),
        to_place: (item.destination as string) || null,
        to_lat: num(item.destinationLat),
        to_lng: num(item.destinationLng),
        transport: (item.transport as string) || null,
        duration_minutes: parseDurationMinutes(item.duration),
        member_ids: Array.isArray(item.members) && item.members.length
          ? (item.members as unknown[]).filter((x): x is string => typeof x === "string" && Boolean(x))
          : null,
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

/**
 * 計画を複製する。人の公開計画を自分用の下書きとして持ち帰るのに使う。
 *
 * 元の参加者は引き継がない。人の計画をコピーしたときに、その人の
 * メンバー一覧まで自分の計画に入ってしまうのを避けるため。
 * 作成者は複製した本人になり、非公開の下書きとして始まる
 * （公開状態は saveLocalPlan / upsert が新規作成時に false にする）。
 */
export function duplicate(slug: string): PlanMeta | null {
  const meta = get(slug);
  if (!meta) return null;
  const newSlug = uniqueSlug(`${meta.slug}-copy`);
  const me = currentUserId();
  const data = getData(slug);
  if (!data) {
    return upsert({
      ...meta,
      slug: newSlug,
      title: `${meta.title} のコピー`,
      published: false,
      members: "",
      memberIds: me ? [me] : [],
    });
  }
  const copy = JSON.parse(JSON.stringify(data)) as LocalPlanData;
  copy.trip = copy.trip || ({} as TripInfo);
  copy.trip.title = `${copy.trip.title || meta.title || "旅行"} のコピー`;
  copy.trip.members = "";
  return saveLocalPlan(newSlug, copy, me ? [me] : []);
}

/**
 * この計画から作った自分のコピーが既にあれば返す。
 * slug は「元のslug-copy-乱数」で作るので、その形と参加者で見分ける。
 */
export function existingCopyOf(slug: string): PlanMeta | null {
  const me = currentUserId();
  if (!me) return null;
  const prefix = safeSlug(slug) + "-copy-";
  return list().find((meta) =>
    meta.slug.startsWith(prefix) && (meta.memberIds || []).includes(me)
  ) || null;
}

/**
 * 複製して、保存が届くまで待つ。
 *
 * 編集画面はサーバーから読み直すので、送信が終わる前に移ると空の計画に
 * なる。また、以前の失敗で同じ URL の計画が残っていると slug が重なって
 * 弾かれることがあるので、その場合だけ引き直して一度やり直す。
 */
export async function duplicateAndSave(slug: string): Promise<PlanMeta | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const checkpoint = db.mutationCheckpoint();
    const copy = duplicate(slug);
    if (!copy) return null;
    try {
      await db.flushMutations(checkpoint);
      return copy;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /同じURL|ER_DUP_ENTRY/.test(message)) continue;
      throw error;
    }
  }
  return null;
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
    source: mode === "local" ? "local" : "sample",
    visibility: "public",
    builtIn: true,
    published: true,
  };
}

/** 組み込み計画が DB に無ければ作る。 */
export function ensureSeed(config: Partial<TripConfig>): void {
  // MySQL運用ではDBだけを正本にし、静的設定から旅行を自動作成しない。
  if (db.isEnabled()) return;
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
  if (!meta) meta = list()[0] || (!db.isEnabled() ? seedMeta(config) : null);
  if (!meta) return {};
  setActiveSlug(meta.slug);
  const override: Partial<TripConfig> = { tripSlug: meta.slug, tripTitle: meta.title || config.tripTitle };
  override.mode = meta.source === "sample" ? "sample" : "local";
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

// ---- メンバーの参加期間（途中合流/離脱）--------------------------------

/** 計画の在籍メンバーの参加期間。NULL 端は「全日程」を意味する。 */
export function memberPeriods(planId: string): MemberPeriod[] {
  return db.members()
    .filter((m) => m.plan_id === planId && m.status === "active")
    .map((m) => ({ user_id: m.user_id, from_date: m.from_date ?? null, to_date: m.to_date ?? null }));
}

/** 費用日 date に旅行へ在籍しているメンバーIDだけを返す。date 未指定なら全員。 */
export function memberIdsPresentOn(planId: string, date: string): string[] {
  return presentMemberIds(memberPeriods(planId), date);
}

const ROUTE_SPLIT_RE = /\s*(?:→|、|,|\/|・|\|)\s*/;
const ROUTE_NOISE_RE = /旅行|計画|ダッシュボード|年|月/;

/** ルート・行き先文字列を地名の配列へ割る（「旅行」などのノイズ語と空要素は除く）。 */
export function splitRouteLocations(text: string): string[] {
  return String(text || "")
    .split(ROUTE_SPLIT_RE)
    .map((part) => part.trim())
    .filter((part) => part && !ROUTE_NOISE_RE.test(part));
}
