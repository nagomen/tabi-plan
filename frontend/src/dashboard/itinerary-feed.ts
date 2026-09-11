import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { isMemberOf } from "../shared/membership";
import { joinersOn, leaversOn } from "../shared/member-period";
import { dayTracks, pickTrack, isItemInTrack, everyoneIds, type DayTrack } from "../shared/day-tracks";
import { parseFlight, parseTrain } from "../shared/flight-info";
import { currentUserId } from "../shared/identity";
import * as db from "../shared/db";
import { escapeHtml } from "../shared/dom";
import type { DayGroup } from "./types";
import { fetchDayWeather, weatherLabel } from "../shared/weather";
import { buildItineraryShareText } from "../shared/itinerary-text";
import { mdLabel } from "../shared/date";
import { mapsSearchUrl } from "../shared/maps";
import type { ItineraryItem } from "../shared/types";
import { CONFIG, state } from "./state";
import { flashLabel, root } from "./dom";
import { planId } from "./plan-access";
import { dayCoord, nowHM, nowMinutes, timeToMinutes, todayISO, untilLabel } from "./days";
import { flightTicketHtml, trainTicketHtml } from "./flight-notes";

/** 旅行の全日程を LINE で送れるテキストにして共有／コピーする。 */
export async function shareSchedule(): Promise<void> {
  const btn = root.querySelector<HTMLButtonElement>("[data-copy-schedule]");
  const text = buildItineraryShareText(state.data.trip, state.days, (id) => db.nameOf(id));
  if (!text.trim()) {
    if (btn) flashLabel(btn, "[data-copy-schedule-label]", "日程がありません");
    return;
  }
  // モバイルは共有シート（LINE を直接選べる）、非対応環境はクリップボードへコピー。
  if (navigator.share) {
    try {
      await navigator.share({ title: state.data.trip.title || "旅行日程", text });
    } catch {
      /* 共有キャンセルは無視 */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (btn) flashLabel(btn, "[data-copy-schedule-label]", "コピーしました");
  } catch {
    window.prompt("日程をコピーしてLINEに貼り付けてください", text);
  }
}

const KIND_ICON: Record<string, IconName> = {
  sight: "camera",
  food: "cake",
  move: "arrowsRightLeft",
  stay: "buildingOffice2",
  todo: "check",
  form: "documentText",
};

function kindIcon(type: string): string {
  return icon(KIND_ICON[type] || "check");
}

// ---- 1日分の「予定」ブロック（複数日を縦に積めるように分離） ----------

function stayOfDay(d: DayGroup | undefined): ItineraryItem | null {
  return d ? d.items.find((i) => String(i.type) === "stay") || null : null;
}

function sameHotel(a: ItineraryItem | null, b: ItineraryItem | null): boolean {
  return !!a && !!b && (a.title || "").trim() === (b.title || "").trim();
}

function stayRowHtml(s: ItineraryItem, variant: string, label: string): string {
  const place = s.place && s.place !== s.title ? s.place : "";
  const sub = variant === " is-prev"
    ? `${label} ・ チェックアウト`
    : s.time ? `${label} ・ IN ${s.time}` : label;
  return `<div class="tl-stay${variant}">
    <span class="tl-stay-ic">${icon("buildingOffice2")}</span>
    <div class="tl-stay-body">
      <span class="tl-stay-label">${escapeHtml(sub)}</span>
      <span class="tl-stay-name">${escapeHtml(s.title || "宿泊先")}</span>
      ${place ? `<span class="tl-stay-place">${escapeHtml(place)}</span>` : ""}
    </div>
    <a class="tl-stay-map" href="${mapsSearchUrl(s.mapQuery || s.place || s.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a>
  </div>`;
}

function stayHtmlForDay(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  const todayStay = stayOfDay(day);
  let prevStay: ItineraryItem | null = null;
  for (let k = idx - 1; k >= 0; k--) {
    const s = stayOfDay(state.days[k]);
    if (s) { prevStay = s; break; }
  }
  const continued = sameHotel(prevStay, todayStay);
  const tonight = day.date === todayISO() ? "今夜の宿" : "宿泊";
  const rows: string[] = [];
  if (prevStay && !continued) rows.push(stayRowHtml(prevStay, " is-prev", "前泊"));
  if (todayStay) rows.push(stayRowHtml(todayStay, "", continued ? "連泊" : tonight));
  if (!rows.length) {
    rows.push(`<div class="tl-stay is-empty"><span class="tl-stay-ic">${icon("buildingOffice2")}</span><div class="tl-stay-body"><span class="tl-stay-label">${tonight}</span><span class="tl-stay-name tl-stay-muted">未定</span></div></div>`);
  }
  return rows.join("");
}

// ---- 参加者で行程が分かれる日のタブ切替 ----------------------------------

/** 日付 → 選択中の班キー。タブ切替の記憶（フィード再描画をまたいで保持する）。 */
export const dayTrackChoice = new Map<string, string>();

/** その日に旅行へ在籍しているメンバーID（途中合流/離脱を反映）。 */
function presentIdsOf(day: DayGroup): string[] {
  const id = planId();
  return id ? TripPlans.memberIdsPresentOn(id, day.date) : [];
}

/** その日の班。一部メンバーだけの予定が無い日（＝分かれない日）は空配列。 */
function tracksOf(day: DayGroup): DayTrack[] {
  return dayTracks(day.items.map((item) => item.members), presentIdsOf(day));
}

export function selectedTrack(day: DayGroup): DayTrack | null {
  return pickTrack(tracksOf(day), dayTrackChoice.get(day.date), currentUserId() || "");
}

/** 班タブがある日は、全員の予定（members 空か全員入り）＋選択中の班の予定だけに絞る。 */
export function trackItems(day: DayGroup, track: DayTrack | null): ItineraryItem[] {
  if (!track) return day.items;
  const everyone = everyoneIds(day.items.map((item) => item.members), presentIdsOf(day));
  return day.items.filter((item) => isItemInTrack(item.members, track, everyone));
}

/**
 * 班タブに実名を出してよいか。名前が見えるのは計画の参加者（plan_members）だけ。
 * 観覧のみの人（公開計画のゲストなど）には個人名を出さない。
 */
function canSeeTrackMemberNames(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return Boolean(meta && isMemberOf(meta));
}

/** 班タブの表示名。参加者には名前（本人は「あなた」）、観覧のみの人には匿名のグループ名。 */
function trackLabel(track: DayTrack, index: number, withNames: boolean): string {
  if (!withNames) return `${String.fromCharCode(65 + (index % 26))}グループ`;
  const you = currentUserId() || "";
  const names: string[] = [];
  if (you && track.memberIds.includes(you)) names.push("あなた");
  for (const id of track.memberIds) {
    if (id === you) continue;
    const name = db.nameOf(id);
    if (name) names.push(name);
  }
  if (!names.length) return "そのほか";
  return names.slice(0, 3).join("・") + (names.length > 3 ? ` 他${names.length - 3}人` : "");
}

function dayTrackTabsHtml(day: DayGroup): string {
  const tracks = tracksOf(day);
  if (!tracks.length) return "";
  const selected = selectedTrack(day);
  const withNames = canSeeTrackMemberNames();
  return `<div class="tl-day-tabs" role="tablist" aria-label="班ごとの行程">` +
    tracks.map((track, index) =>
      `<button class="tl-day-tab" type="button" role="tab" aria-selected="${track.key === selected?.key}"` +
      ` data-track-day="${escapeHtml(day.date)}" data-track-key="${escapeHtml(track.key)}">` +
      `${icon("users")}<span class="tl-day-tab-label">${escapeHtml(trackLabel(track, index, withNames))}</span></button>`
    ).join("") +
    `</div>`;
}

function timelineHtmlForDay(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  // 予定ごとに対象メンバー名は書かない。行程が班に分かれる日は
  // dayTrackTabsHtml の帯タブで切り替え、名前はタブにだけ出す。
  const track = selectedTrack(day);
  return trackItems(day, track).filter((i) => String(i.type) !== "stay").map((item) => {
    const type = String(item.type || "todo");
    let segA = item.origin || "";
    let segB = item.destination || "";
    if (type === "move" && (!segA || !segB) && /→|->/.test(item.title || "")) {
      const parts = (item.title || "").split(/→|->/);
      segA = segA || (parts[0] || "").trim();
      segB = segB || (parts[1] || "").trim();
    }
    // 飛行機・鉄道の移動は専用カードで見せ、メタ行では重複しない。
    const flight = type === "move" ? parseFlight(item) : null;
    const train = type === "move" && !flight ? parseTrain({ ...item, origin: segA, destination: segB }) : null;
    const placeText = item.place && item.place !== item.title ? `場所: ${item.place}` : "";
    const moveText = type === "move" && !flight && !train ? [item.transport, item.duration].filter(Boolean).join("・") : "";
    const noteText = flight ? flight.restNote : train ? train.restNote : item.note;
    const metaText = [moveText || placeText, noteText].filter(Boolean).join(" / ");
    const label = `<span class="tl-kind ${escapeHtml(type)}">${escapeHtml(item.typeLabel || item.type || "予定")}</span>`;
    const title = type === "move" && (segA || segB)
      ? `<div class="tl-seg"><span>${escapeHtml(segA || "出発")}</span><span class="tl-seg-arr">${icon("arrowLongRight")}</span><span>${escapeHtml(segB || "到着")}</span></div>`
      : `<h3>${escapeHtml(item.title || "")}</h3>`;

    return `<article class="tl-item" data-kind="${escapeHtml(type)}">
      <time class="tl-time">${escapeHtml(item.time || "")}</time>
      <span class="tl-rail"><span class="tl-dot ${escapeHtml(type)}">${kindIcon(type)}</span></span>
      <div class="tl-plan">
        <div class="tl-plan-line">${label}${title}</div>
        ${flight ? flightTicketHtml(flight, item.duration, segA, segB) : train ? trainTicketHtml(train, item.duration, segA, segB, item.time) : ""}
        ${item.needed ? `<p class="tl-needed">${escapeHtml(item.needed)}</p>` : ""}
        <p class="tl-meta">${metaText ? `<span class="tl-meta-text">${escapeHtml(metaText)}</span>` : ""}<a class="tl-maplink" href="${mapsSearchUrl(item.mapQuery || item.place || item.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a></p>
      </div>
    </article>`;
  }).join("");
}

/** 表示中の各日について、座標と日付から天気を非同期取得してチップを埋める。 */
export function hydrateWeather(fromIdx: number, toIdx: number): void {
  for (let i = fromIdx; i <= toIdx; i++) {
    const day = state.days[i];
    if (!day || day.weather) continue; // 手入力（Sheets の天気欄）があれば優先
    const coord = dayCoord(day);
    if (!coord || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    void fetchDayWeather(coord.lat, coord.lng, day.date).then((w) => {
      if (!w) return;
      const span = root.querySelector<HTMLElement>(`[data-weather-for="${day.date}"]`);
      if (span) span.textContent = `${weatherLabel(w)}${w.label ? " " + w.label : ""}`;
    });
  }
}

/** その日の途中合流/離脱バッジ。参加期間（plan_members の from/to_date）から導出する。 */
function presenceBadgesHtml(day: DayGroup): string {
  const id = planId();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return "";
  const periods = TripPlans.memberPeriods(id);
  if (!periods.length) return "";
  const first = state.days[0]?.date || "";
  const last = state.days[state.days.length - 1]?.date || "";
  const joins = joinersOn(periods, day.date, first).map((uid) => db.nameOf(uid)).filter(Boolean);
  const leaves = leaversOn(periods, day.date, last).map((uid) => db.nameOf(uid)).filter(Boolean);
  const parts: string[] = [];
  if (joins.length) parts.push(`<span class="tl-day-presence is-join">${icon("users")}${escapeHtml(joins.join("・"))} 合流</span>`);
  if (leaves.length) parts.push(`<span class="tl-day-presence is-leave">${escapeHtml(leaves.join("・"))} この日まで</span>`);
  return parts.join("");
}

export function dayBlockHtml(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  const head = [day.day, day.area, mdLabel(day.date)].filter(Boolean).join(" ・ ");
  // 手入力があれば表示。無ければ空にしておき、hydrateWeather が自動取得で埋める。
  const weather = `<span class="tl-dayblock-weather" data-weather-for="${escapeHtml(day.date)}">${day.weather ? "☀ " + escapeHtml(day.weather) : ""}</span>`;
  const items = timelineHtmlForDay(idx);
  return `<section class="tl-dayblock" data-day-block="${idx}">
    <div class="tl-dayblock-head"><span class="tl-dayblock-lead"><span>${escapeHtml(head)}</span>${presenceBadgesHtml(day)}</span>${weather}</div>
    ${dayTrackTabsHtml(day)}
    ${stayHtmlForDay(idx)}
    ${items || `<p class="tl-dayblock-empty">予定はまだありません</p>`}
  </section>`;
}

/** 今日が選択中の日のとき、現在時刻と「いま/次の予定」を示すカード。 */
export function nowNextHtml(day: DayGroup): string {
  if (day.date !== todayISO()) return "";
  const cur = nowMinutes();
  const timed = trackItems(day, selectedTrack(day))
    .filter((i) => String(i.type) !== "stay")
    .map((i) => ({ i, m: timeToMinutes(i.time) }))
    .filter((x): x is { i: ItineraryItem; m: number } => x.m != null)
    .sort((a, b) => a.m - b.m);

  let nowLine = "";
  let nextLine = "";
  if (timed.length) {
    const next = timed.find((x) => x.m >= cur);
    const past = [...timed].reverse().find((x) => x.m <= cur);
    if (past && (!next || past.m !== next.m)) {
      nowLine = `<div class="tl-now-line"><span class="tl-now-lead">いま</span><b>${escapeHtml(past.i.time || "")} ${escapeHtml(past.i.title || past.i.typeLabel || "")}</b></div>`;
    }
    if (next) {
      nextLine = `<div class="tl-now-line"><span class="tl-now-lead">次</span><b>${escapeHtml(next.i.time || "")} ${escapeHtml(next.i.title || next.i.typeLabel || "")}</b><span class="tl-now-until">${escapeHtml(untilLabel(next.m - cur))}</span></div>`;
    } else {
      nextLine = `<div class="tl-now-line"><span class="tl-now-lead">次</span><b>本日の予定は終了です</b></div>`;
    }
  }
  return `<section class="tl-now">
    <div class="tl-now-head">${icon("clock")}<span>現在 ${nowHM()} ・ 旅行中</span></div>
    ${nowLine}${nextLine || `<div class="tl-now-line"><span class="tl-now-lead">予定</span><b>時刻つきの予定がありません</b></div>`}
  </section>`;
}
