import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { isMemberOf } from "../shared/membership";
import { joinersOn, leaversOn } from "../shared/member-period";
import {
  dayTracks, publicDayTracks, pickTrack, isItemInTrack, isPublicItemInTrack, isEveryoneItem,
  rejoinIndexes, everyoneIds, type DayTrack,
} from "../shared/day-tracks";
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
import type { Candidate } from "../shared/types";
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
  const publicTracks = publicDayTracks(day.items.map((item) => item.publicDayTrackKeys));
  if (publicTracks.length) return publicTracks;
  return dayTracks(day.items.map((item) => item.members), presentIdsOf(day));
}

export function selectedTrack(day: DayGroup): DayTrack | null {
  return pickTrack(tracksOf(day), dayTrackChoice.get(day.date), currentUserId() || "");
}

/** 班タブがある日は、全員の予定（members 空か全員入り）＋選択中の班の予定だけに絞る。 */
export function trackItems(day: DayGroup, track: DayTrack | null): ItineraryItem[] {
  if (!track) return day.items;
  if (day.items.some((item) => item.publicDayTrackKeys?.length)) {
    return day.items.filter((item) => isPublicItemInTrack(item.publicTrackKey, track));
  }
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

/** タイムライン上で、別行動の直後に全員共通へ戻る予定を合流地点として抽出する。 */
function rejoinItemsOf(day: DayGroup): Set<ItineraryItem> {
  const items = day.items.filter((item) => String(item.type) !== "stay");
  const isPublic = items.some((item) => item.publicDayTrackKeys?.length);
  const everyone = isPublic ? [] : everyoneIds(items.map((item) => item.members), presentIdsOf(day));
  const specific = items.map((item) => isPublic
    ? Boolean(item.publicTrackKey)
    : !isEveryoneItem(item.members, everyone));
  return new Set(rejoinIndexes(specific).map((index) => items[index]));
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

/** mergeへ入ってくる側線に、現在表示していないブランチへの直接リンクを載せる。 */
function alternateTrackLinksHtml(day: DayGroup, selected: DayTrack | null): string {
  if (!selected) return "";
  const tracks = tracksOf(day);
  const withNames = canSeeTrackMemberNames();
  const links = tracks.flatMap((track, index) => {
    if (track.key === selected.key) return [];
    const label = trackLabel(track, index, withNames);
    const compactLabel = withNames
      ? ([...label].length > 6 ? `${[...label].slice(0, 5).join("")}…` : label)
      : `${String.fromCharCode(65 + (index % 26))}班`;
    return [`<button class="tl-merge-branch" type="button"` +
      ` data-track-day="${escapeHtml(day.date)}" data-track-key="${escapeHtml(track.key)}"` +
      ` aria-label="${escapeHtml(label)}の別行動を表示" title="${escapeHtml(label)}">` +
      `${escapeHtml(compactLabel)}</button>`];
  });
  return links.length ? `<span class="tl-merge-branches">${links.join("")}</span>` : "";
}

/** 予定と旅行固有の特集ページを結ぶ、行程内の補助導線。 */
function relatedCasinoGuideHtml(item: ItineraryItem): string {
  const itemText = [item.title, item.place, item.typeLabel].filter(Boolean).join(" ");
  if (String(item.type) !== "sight" || !/(?:casino|カジノ)/i.test(itemText)) return "";

  const guide = state.data.links.find((link) => link.key === "casinoGuide" && link.url);
  if (!guide) return "";

  const label = guide.label?.trim() || "カジノガイド";
  const caption = guide.caption?.trim();
  return `<a class="tl-related-guide" data-casino-guide-link href="${escapeHtml(guide.url)}" aria-label="${escapeHtml(label)}を開く">
    <span class="tl-related-guide-ic" aria-hidden="true">${icon("documentText")}</span>
    <span class="tl-related-guide-copy">
      <span class="tl-related-guide-kicker">プレイ前に確認</span>
      <strong>${escapeHtml(label)}</strong>
      ${caption ? `<small>${escapeHtml(caption)}</small>` : ""}
    </span>
    <span class="tl-related-guide-arrow" aria-hidden="true">${icon("chevronRight")}</span>
  </a>`;
}

function candidateSlotGroups(date: string): Candidate[][] {
  const groups = new Map<string, Candidate[]>();
  (state.data.candidates || []).filter((candidate) => candidate.slotId && candidate.date === date)
    .forEach((candidate) => {
      const list = groups.get(candidate.slotId!) || [];
      list.push(candidate);
      groups.set(candidate.slotId!, list);
    });
  return [...groups.values()]
    .filter((options) => !options.some((candidate) => candidate.adopted))
    .sort((a, b) => String(a[0]?.time || "").localeCompare(String(b[0]?.time || "")));
}

function candidateSlotHtml(options: Candidate[]): string {
  const first = options[0];
  if (!first?.slotId) return "";
  const id = planId();
  const me = currentUserId();
  const isOwner = Boolean(id && me && db.planById(id)?.owner_user_id === me);
  const accepted = id ? db.members().filter((member) =>
    member.plan_id === id && member.status === "active" && member.access_status === "active"
  ).map((member) => member.user_id) : [];
  const present = id ? TripPlans.memberIdsPresentOn(id, first.date || "") : [];
  const scope = first.memberIds?.length ? new Set(first.memberIds) : null;
  const eligible = accepted.filter((userId) => present.includes(userId) && (!scope || scope.has(userId)));
  const voters = new Set(options.flatMap((candidate) => candidate.voteIds || []).filter((userId) => eligible.includes(userId)));
  const remainingNames = eligible.filter((userId) => !voters.has(userId)).map((userId) => db.nameOf(userId)).filter(Boolean);
  const mine = options.find((candidate) => me && candidate.voteIds?.includes(me));
  const allVoted = eligible.length > 0 && voters.size === eligible.length;
  const max = Math.max(0, ...options.map((candidate) => candidate.voteIds?.filter((id) => eligible.includes(id)).length || 0));
  const tied = allVoted && options.filter((candidate) => (candidate.voteIds?.filter((id) => eligible.includes(id)).length || 0) === max).length > 1;
  const canVote = Boolean(me && eligible.includes(me));
  const progress = eligible.length
    ? `${voters.size}/${eligible.length}人 投票済み`
    : "投票対象を確認中";
  return `<section class="tl-vote-slot" data-candidate-slot="${escapeHtml(first.slotId)}">
    <div class="tl-vote-slot-rail" aria-hidden="true"><span>${icon("star")}</span></div>
    <div class="tl-vote-slot-main">
      <div class="tl-vote-slot-head">
        <time>${escapeHtml(first.time || "時刻未定")}</time>
        <span class="tl-vote-label">みんなで決める</span>
        <span class="tl-vote-progress">${escapeHtml(progress)}</span>
      </div>
      <h3>この時間、どう過ごす？</h3>
      <p class="tl-vote-guide">一人ひとつ選択。投票後も全候補を読んで変更できます。全員が投票したあと、旅行マスターが終了すると最多票の候補が日程へ確定します。</p>
      <div class="tl-vote-options" role="radiogroup" aria-label="この時間の候補">${options.map((candidate) => {
        const votes = candidate.voteIds?.filter((userId) => eligible.includes(userId)).length || 0;
        const selected = mine?.id === candidate.id;
        return `<button type="button" class="tl-vote-option${selected ? " is-selected" : ""}"
          data-candidate-vote="${escapeHtml(candidate.id)}" data-candidate-slot-id="${escapeHtml(first.slotId!)}"
          role="radio" aria-checked="${selected}" ${canVote ? "" : "disabled"}>
          <span class="tl-vote-radio" aria-hidden="true"></span>
          <span class="tl-vote-copy">
            <strong>${escapeHtml(candidate.title)}</strong>
            ${candidate.place ? `<small>${escapeHtml(candidate.place)}</small>` : ""}
            ${candidate.note ? `<span class="tl-vote-note">${escapeHtml(candidate.note)}</span>` : ""}
          </span>
          <span class="tl-vote-total">${votes}<small>票</small></span>
        </button>`;
      }).join("")}</div>
      <p class="tl-vote-status" data-candidate-vote-status="${escapeHtml(first.slotId)}">${
        tied ? "全員投票済みですが同票です。誰かが投票を変更すると終了できます。"
            : allVoted
              ? isOwner ? "全員投票済み。内容を確認して投票を終了できます。" : "全員投票済み。旅行マスターの確定待ちです。"
            : mine
              ? `「${escapeHtml(mine.title)}」に投票中。${remainingNames.length ? `未投票: ${escapeHtml(remainingNames.join("・"))}` : "終了前なら変更できます。"}`
              : canVote ? `あなたの選択を待っています。${remainingNames.length ? ` 未投票: ${escapeHtml(remainingNames.join("・"))}` : ""}`
                : "投票対象の参加メンバーのみ選択できます。"
      }</p>${isOwner ? `<div class="tl-vote-finalize-row">
        <span>終了すると最多票の候補を予定に追加します</span>
        <button type="button" class="tl-vote-finalize" data-candidate-finalize="${escapeHtml(first.slotId)}"
          ${allVoted && !tied ? "" : "disabled"}>${tied ? "同票を解消してください" : allVoted ? "投票を終了して確定" : "全員の投票待ち"}</button>
      </div>` : ""}
    </div>
  </section>`;
}

function timelineHtmlForDay(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  // 予定ごとに対象メンバー名は書かない。行程が班に分かれる日は
  // 常設タブで班を切り替え、名前はタブにだけ出す。
  const track = selectedTrack(day);
  const rejoinItems = rejoinItemsOf(day);
  const everyone = everyoneIds(day.items.map((item) => item.members), presentIdsOf(day));
  const alternateTracks = alternateTrackLinksHtml(day, track);
  let casinoGuideShown = false;
  const pendingSlots = candidateSlotGroups(day.date);
  const visibleItems = trackItems(day, track).filter((i) => String(i.type) !== "stay");
  const rendered = visibleItems.map((item) => {
    const before: string[] = [];
    while (pendingSlots.length && String(pendingSlots[0][0]?.time || "99:99") <= String(item.time || "99:99")) {
      before.push(candidateSlotHtml(pendingSlots.shift()!));
    }
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
    const casinoGuide = casinoGuideShown ? "" : relatedCasinoGuideHtml(item);
    if (casinoGuide) casinoGuideShown = true;

    const isBranchSpecific = Boolean(item.publicTrackKey) || (track
      ? !isEveryoneItem(item.members, everyone)
      : false);
    const rejoin = rejoinItems.has(item)
      ? `<div class="tl-merge" role="note" aria-label="全員が合流">
          <span aria-hidden="true"></span>
          <span class="tl-merge-graph">
            <svg viewBox="0 0 28 34" aria-hidden="true"><path d="M14 2v30"/><path d="M20 2v8c0 7-2 11-6 11"/></svg>
            <span class="tl-merge-node">合流</span>
          </span>
          <span class="tl-merge-copy">
            <span class="tl-merge-link-line" aria-hidden="true"></span>
            ${alternateTracks}
          </span>
        </div>`
      : "";
    return `${before.join("")}${rejoin}<article class="tl-item${isBranchSpecific ? " is-branch-specific" : ""}" data-kind="${escapeHtml(type)}">
      <time class="tl-time">${escapeHtml(item.time || "")}</time>
      <span class="tl-rail"><span class="tl-dot ${escapeHtml(type)}">${kindIcon(type)}</span></span>
      <div class="tl-plan">
        <div class="tl-plan-line">${label}${title}</div>
        ${flight ? flightTicketHtml(flight, item.duration, segA, segB) : train ? trainTicketHtml(train, item.duration, segA, segB, item.time) : ""}
        ${item.needed ? `<p class="tl-needed">${escapeHtml(item.needed)}</p>` : ""}
        ${casinoGuide}
        <p class="tl-meta">${metaText ? `<span class="tl-meta-text">${escapeHtml(metaText)}</span>` : ""}<a class="tl-maplink" href="${mapsSearchUrl(item.mapQuery || item.place || item.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a></p>
      </div>
    </article>`;
  }).join("");
  return rendered + pendingSlots.map(candidateSlotHtml).join("");
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
