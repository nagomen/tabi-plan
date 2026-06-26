// 旅行計画エディタページ。docs/plan-editor.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// 基本情報＋日ごとの行程アイテム（追加/削除/並べ替え/自動座標補完）を編集し、
// プランレジストリ（localStorage）へ LocalPlanData として保存する。

import * as TripPlans from "../shared/plans-store";
import type { LocalPlanData } from "../shared/plans-store";
import type { ItineraryItem, ItemType } from "../shared/types";
import { escapeHtml } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";

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
const dayCountEl = qs<HTMLElement>(root, "[data-day-count]");
const savebarNoteEl = qs<HTMLElement>(root, "[data-savebar-note]");
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

// ?plan= が無ければ新規。safeSlug は空文字に "trip" を充てるので、
// 新規判定は生のパラメータで行い、slug は保存時に旅行名から採番する。
const params = new URLSearchParams(location.search);
const planParam = (params.get("plan") || "").trim();
const isNew = !planParam;
let slug = isNew ? "" : TripPlans.safeSlug(planParam);

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

function hasCoords(item: EditorItem): boolean {
  return (
    String(item.lat).trim() !== "" &&
    String(item.lng).trim() !== "" &&
    !isNaN(Number(item.lat)) &&
    !isNaN(Number(item.lng))
  );
}

// ---- ジオコーディング（OpenStreetMap Nominatim・無料/キー不要）-----------
// 規約順守のため最短 1.1 秒間隔・件数制限つき。地名から緯度経度を取得する。
interface GeoResult {
  label: string;
  lat: number;
  lng: number;
}

let lastGeoAt = 0;

async function geocodeSearch(query: string): Promise<GeoResult[]> {
  const wait = 1100 - (Date.now() - lastGeoAt);
  if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
  lastGeoAt = Date.now();
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ja&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("検索に失敗しました (" + res.status + ")");
  const data = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
  return data
    .map((d) => ({ label: String(d.display_name || ""), lat: Number(d.lat), lng: Number(d.lon) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

function markDirty(): void {
  dirty = true;
  statusEl.textContent = "未保存";
  statusEl.className = "is-dirty";
  savebarNoteEl.textContent = "未保存の変更があります。最後に保存してください。";
}

const EMPTY_SUMMARY = "（タイトル未入力）";

function summaryText(item: EditorItem): string {
  const bits = [item.time, typeLabelOf[item.type] || "", item.title || item.place].filter(Boolean);
  return bits.join(" ・ ") || EMPTY_SUMMARY;
}

function cloneTemplate(tpl: HTMLTemplateElement): HTMLElement {
  const first = tpl.content.firstElementChild;
  if (!first) throw new Error("テンプレートの内容が空です");
  return first.cloneNode(true) as HTMLElement;
}

function renderDays(): void {
  daysEl.innerHTML = "";
  dayCountEl.textContent = model.days.length ? `全${model.days.length}日` : "";
  if (!model.days.length) {
    daysEl.innerHTML =
      '<div class="pe-empty-cta"><b>まずは期間を選びましょう</b>' +
      '<span>上の「開始日」と「終了日」を入れると、日ごとの予定欄がここに出ます。</span></div>';
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

  const setSummary = (): void => {
    const text = summaryText(item);
    summary.textContent = text;
    summary.classList.toggle("is-empty", text === EMPTY_SUMMARY);
  };
  setSummary();

  // 地図登録（場所名 → 緯度経度）
  const placeInput = qs<HTMLInputElement>(node, '[data-i="place"]');
  const latInput = qs<HTMLInputElement>(node, '[data-i="lat"]');
  const lngInput = qs<HTMLInputElement>(node, '[data-i="lng"]');
  const geoBtn = qs<HTMLButtonElement>(node, "[data-geocode]");
  const geoStatus = qs<HTMLElement>(node, "[data-geo-status]");
  const geoResults = qs<HTMLElement>(node, "[data-geo-results]");

  const setGeoStatus = (text: string, kind?: "ok" | "warn"): void => {
    geoStatus.textContent = text;
    geoStatus.className = "pe-geo-status" + (kind ? " is-" + kind : "");
  };
  const refreshGeoStatus = (): void => {
    if (hasCoords(item)) setGeoStatus("✓ 地図に登録済み", "ok");
    else setGeoStatus("未登録：場所名を入れて「地図を検索」で登録できます");
  };
  refreshGeoStatus();

  const applyResult = (result: GeoResult): void => {
    item.lat = String(result.lat);
    item.lng = String(result.lng);
    latInput.value = item.lat;
    lngInput.value = item.lng;
    geoResults.hidden = true;
    geoResults.innerHTML = "";
    setGeoStatus("✓ 地図に登録しました", "ok");
    markDirty();
  };

  geoBtn.addEventListener("click", () => {
    const query = (item.mapQuery || item.place || placeInput.value).trim();
    if (!query) {
      setGeoStatus("場所名を入力してください", "warn");
      return;
    }
    geoBtn.disabled = true;
    geoResults.hidden = true;
    geoResults.innerHTML = "";
    setGeoStatus("検索中…");
    void (async (): Promise<void> => {
      try {
        const results = await geocodeSearch(query);
        if (!results.length) {
          setGeoStatus("見つかりませんでした。表記を変えて再検索してください。", "warn");
          return;
        }
        if (results.length === 1) {
          applyResult(results[0]);
          return;
        }
        geoResults.innerHTML = results
          .map(
            (result, index) =>
              `<button type="button" class="pe-geo-result" data-geo-pick="${index}"><b>候補 ${index + 1}</b><small>${escapeHtml(result.label)}</small></button>`,
          )
          .join("");
        geoResults.hidden = false;
        setGeoStatus("候補から選んでください");
        geoResults.querySelectorAll<HTMLButtonElement>("[data-geo-pick]").forEach((pick) => {
          pick.addEventListener("click", () => {
            const result = results[Number(pick.dataset.geoPick)];
            if (result) applyResult(result);
          });
        });
      } catch (error) {
        setGeoStatus(error instanceof Error ? error.message : "検索に失敗しました", "warn");
      } finally {
        geoBtn.disabled = false;
      }
    })();
  });

  // 種別チップ（ダッシュボードのチップ色と一致）
  const chipsWrap = qs<HTMLElement>(node, "[data-type-chips]");
  chipsWrap.innerHTML = TYPES.map(
    (t) => `<button type="button" class="pe-type-chip" data-type="${t.value}">${t.label}</button>`,
  ).join("");
  const syncChips = (): void => {
    chipsWrap.querySelectorAll<HTMLButtonElement>(".pe-type-chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.type === item.type);
    });
  };
  syncChips();
  chipsWrap.querySelectorAll<HTMLButtonElement>(".pe-type-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      item.type = normalizeType(chip.dataset.type);
      syncChips();
      tone.className = "pe-item-tone " + item.type;
      setSummary();
      markDirty();
    });
  });

  // テキスト/数値入力（種別以外）のバインド
  node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i]").forEach((input) => {
    const key = input.dataset.i as EditorItemKey | undefined;
    if (!key || key === "type") return;
    input.value = item[key] == null ? "" : String(item[key]);
    input.addEventListener("input", () => {
      item[key] = input.value;
      if (key === "place" || key === "mapQuery") {
        autoCoords(item);
        latInput.value = item.lat;
        lngInput.value = item.lng;
      }
      if (key === "place" || key === "mapQuery" || key === "lat" || key === "lng") refreshGeoStatus();
      setSummary();
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
  openLink.hidden = false;
  savebarNoteEl.textContent = "保存しました。右上の「この計画を表示」で確認できます。";
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
if (slug) {
  // 既存プランは保存済みなので「この計画を表示」リンクを出す
  openLink.href = "index.html?plan=" + encodeURIComponent(slug);
  openLink.hidden = false;
}
syncBasicInputs();
rebuildDays();
renderDays();
statusEl.textContent = isNew ? "下書き（未保存）" : editable ? "読み込み完了" : statusEl.textContent;

registerServiceWorker();
