import * as db from "../shared/db";
import Sortable from "sortablejs";
import { escapeHtml } from "../shared/dom";
import { parseISO, toISO, weekday } from "../shared/date";
import { icon } from "../shared/icons";
import { currentAccount } from "../shared/account-store";
import { presentMemberIds } from "../shared/member-period";
import { dayTracks, pickTrack, isItemInTrack, everyoneIds, type DayTrack } from "../shared/day-tracks";
import {
  type ItemKind, type ItemStrKey, type Item, type Day, type GeoTarget, KINDS, TRANSPORTS, TRANSPORT_ICONS,
  model, state, stayCovering, cityForDate, findItem, inclusiveDateCount, applyCityDateDefaults,
} from "./editor-state";
import { daysEl, warnEl, dayCountEl, dayStripEl, tripSummaryEl } from "./editor-dom";
import { updateSteps } from "./steps";
import { updateCalsync } from "./calendar-sync";
import { markDirty } from "./persist";
import { refreshMap } from "./map";

export function rebuildDays(): void {
  const a = parseISO(model.startDate);
  const b = parseISO(model.endDate);
  warnEl.hidden = !(model.startDate && model.endDate && (!a || !b || b < a));
  if (!a || !b || b < a) return;
  const byDate: Record<string, Day> = {};
  model.days.forEach((d) => { byDate[d.date] = d; });
  const next: Day[] = [];
  const cursor = new Date(a.getTime());
  let guard = 0;
  while (cursor <= b && guard < 400) {
    const iso = toISO(cursor);
    next.push(byDate[iso] || { date: iso, area: "", items: [], stay: null });
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  model.days = next;
  applyCityDateDefaults();
}

export function stayNightLimits(item: Item): { cityMax: number; tripMax: number; cityName: string } {
  const found = findItem(item.id);
  if (!found) {
    const tripMax = Math.max(model.days.length, 1);
    item.nights = Math.max(1, Math.min(tripMax, Number(item.nights) || 1));
    return { cityMax: tripMax, tripMax, cityName: "" };
  }
  const dayIndex = model.days.indexOf(found.day);
  const city = cityForDate(found.day.date);
  const tripMax = Math.max(1, model.days.length - Math.max(0, dayIndex));
  const cityMax = city
    ? inclusiveDateCount(found.day.date, city.toDate)
    : tripMax;
  item.nights = Math.max(1, Math.min(tripMax, Number(item.nights) || 1));
  return { cityMax: Math.max(1, Math.min(cityMax, tripMax)), tripMax, cityName: city?.name || "" };
}

function stayNightOptions(item: Item): string {
  const limits = stayNightLimits(item);
  return Array.from({ length: limits.tripMax }, (_, i) => i + 1)
    .map((n) => {
      const note = limits.cityName && n === limits.cityMax
        ? `（${limits.cityName}滞在の最大）`
        : limits.cityName && n > limits.cityMax
          ? "（滞在都市を超える）"
          : "";
      return `<option value="${n}"${item.nights === n ? " selected" : ""}>${n}泊${note}</option>`;
    })
    .join("");
}

// ---- レンダリング: 日とタイムライン -------------------------------------

function dayHeader(day: Day, index: number): string {
  const d = parseISO(day.date);
  const dayName = `Day ${index + 1}`;
  const cover = stayCovering(index);
  const city = cityForDate(day.date);
  const area = (city ? city.name : "") || day.area || (cover && cover.stay.title ? cover.stay.title : "") || "エリア未設定";
  const stay = cover && cover.stay.title
    ? cover.stay.title + (cover.stay.nights > 1 ? `（${cover.stay.nights}泊）` : "")
    : "宿 未定";
  return (
    `<div class="pe-day-head">` +
    `<div class="pe-day-badge"><b>${dayName}</b><span>${d ? `${d.getMonth() + 1}/${d.getDate()}(${weekday(d)})` : ""}</span></div>` +
    `<div class="pe-day-route">` +
    `<b>${escapeHtml(area)}</b>` +
    `<span>${icon("buildingOffice2")} ${escapeHtml(stay)}</span>` +
    `</div>` +
    `<div class="pe-day-tools">` +
    `<button class="pe-icon-btn" type="button" data-act="sort-time" data-day="${index}" title="時刻で並べ替え">${icon("clock")}</button>` +
    `<button class="pe-icon-btn" type="button" data-act="copy-prev" data-day="${index}" title="前日をコピー"${index === 0 ? " disabled" : ""}>${icon("documentDuplicate")}</button>` +
    `</div>` +
    `</div>`
  );
}

/**
 * 一部メンバーだけの予定に出す名前バッジ。全員（空）は通常なにも出さないが、
 * 班タブで絞っているときだけ「全員」と明示する（どの班にも表示される予定だと分かるように）。
 */
function rowMembersBadge(item: Item): string {
  if (!item.members.length) {
    return renderingWithTrack ? `<span class="pe-row-members is-all">全員</span>` : "";
  }
  const names = item.members.map((id) => db.nameOf(id)).filter(Boolean);
  return `<span class="pe-row-members" title="この予定の対象メンバー">${escapeHtml(names.join("・") || "一部メンバー")}</span>`;
}

function rowSummary(item: Item): string {
  const k = KINDS[item.kind];
  if (item.kind === "move") {
    const from = item.from || "出発";
    const to = item.to || "到着";
    const means = item.transport.trim();
    const meansIcon = means
      ? `<span class="mid" title="${escapeHtml(means)}" aria-label="${escapeHtml(means)}">` +
        icon(TRANSPORT_ICONS[means] || "arrowsRightLeft") +
        "</span>"
      : "";
    const dur = item.duration.trim() ? `<span class="dur">${escapeHtml(item.duration)}</span>` : "";
    return (
      `<span class="pe-chip" data-kind="move">${icon(k.icon)}${k.label}</span>` +
      `<span class="pe-row-time">${escapeHtml(item.time)}</span>` +
      `<span class="pe-seg"><span class="ep">${escapeHtml(from)}</span>` +
      `<span class="arr">${icon("arrowLongRight")}</span>` +
      meansIcon +
      dur +
      `<span class="arr">${icon("arrowLongRight")}</span>` +
      `<span class="ep">${escapeHtml(to)}</span></span>` +
      rowMembersBadge(item) +
      `<span class="pe-row-caret">${icon("chevronDown")}</span>`
    );
  }
  const title = item.title || item.place;
  const titleCls = title ? "" : " is-empty";
  const titleText = title || `${itemNameLabel(item.kind)}未入力`;
  const sub = item.place && item.title ? ` <small>${escapeHtml(item.place)}</small>` : "";
  return (
    `<span class="pe-chip" data-kind="${item.kind}">${icon(k.icon)}${k.label}</span>` +
    `<span class="pe-row-time">${escapeHtml(item.time)}</span>` +
    `<span class="pe-row-title${titleCls}">${escapeHtml(titleText)}${sub}</span>` +
    rowMembersBadge(item) +
    `<span class="pe-row-caret">${icon("chevronDown")}</span>`
  );
}

function itemNameLabel(kind: ItemKind): string {
  if (kind === "stay") return "ホテル名";
  if (kind === "sight") return "観光地名";
  if (kind === "food") return "店名・食事名";
  if (kind === "todo") return "予定名";
  if (kind === "form") return "手続き名";
  return "タイトル";
}

function itemNamePlaceholder(kind: ItemKind): string {
  if (kind === "stay") return "例: 八戸グランドホテル";
  if (kind === "sight") return "例: エッフェル塔";
  if (kind === "food") return "例: 〇〇レストラン / 海鮮丼";
  if (kind === "todo") return "例: 予約確認";
  if (kind === "form") return "例: 入国書類の提出";
  return "例: 中尊寺を拝観";
}

function rowControls(item: Item): string {
  return (
    `<span class="pe-grip" data-grip aria-label="ドラッグで並べ替え">${icon("bars3")}</span>` +
    rowSummary(item) +
    `<button class="pe-row-remove" type="button" data-act="remove" data-item="${item.id}" title="削除" aria-label="削除">${icon("trash")}</button>`
  );
}

function fieldInput(item: Item, key: ItemStrKey, ph: string): string {
  const maxLength = key === "note" ? 5000 : key === "duration" || key === "transport" ? 60 : key === "time" ? 32 : 200;
  return `<input data-field="${key}" data-item="${item.id}" maxlength="${maxLength}" value="${escapeHtml(item[key])}" placeholder="${escapeHtml(ph)}">`;
}

function placeBlock(item: Item, target: GeoTarget, label: string, ph: string): string {
  const key: ItemStrKey = target === "from" ? "from" : target === "to" ? "to" : "place";
  return (
    `<div class="pe-field pe-place-field c2" data-place-field="${item.id}-${target}"><span>${label}</span>` +
    `<div class="pe-place-input-wrap">` +
    fieldInput(item, key, ph) +
    `<span class="pe-place-loading" aria-hidden="true"></span>` +
    `</div>` +
    `<div class="pe-place-tools">` +
    `<button class="pe-mini" type="button" data-act="geo" data-item="${item.id}" data-target="${target}">${icon("magnifyingGlass")}<span>検索</span></button>` +
    `<button class="pe-mini" type="button" data-act="geo-arm" data-item="${item.id}" data-target="${target}">${icon("mapPin")}<span>地図で指定</span></button>` +
    `</div>` +
    `<div class="pe-geo-status" data-geo="${item.id}-${target}"></div>` +
    `<div class="pe-geo-results" data-geores="${item.id}-${target}" hidden></div>` +
    `</div>`
  );
}

/**
 * 予定ごとの対象メンバー選択チップ。空選択＝その日の在籍メンバー全員（既定）。
 * 途中合流の個人移動（例: たかしだけ東京→大阪）を共有行程の中に置くための例外指定。
 */
function memberPickerBlock(item: Item): string {
  const ids = model.memberIds.filter((id) => id && db.nameOf(id));
  if (ids.length < 2) return "";
  const all = !item.members.length;
  return (
    `<div class="pe-field c4 pe-item-members"><span>対象メンバー <em>任意</em></span>` +
    `<div class="pe-item-members-chips">` +
    `<button class="pe-mchip${all ? " is-on" : ""}" type="button" data-act="members-all" data-item="${item.id}">全員</button>` +
    ids.map((id) => {
      const on = item.members.includes(id);
      return `<button class="pe-mchip${on ? " is-on" : ""}" type="button" data-act="member-toggle" data-item="${item.id}" data-member="${escapeHtml(id)}">${escapeHtml(db.nameOf(id))}</button>`;
    }).join("") +
    `</div>` +
    `<p class="pe-item-members-note">一部の人だけの予定（途中合流の移動など）はここで選ぶ。未選択＝全員。</p>` +
    `</div>`
  );
}

function editForm(item: Item): string {
  const g = `<div class="pe-edit-grid">`;
  const end = `</div><div class="pe-edit-actions"><button class="pe-mini" type="button" data-act="close">${icon("check")}<span>完了</span></button></div>`;
  if (item.kind === "move") {
    return (
      g +
      placeBlock(item, "from", "出発地", "例: 盛岡駅") +
      placeBlock(item, "to", "到着地", "例: 八戸") +
      `<label class="pe-field"><span>手段</span><select data-field="transport" data-item="${item.id}">` +
        `<option value="">—</option>` +
        TRANSPORTS.map((t) => `<option value="${t}"${item.transport === t ? " selected" : ""}>${t}</option>`).join("") +
        `</select></label>` +
      `<label class="pe-field"><span>所要時間</span>${fieldInput(item, "duration", "例: 1h40m")}</label>` +
      `<label class="pe-field"><span>時刻 <em>任意</em></span>${fieldInput(item, "time", "例: 13:00 発")}</label>` +
      `<label class="pe-field c4"><span>メモ <em>任意</em></span>${fieldInput(item, "note", "予約番号など")}</label>` +
      memberPickerBlock(item) +
      end
    );
  }
  const timeLabel = item.kind === "food" ? "時刻 / 朝昼夜" : item.kind === "stay" ? "チェックイン" : "時刻";
  const nameLabel = itemNameLabel(item.kind);
  const namePlaceholder = itemNamePlaceholder(item.kind);
  const nightsSelect = item.kind === "stay"
    ? `<label class="pe-field"><span>泊数</span><select data-field="nights" data-item="${item.id}">` +
      stayNightOptions(item) +
      `</select></label>`
    : "";
  return (
    g +
    `<label class="pe-field c2"><span>${nameLabel}</span>${fieldInput(item, "title", namePlaceholder)}</label>` +
    `<label class="pe-field"><span>${timeLabel} <em>任意</em></span>${fieldInput(item, "time", item.kind === "food" ? "例: 夜" : "例: 10:00")}</label>` +
    nightsSelect +
    placeBlock(item, "place", "場所", "例: 平泉 / 中尊寺") +
    `<label class="pe-field c4"><span>メモ <em>任意</em></span>${fieldInput(item, "note", "当日見たい情報だけ")}</label>` +
    memberPickerBlock(item) +
    end
  );
}

function timelineNode(item: Item): string {
  const open = state.openItemId === item.id ? " is-open" : "";
  return (
    `<div class="pe-node${open}" data-kind="${item.kind}" data-node="${item.id}">` +
    `<span class="pe-dot"></span>` +
    `<div class="pe-row" role="button" tabindex="0" data-act="toggle" data-item="${item.id}">` +
    rowControls(item) +
    `</div>` +
    `<div class="pe-edit">${editForm(item)}</div>` +
    `</div>`
  );
}

function stayBand(index: number): string {
  const cover = stayCovering(index);
  if (!cover) return "";
  // 連泊の継続日（編集はチェックイン日で行う）
  if (cover.startIndex !== index) {
    return (
      `<div class="pe-stay pe-stay-cont">` +
      `<span class="pe-stay-ic">${icon("buildingOffice2")}</span>` +
      `<div class="pe-stay-main"><b>${escapeHtml(cover.stay.title || "連泊")}</b><span>同じ宿に滞在中（連泊）</span></div>` +
      `</div>`
    );
  }
  const stay = cover.stay;
  const open = state.openItemId === stay.id ? " is-open" : "";
  const title = stay.title || "ホテル名未入力";
  const titleCls = stay.title ? "" : " is-empty";
  const meta = [stay.time ? `IN ${stay.time}` : "", stay.nights > 1 ? `${stay.nights}泊` : "", stay.place].filter(Boolean).join(" ・ ");
  return (
    `<div class="pe-node${open}" data-kind="stay" data-node="${stay.id}">` +
    `<div class="pe-stay">` +
    `<span class="pe-stay-ic">${icon("buildingOffice2")}</span>` +
    `<button class="pe-stay-main" type="button" data-act="toggle" data-item="${stay.id}" style="border:0;background:none;text-align:left;cursor:pointer;padding:0;">` +
    `<b class="${titleCls}">${escapeHtml(title)}</b><span>${escapeHtml(meta || "この日の宿泊先")}</span>` +
    `</button>` +
    `<button class="pe-icon-btn danger" type="button" data-act="remove" data-item="${stay.id}" data-day="${index}" title="削除">${icon("trash")}</button>` +
    `</div>` +
    `<div class="pe-edit">${editForm(stay)}</div>` +
    `</div>`
  );
}

// ---- 参加者で行程が分かれる日の班タブ ------------------------------------
// ダッシュボードの表示と同じ day-tracks ロジックで班を割り、編集もタブで切り替える。
// 全員の予定（members 空か全員入り）はどの班のタブにも表示され、どちらからでも編集できる。

/** 日付 → 選択中の班キー。再描画をまたいで保持する。 */
export const editTrackChoice = new Map<string, string>();
/** 班タブで絞った描画中か（rowMembersBadge が「全員」チップを出す判断に使う）。 */
let renderingWithTrack = false;

/** その日に在籍しているメンバー（参加期間 memberDates を反映）。 */
function presentIdsOnDate(date: string): string[] {
  const ids = model.memberIds.filter((id) => id && db.nameOf(id));
  return presentMemberIds(
    ids.map((id) => ({
      user_id: id,
      from_date: model.memberDates[id]?.from ?? null,
      to_date: model.memberDates[id]?.to ?? null,
    })),
    date,
  );
}

function dayTracksOf(day: Day): DayTrack[] {
  return dayTracks(day.items.map((item) => item.members), presentIdsOnDate(day.date));
}

export function selectedEditTrack(day: Day): DayTrack | null {
  return pickTrack(dayTracksOf(day), editTrackChoice.get(day.date), currentAccount()?.id || "");
}

/** 班タブの表示名（本人は「あなた」、4人以上は他N人）。 */
function editTrackLabel(track: DayTrack): string {
  const you = currentAccount()?.id || "";
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

function dayTrackTabsHtml(day: Day, index: number): string {
  const tracks = dayTracksOf(day);
  if (!tracks.length) return "";
  const selected = selectedEditTrack(day);
  return (
    `<div class="pe-track-tabs" role="tablist" aria-label="班ごとの行程">` +
    tracks.map((track) =>
      `<button class="pe-track-tab" type="button" role="tab" aria-selected="${track.key === selected?.key}"` +
      ` data-act="track" data-day="${index}" data-track="${escapeHtml(track.key)}">` +
      `${icon("users")}<span>${escapeHtml(editTrackLabel(track))}</span></button>`,
    ).join("") +
    `</div>` +
    `<p class="pe-track-note">「全員」の予定はどの班にも表示されます。ここで追加した予定は選択中の班のものになります。</p>`
  );
}

function quickAdd(_day: Day, index: number): string {
  const btn = (kind: ItemKind): string =>
    `<button class="pe-q" type="button" data-act="add" data-kind="${kind}" data-day="${index}">${icon(KINDS[kind].icon)}${KINDS[kind].label}を追加</button>`;
  const stayBtn = stayCovering(index)
    ? ""
    : `<button class="pe-q" type="button" data-act="add" data-kind="stay" data-day="${index}">${icon("buildingOffice2")}宿泊を設定</button>`;
  return (
    `<div class="pe-quick">` +
    btn("sight") + btn("food") + btn("move") + stayBtn + btn("todo") + btn("form") +
    `</div>`
  );
}

function renderDayStrip(): void {
  const nights = model.days.reduce((n, d) => n + (d.stay ? Math.max(1, d.stay.nights) : 0), 0);
  const cities = model.cities.length;
  tripSummaryEl.textContent = model.days.length
    ? ` ・ ${model.days.length}日間${nights ? ` ・ ${nights}泊` : ""}${cities ? ` ・ ${cities}都市` : ""}`
    : "";
  if (model.days.length < 2) { dayStripEl.innerHTML = ""; return; }
  dayStripEl.innerHTML = model.days
    .map((day, i) => {
      const d = parseISO(day.date);
      return `<button class="pe-daychip" type="button" data-jump="${i}"><b>Day ${i + 1}</b><span>${d ? `${d.getMonth() + 1}/${d.getDate()}` : ""}</span></button>`;
    })
    .join("");
}

export function renderDays(): void {
  updateSteps();
  updateCalsync();
  renderDayStrip();
  dayCountEl.textContent = model.days.length ? `全${model.days.length}日` : "";
  if (!model.days.length) {
    daysEl.innerHTML =
      `<div class="pe-empty-cta"><b>期間を選択してください</b>` +
      `<span>旅行期間を設定すると、日ごとの予定欄が表示されます。</span></div>`;
    return;
  }
  daysEl.innerHTML = model.days
    .map((day, index) => {
      // 班タブで絞っているときは、全員の予定＋選択中の班の予定だけを出す
      const track = selectedEditTrack(day);
      const everyone = track ? everyoneIds(day.items.map((it) => it.members), presentIdsOnDate(day.date)) : [];
      const visible = track ? day.items.filter((it) => isItemInTrack(it.members, track, everyone)) : day.items;
      renderingWithTrack = Boolean(track);
      const items = visible.map(timelineNode).join("");
      renderingWithTrack = false;
      const empty = visible.length ? "" : `<p class="pe-day-empty">予定はまだありません。下のボタンから追加できます。</p>`;
      // 前夜の宿を朝に出発するときだけ「前泊から出発」を出す（連泊中は出さない）
      const coverPrev = index > 0 ? stayCovering(index - 1) : null;
      const coverToday = stayCovering(index);
      const leftHotel = coverPrev && (!coverToday || coverToday.stay.id !== coverPrev.stay.id);
      const startBanner = leftHotel && coverPrev.stay.title
        ? `<div class="pe-start"><span class="pe-start-ic">${icon("buildingOffice2")}</span>` +
          `<div class="pe-start-main"><b>前日の宿泊先</b><br><span>${escapeHtml(coverPrev.stay.title)}</span></div></div>`
        : "";
      // 都市名は各日の見出し（.pe-day-route）に出ているので、
      // 以前ここにあった都市バンドは二重表示になるため外した。
      return (
        `<article class="pe-day" data-day="${index}">` +
        dayHeader(day, index) +
        `<div class="pe-day-body">` +
        startBanner +
        dayTrackTabsHtml(day, index) +
        `<div class="pe-timeline">${items}</div>` +
        empty +
        stayBand(index) +
        quickAdd(day, index) +
        `</div>` +
        `</article>`
      );
    })
    .join("");
  initSortables();
}

// ドラッグ並べ替え（日内＋日跨ぎ）。SortableJS。
let sortables: Sortable[] = [];
function initSortables(): void {
  sortables.forEach((s) => s.destroy());
  sortables = [];
  daysEl.querySelectorAll<HTMLElement>(".pe-timeline").forEach((tl) => {
    sortables.push(
      Sortable.create(tl, {
        group: "pe-items",
        handle: ".pe-grip",
        draggable: ".pe-node",
        animation: 150,
        ghostClass: "pe-drag-ghost",
        chosenClass: "pe-drag-chosen",
        onEnd: () => {
          syncTimelineOrder();
          state.openItemId = null;
          markDirty();
          window.setTimeout(() => { renderDays(); refreshMap(false); }, 0);
        },
      }),
    );
  });
}

// DOM の並びからモデルの items を再構築（日跨ぎ移動も反映）
function syncTimelineOrder(): void {
  const all = new Map<number, Item>();
  model.days.forEach((d) => d.items.forEach((it) => all.set(it.id, it)));
  // 班タブで非表示の予定は DOM に存在しない。消さずに元の位置へ差し戻す。
  const domIds = new Map<number, number[]>();
  const seen = new Set<number>();
  daysEl.querySelectorAll<HTMLElement>("article[data-day]").forEach((article) => {
    const di = Number(article.dataset.day);
    const ids = Array.from(article.querySelectorAll<HTMLElement>(".pe-timeline > .pe-node")).map((n) => Number(n.dataset.node));
    domIds.set(di, ids);
    ids.forEach((id) => seen.add(id));
  });
  model.days.forEach((day, di) => {
    if (!domIds.has(di)) return;
    const ordered = (domIds.get(di) || []).map((id) => all.get(id)).filter((x): x is Item => Boolean(x));
    const hidden = day.items.map((item, index) => ({ item, index })).filter(({ item }) => !seen.has(item.id));
    for (const { item, index } of hidden) ordered.splice(Math.min(index, ordered.length), 0, item);
    day.items = ordered;
  });
}

// 入力時に行サマリ・日ヘッダだけを更新（全再描画せずフォーカス維持）
export function refreshNode(item: Item): void {
  const node = daysEl.querySelector<HTMLElement>(`[data-node="${item.id}"]`);
  if (!node) return;
  if (item.kind === "stay") {
    const main = node.querySelector<HTMLElement>(".pe-stay-main");
    if (main) {
      const title = item.title || "ホテル名未入力";
      const meta = [item.time ? `IN ${item.time}` : "", item.nights > 1 ? `${item.nights}泊` : "", item.place].filter(Boolean).join(" ・ ");
      main.innerHTML = `<b class="${item.title ? "" : "is-empty"}">${escapeHtml(title)}</b><span>${escapeHtml(meta || "この日の宿泊先")}</span>`;
    }
  } else {
    const row = node.querySelector<HTMLElement>(".pe-row");
    if (row) row.innerHTML = rowControls(item);
  }
}

export function refreshDayHeader(index: number): void {
  const article = daysEl.querySelector<HTMLElement>(`article[data-day="${index}"]`);
  const day = model.days[index];
  if (!article || !day) return;
  const head = article.querySelector(".pe-day-head");
  if (head) head.outerHTML = dayHeader(day, index);
}

export function focusOpenItem(): void {
  if (state.openItemId == null) return;
  const node = daysEl.querySelector<HTMLElement>(`[data-node="${state.openItemId}"]`);
  node?.querySelector<HTMLInputElement | HTMLSelectElement>(".pe-edit input, .pe-edit select")?.focus();
}
