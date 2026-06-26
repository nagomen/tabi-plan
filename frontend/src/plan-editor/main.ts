// 旅行計画エディタページ。docs/plan-editor.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// 基本情報＋日ごとの行程アイテム（追加/削除/並べ替え/自動座標補完）を編集し、
// プランレジストリ（localStorage）へ LocalPlanData として保存する。

import * as TripPlans from "../shared/plans-store";
import type { LocalPlanData } from "../shared/plans-store";
import type { ItineraryItem, ItemType } from "../shared/types";

// ---- 編集中モデル（入力バインド用に lat/lng は文字列で保持）-----------------

/** data-i で双方向バインドする編集アイテムのキー */
type EditorItemKey = "time" | "type" | "title" | "place" | "mapQuery" | "note" | "lat" | "lng";

interface EditorItem {
  id: number;
  time: string;
  type: ItemType;
  title: string;
  place: string;
  mapQuery: string;
  note: string;
  /** 入力欄バインド用に文字列で保持（保存時に number へ変換） */
  lat: string;
  lng: string;
}

interface EditorDay {
  date: string;
  area: string;
  items: EditorItem[];
}

interface EditorModel {
  slug: string;
  title: string;
  members: string;
  note: string;
  startDate: string;
  endDate: string;
  days: EditorDay[];
}

/** newItem に渡す種データ（既存行 ItineraryItem か部分指定） */
type ItemSeed = Partial<Pick<EditorItem, "time" | "title" | "place" | "mapQuery" | "note">> & {
  type?: ItemType | string;
  lat?: number | string;
  lng?: number | string;
};

// ---- DOM ヘルパー --------------------------------------------------------

/** root 配下から要素を取得し、無ければ throw する型付き qs */
function qs<E extends Element = Element>(parent: ParentNode, selector: string): E {
  const el = parent.querySelector<E>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

const root = document.getElementById("editor");
if (!root) throw new Error("エディタのルート要素が見つかりません: #editor");

const daysEl = qs<HTMLElement>(root, "[data-days]");
const statusEl = qs<HTMLElement>(root, "[data-status]");
const titleEcho = qs<HTMLElement>(root, "[data-title-echo]");
const openLink = qs<HTMLAnchorElement>(root, "[data-open]");
const warnEl = qs<HTMLElement>(root, "[data-daterange-warn]");
const dayTpl = qs<HTMLTemplateElement>(root, "[data-day-template]");
const itemTpl = qs<HTMLTemplateElement>(root, "[data-item-template]");

const TYPES = TripPlans.TYPES;
const typeLabelOf: Record<string, string> = {};
TYPES.forEach((t) => {
  typeLabelOf[t.value] = t.label;
});

/** 種データ type をエディタが扱う ItemType に丸める */
function normalizeType(value: ItemType | string | undefined): ItemType {
  return TYPES.some((t) => t.value === value) ? (value as ItemType) : "sight";
}

let itemSeq = 1;
function newItem(seed?: ItemSeed): EditorItem {
  const s = seed || {};
  return {
    id: itemSeq++,
    time: s.time || "",
    type: normalizeType(s.type),
    title: s.title || "",
    place: s.place || "",
    mapQuery: s.mapQuery || "",
    note: s.note || "",
    lat: s.lat == null ? "" : String(s.lat),
    lng: s.lng == null ? "" : String(s.lng),
  };
}

const params = new URLSearchParams(location.search);
let slug = TripPlans.safeSlug(params.get("plan") || "");
const isNew = !slug;

const model: EditorModel = {
  slug: slug,
  title: "",
  members: "",
  note: "",
  startDate: "",
  endDate: "",
  days: [],
};
let dirty = false;

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
function toISO(d: Date): string {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function parseISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function shortJP(iso: string): string {
  const d = parseISO(iso);
  if (!d) return iso || "";
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return d.getMonth() + 1 + "/" + d.getDate() + "(" + w + ")";
}
function datesString(): string {
  const a = parseISO(model.startDate);
  const b = parseISO(model.endDate);
  if (!a || !b) return "";
  const f = (d: Date): string => d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  return f(a) + " - " + f(b);
}

// 日付範囲から days を再生成（既存の area/items は日付で引き継ぐ）
function rebuildDays(): void {
  const a = parseISO(model.startDate);
  const b = parseISO(model.endDate);
  warnEl.hidden = !(model.startDate && model.endDate && (!a || !b || b < a));
  if (!a || !b || b < a) {
    // 日付が不正な間は既存 days を維持（消さない）
    return;
  }
  const byDate: Record<string, EditorDay> = {};
  model.days.forEach((d) => {
    byDate[d.date] = d;
  });
  const next: EditorDay[] = [];
  const cursor = new Date(a.getTime());
  let guard = 0;
  while (cursor <= b && guard < 400) {
    const iso = toISO(cursor);
    next.push(byDate[iso] || { date: iso, area: "", items: [] });
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  model.days = next;
}

function autoCoords(item: EditorItem): void {
  const hasLat = String(item.lat).trim() !== "" && !isNaN(Number(item.lat));
  const hasLng = String(item.lng).trim() !== "" && !isNaN(Number(item.lng));
  if (hasLat && hasLng) return;
  const hit = TripPlans.coordsFor(item.place) || TripPlans.coordsFor(item.mapQuery);
  if (hit) {
    if (!hasLat) item.lat = String(hit.lat);
    if (!hasLng) item.lng = String(hit.lng);
  }
}

function markDirty(): void {
  dirty = true;
  statusEl.textContent = "未保存";
  statusEl.className = "is-dirty";
}

function summaryText(item: EditorItem): string {
  const bits = [item.time, typeLabelOf[item.type] || "", item.title || item.place].filter(Boolean);
  return bits.join(" ・ ") || "（内容未入力）";
}

function fillTypeSelect(select: HTMLSelectElement, value: string): void {
  select.innerHTML = TYPES.map((t) => {
    return '<option value="' + t.value + '"' + (t.value === value ? " selected" : "") + ">" + t.label + "</option>";
  }).join("");
}

function cloneTemplate(tpl: HTMLTemplateElement): HTMLElement {
  const first = tpl.content.firstElementChild;
  if (!first) throw new Error("テンプレートの内容が空です");
  return first.cloneNode(true) as HTMLElement;
}

function renderDays(): void {
  daysEl.innerHTML = "";
  if (!model.days.length) {
    daysEl.innerHTML =
      '<div class="pe-day-empty" style="padding:0 0 6px;">開始日と終了日を入れると、日ごとの行程欄が出ます。</div>';
    return;
  }
  model.days.forEach((day, dayIndex) => {
    const node = cloneTemplate(dayTpl);
    qs<HTMLElement>(node, "[data-day-name]").textContent = "Day " + (dayIndex + 1);
    qs<HTMLElement>(node, "[data-day-date]").textContent = shortJP(day.date);
    const areaInput = qs<HTMLInputElement>(node, "[data-day-area]");
    areaInput.value = day.area || "";
    areaInput.addEventListener("input", () => {
      day.area = areaInput.value;
      markDirty();
      updateSummaries();
    });

    const itemsEl = qs<HTMLElement>(node, "[data-items]");
    if (!day.items.length) {
      const empty = document.createElement("div");
      empty.className = "pe-day-empty";
      empty.textContent = "この日の予定はまだありません。";
      itemsEl.appendChild(empty);
    }
    day.items.forEach((item, itemIndex) => {
      itemsEl.appendChild(renderItem(day, item, itemIndex));
    });

    qs<HTMLButtonElement>(node, "[data-add]").addEventListener("click", () => {
      day.items.push(newItem({ type: "sight" }));
      markDirty();
      renderDays();
    });
    daysEl.appendChild(node);
  });
}

function renderItem(day: EditorDay, item: EditorItem, itemIndex: number): HTMLElement {
  const node = cloneTemplate(itemTpl);
  const tone = qs<HTMLElement>(node, "[data-tone]");
  const summary = qs<HTMLElement>(node, "[data-summary]");
  tone.className = "pe-item-tone " + item.type;
  summary.textContent = summaryText(item);

  node.querySelectorAll<HTMLElement>("[data-i]").forEach((input) => {
    const key = input.dataset.i as EditorItemKey | undefined;
    if (!key) return;
    if (input.tagName === "SELECT") {
      fillTypeSelect(input as HTMLSelectElement, item.type);
    } else {
      (input as HTMLInputElement | HTMLTextAreaElement).value = item[key] == null ? "" : String(item[key]);
    }
    const ev = input.tagName === "SELECT" ? "change" : "input";
    input.addEventListener(ev, () => {
      const value = (input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
      if (key === "type") {
        item.type = normalizeType(value);
        tone.className = "pe-item-tone " + item.type;
      } else {
        item[key] = value;
      }
      if (key === "place" || key === "mapQuery") autoCoords(item);
      summary.textContent = summaryText(item);
      markDirty();
    });
  });

  const up = qs<HTMLButtonElement>(node, "[data-up]");
  const down = qs<HTMLButtonElement>(node, "[data-down]");
  up.disabled = itemIndex === 0;
  down.disabled = itemIndex === day.items.length - 1;
  up.addEventListener("click", () => {
    move(day, itemIndex, -1);
  });
  down.addEventListener("click", () => {
    move(day, itemIndex, 1);
  });
  qs<HTMLButtonElement>(node, "[data-remove]").addEventListener("click", () => {
    day.items.splice(itemIndex, 1);
    markDirty();
    renderDays();
  });
  return node;
}

function move(day: EditorDay, index: number, delta: number): void {
  const to = index + delta;
  if (to < 0 || to >= day.items.length) return;
  const tmp = day.items[index];
  day.items[index] = day.items[to];
  day.items[to] = tmp;
  markDirty();
  renderDays();
}

function updateSummaries(): void {
  // area のみ変更時に再描画は不要だが、将来用のフック
}

// 基本情報入力のバインド
root.querySelectorAll<HTMLInputElement>("[data-f]").forEach((input) => {
  input.addEventListener("input", () => {
    const key = input.dataset.f;
    if (!key) return;
    if (key === "title" || key === "members" || key === "note" || key === "startDate" || key === "endDate") {
      model[key] = input.value;
    }
    if (key === "title") titleEcho.textContent = input.value || "新しい計画";
    if (key === "startDate" || key === "endDate") {
      rebuildDays();
      renderDays();
    }
    markDirty();
  });
});

function syncBasicInputs(): void {
  qs<HTMLInputElement>(root!, '[data-f="title"]').value = model.title || "";
  qs<HTMLInputElement>(root!, '[data-f="members"]').value = model.members || "";
  qs<HTMLInputElement>(root!, '[data-f="note"]').value = model.note || "";
  qs<HTMLInputElement>(root!, '[data-f="startDate"]').value = model.startDate || "";
  qs<HTMLInputElement>(root!, '[data-f="endDate"]').value = model.endDate || "";
  titleEcho.textContent = model.title || "新しい計画";
}

// 既存データの読み込み（itinerary -> days）
function loadExisting(): boolean {
  const meta = slug ? TripPlans.get(slug) : null;
  if (meta && meta.source && meta.source !== "local") {
    statusEl.textContent = "この計画は外部連携のため、ここでは編集できません";
    statusEl.className = "is-dirty";
    root!
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
        "input,select,textarea,button[data-add],button[data-save]",
      )
      .forEach((el) => {
        if (!el.closest(".pe-head-actions") || el.dataset.save !== undefined) el.disabled = true;
      });
    return false;
  }
  const data = slug ? TripPlans.getData(slug) : null;
  if (data) {
    const trip = data.trip || ({ title: "", dates: "", members: "", note: "" });
    model.title = trip.title || "";
    model.members = trip.members || "";
    model.note = trip.note || "";
    const parts = String(trip.dates || "").split(/\s+-\s+/);
    model.startDate = normalizeToISO(parts[0]);
    model.endDate = normalizeToISO(parts[1] || parts[0]);
    const byDate: Record<string, EditorDay> = {};
    (data.itinerary || []).forEach((row) => {
      const date = normalizeToISO(row.date);
      if (!date) return;
      if (!byDate[date]) byDate[date] = { date: date, area: row.area || "", items: [] };
      if (!byDate[date].area && row.area) byDate[date].area = row.area;
      byDate[date].items.push(newItem(row));
    });
    model.days = Object.keys(byDate)
      .sort()
      .map((d) => byDate[d]);
  }
  return true;
}

function normalizeToISO(value: string | undefined): string {
  const s = String(value || "").trim();
  if (!s) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (slash) return slash[1] + "-" + pad(Number(slash[2])) + "-" + pad(Number(slash[3]));
  return "";
}

function buildData(): LocalPlanData {
  const itinerary: ItineraryItem[] = [];
  model.days.forEach((day, dayIndex) => {
    day.items.forEach((item) => {
      autoCoords(item);
      const latNum = Number(item.lat);
      const lngNum = Number(item.lng);
      itinerary.push({
        date: day.date,
        day: "Day " + (dayIndex + 1),
        area: day.area || item.place || "",
        time: item.time || "",
        type: item.type || "sight",
        typeLabel: typeLabelOf[item.type] || "予定",
        title: item.title || "",
        place: item.place || "",
        note: item.note || "",
        lat: String(item.lat).trim() !== "" && !isNaN(latNum) ? latNum : "",
        lng: String(item.lng).trim() !== "" && !isNaN(lngNum) ? lngNum : "",
        mapQuery: item.mapQuery || item.place || "",
        weather: "",
      });
    });
  });
  return {
    trip: {
      title: model.title || "無題の旅行",
      dates: datesString(),
      members: model.members || "",
      note: model.note || "",
    },
    itinerary: itinerary,
    links: [],
    checklist: [],
  };
}

function save(): void {
  if (!model.title.trim()) {
    statusEl.textContent = "旅行名を入れてください";
    statusEl.className = "is-dirty";
    qs<HTMLInputElement>(root!, '[data-f="title"]').focus();
    return;
  }
  if (!slug) {
    slug = TripPlans.uniqueSlug(model.title || "trip");
    model.slug = slug;
  }
  TripPlans.saveLocalPlan(slug, buildData());
  TripPlans.setActiveSlug(slug);
  dirty = false;
  statusEl.textContent = "保存しました";
  statusEl.className = "is-ok";
  openLink.href = "index.html?plan=" + encodeURIComponent(slug);
  // 新規URLを反映（リロードや複製時の整合のため）
  try {
    history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(slug));
  } catch {
    /* ignore */
  }
}

qs<HTMLButtonElement>(root, "[data-save]").addEventListener("click", save);

window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// 初期化
const editable = loadExisting();
if (slug) openLink.href = "index.html?plan=" + encodeURIComponent(slug);
if (editable && isNew && !model.days.length) {
  // 新規は空のまま。日付を入れると行程欄が出る。
}
syncBasicInputs();
rebuildDays();
renderDays();
statusEl.textContent = isNew ? "新規作成" : "読み込み完了";

if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
