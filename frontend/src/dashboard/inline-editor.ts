// 観覧画面の編集モード。予定カードのダイアログ、ドラッグ並べ替え、
// 編集バーの配線をまとめる。保存はすべて inline-store 経由。

import { escapeHtml } from "../shared/dom";
import { readGlobalTripConfig } from "../shared/config";
import { cityAliasesFor, geocodingAttribution, searchLocations, type GeoResult } from "../shared/geocoding";
import type { ItineraryItem, ItemType } from "../shared/types";
import { state } from "./state";
import { root } from "./dom";
import { dialogHead, dialogNode, field } from "./inline-dialog";
import { isInlineEditing, setInlineEditing, showEditBarStatus, editBarStatusEl } from "./inline-mode";
import {
  applyItemEdit, applyReorder, commit, locate, planData, setStatus, type ItemKey,
} from "./inline-store";
import { appendDay, insertDayAfter, openCities, openTripInfo, removeDay } from "./inline-trip";

const MAPBOX_TOKEN = readGlobalTripConfig().geocoding?.mapboxToken || "";

// ---- 予定カードのダイアログ ---------------------------------------------

function itemDialog(): HTMLDialogElement {
  return dialogNode("data-inline-dialog", `<form method="dialog" data-inline-item-form>
      ${dialogHead("予定を編集", "data-inline-dialog-title")}
      <input type="hidden" name="index"><input type="hidden" name="itemId">
      <input type="hidden" name="lat"><input type="hidden" name="lng">
      <div class="tl-inline-fields">
        <label><span>日付</span><input name="date" type="date"></label>
        <label><span>時刻</span><input name="time" type="time"></label>
        <label><span>種類</span><select name="type"><option value="sight">観光</option><option value="food">食事</option><option value="move">移動</option><option value="stay">宿泊</option><option value="todo">予定</option><option value="form">手続き</option></select></label>
        <label><span>都市・エリア</span><input name="area" maxlength="100"></label>
        <label class="is-wide"><span>タイトル</span><input name="title" maxlength="160" required></label>
        <label class="is-wide"><span>場所</span><input name="place" maxlength="160"></label>
        <label><span>交通手段</span><input name="transport" maxlength="60"></label>
        <label><span>所要時間</span><input name="duration" maxlength="40" placeholder="例：1時間30分"></label>
        <label><span>出発地</span><input name="origin" maxlength="160"></label>
        <label><span>到着地</span><input name="destination" maxlength="160"></label>
        <label class="is-wide"><span>メモ</span><textarea name="note" maxlength="500" rows="3"></textarea></label>
      </div>
      <div class="tl-inline-geo">
        <button type="button" data-inline-geo>地図の位置を場所から検索</button>
        <span data-inline-geo-coord></span>
      </div>
      <div class="tl-inline-geo-results" data-inline-geo-results hidden></div>
      <p data-inline-status aria-live="polite"></p>
      <div class="tl-inline-dialog-actions"><button type="button" class="is-delete" data-inline-delete>削除</button><span></span><button type="button" data-dialog-close>キャンセル</button><button type="submit" class="is-primary">保存</button></div>
    </form>`, (node) => {
    node.querySelector<HTMLFormElement>("[data-inline-item-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveItem(node);
    });
    node.querySelector<HTMLButtonElement>("[data-inline-delete]")?.addEventListener("click", () => void deleteItem(node));
    node.querySelector<HTMLButtonElement>("[data-inline-geo]")?.addEventListener("click", () => void searchPlace(node));
    node.querySelector<HTMLElement>("[data-inline-geo-results]")?.addEventListener("click", (event) => {
      const pick = (event.target as HTMLElement).closest<HTMLElement>("[data-geo-lat]");
      if (pick) applyGeoPick(node, Number(pick.dataset.geoLat), Number(pick.dataset.geoLng));
    });
  });
}

function showCoord(node: HTMLDialogElement): void {
  const lat = Number(field(node, "lat").value);
  const lng = Number(field(node, "lng").value);
  const label = node.querySelector<HTMLElement>("[data-inline-geo-coord]");
  if (!label) return;
  label.textContent = Number.isFinite(lat) && Number.isFinite(lng) && field(node, "lat").value !== ""
    ? `地図の位置: ${lat.toFixed(4)}, ${lng.toFixed(4)}`
    : "地図の位置: 未設定";
}

function applyGeoPick(node: HTMLDialogElement, lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  field(node, "lat").value = String(lat);
  field(node, "lng").value = String(lng);
  showCoord(node);
  const results = node.querySelector<HTMLElement>("[data-inline-geo-results]");
  if (results) {
    results.hidden = true;
    results.innerHTML = "";
  }
  setStatus(node.querySelector<HTMLElement>("[data-inline-status]"), "地図の位置を設定しました。保存すると地図に反映されます。");
}

async function searchPlace(node: HTMLDialogElement): Promise<void> {
  const results = node.querySelector<HTMLElement>("[data-inline-geo-results]");
  const query = (field(node, "place").value || field(node, "title").value).trim();
  if (!results) return;
  if (!query) {
    results.hidden = false;
    results.innerHTML = `<small>場所かタイトルを入れてから検索してください。</small>`;
    return;
  }
  results.hidden = false;
  results.innerHTML = `<small>候補を検索中…</small>`;
  const area = field(node, "area").value.trim();
  try {
    const found: GeoResult[] = await searchLocations(query, {
      cityName: area || undefined,
      cityAliases: area ? cityAliasesFor(area) : undefined,
      purpose: field<HTMLSelectElement>(node, "type").value === "move" ? "move" : "place",
    }, { mapboxToken: MAPBOX_TOKEN });
    if (!found.length) {
      results.innerHTML = `<small>候補が見つかりませんでした。都市名や国名を足して検索してください。</small>`;
      return;
    }
    results.innerHTML = found.map((result) =>
      `<button type="button" data-geo-lat="${result.lat}" data-geo-lng="${result.lng}">${escapeHtml(result.label)}</button>`,
    ).join("") + `<small>${escapeHtml(geocodingAttribution(found))}</small>`;
  } catch {
    results.innerHTML = `<small>場所を検索できませんでした。時間をおいて試してください。</small>`;
  }
}

function openItem(index: number, date: string): void {
  const node = itemDialog();
  const item = index >= 0 ? state.data.itinerary[index] : undefined;
  node.querySelector<HTMLElement>("[data-inline-dialog-title]")!.textContent = item ? "予定を編集" : "予定を追加";
  field(node, "index").value = item ? String(index) : "";
  field(node, "itemId").value = item?.itemId || "";
  field(node, "date").value = item?.date || date;
  field(node, "lat").value = Number.isFinite(Number(item?.lat)) && item?.lat !== "" ? String(item?.lat) : "";
  field(node, "lng").value = Number.isFinite(Number(item?.lng)) && item?.lng !== "" ? String(item?.lng) : "";
  for (const key of ["time", "type", "title", "place", "area", "transport", "origin", "destination", "duration", "note"] as const) {
    field(node, key).value = String(item?.[key] || (key === "type" ? "sight" : ""));
  }
  const remove = node.querySelector<HTMLButtonElement>("[data-inline-delete]");
  if (remove) remove.hidden = !item;
  const results = node.querySelector<HTMLElement>("[data-inline-geo-results]");
  if (results) {
    results.hidden = true;
    results.innerHTML = "";
  }
  showCoord(node);
  setStatus(node.querySelector<HTMLElement>("[data-inline-status]"), "");
  node.showModal();
}

/** ダイアログの入力を、そのまま予定の項目にする（座標は入っているときだけ）。 */
function itemFromForm(node: HTMLDialogElement): Partial<ItineraryItem> & { date: string } {
  const lat = field(node, "lat").value;
  const lng = field(node, "lng").value;
  return {
    date: field(node, "date").value,
    time: field(node, "time").value,
    type: field<HTMLSelectElement>(node, "type").value as ItemType,
    title: field(node, "title").value.trim(),
    place: field(node, "place").value.trim(),
    area: field(node, "area").value.trim(),
    transport: field(node, "transport").value.trim(),
    origin: field(node, "origin").value.trim(),
    destination: field(node, "destination").value.trim(),
    duration: field(node, "duration").value.trim(),
    note: field(node, "note").value.trim(),
    ...(lat !== "" && lng !== "" ? { lat: Number(lat), lng: Number(lng) } : {}),
  };
}

async function saveItem(node: HTMLDialogElement): Promise<void> {
  const status = node.querySelector<HTMLElement>("[data-inline-status]");
  if (!field(node, "title").value.trim()) {
    setStatus(status, "タイトルを入力してください。");
    return;
  }
  if (!field(node, "date").value) {
    setStatus(status, "日付を選んでください。");
    return;
  }
  const itemId = field(node, "itemId").value;
  const raw = field(node, "index").value;
  const index = raw === "" ? -1 : Number(raw);
  const values = itemFromForm(node);
  const ok = await commit(status, (data) => {
    applyItemEdit(data, index >= 0 ? locate(data, itemId, index) : -1, values);
  });
  if (ok) node.close();
}

async function deleteItem(node: HTMLDialogElement): Promise<void> {
  const status = node.querySelector<HTMLElement>("[data-inline-status]");
  const itemId = field(node, "itemId").value;
  const index = Number(field(node, "index").value);
  if (!Number.isInteger(index) || index < 0) return;
  const data = planData();
  const at = data ? locate(data, itemId, index) : -1;
  if (!data || at < 0) {
    setStatus(status, "この予定は見つかりませんでした。画面を読み込み直してください。");
    return;
  }
  if (!window.confirm(`「${data.itinerary[at].title || "この予定"}」を削除しますか？`)) return;
  const ok = await commit(status, (next) => {
    const target = locate(next, itemId, index);
    if (target >= 0) next.itinerary.splice(target, 1);
  });
  if (ok) node.close();
}

/** 地図から呼ぶ用：itemId の予定をダイアログで開く。 */
export function openItemById(itemId: string): void {
  const index = state.data.itinerary.findIndex((item) => item.itemId === itemId);
  if (index < 0) return;
  openItem(index, "");
}

// ---- 並べ替え -----------------------------------------------------------
//
// 1日の中の並びは、行程の配列の並びがそのまま表示順になる。ドラッグで
// 入れ替えたら、その日の予定が今使っている位置だけを入れ替えて保存する
// （他の日や、班タブで隠れている予定の位置は動かさない）。

let dragInstances: { destroy: () => void }[] = [];
let dragGeneration = 0;

function clearDrag(): void {
  dragGeneration += 1;
  dragInstances.forEach((instance) => instance.destroy());
  dragInstances = [];
}

async function enableDrag(): Promise<void> {
  const generation = dragGeneration;
  const blocks = [...root.querySelectorAll<HTMLElement>("[data-day-block]")]
    .filter((block) => block.querySelector(".tl-inline-grip"));
  if (!blocks.length) return;
  // sortablejs は編集モードに入って初めて要るので、観覧時は読み込まない。
  const { default: Sortable } = await import("sortablejs");
  if (!isInlineEditing() || generation !== dragGeneration) return;
  for (const block of blocks) {
    dragInstances.push(Sortable.create(block, {
      draggable: ".tl-item",
      handle: ".tl-inline-grip",
      animation: 150,
      ghostClass: "tl-inline-drag-ghost",
      onEnd: () => void saveOrder(block),
    }));
  }
}

async function saveOrder(block: HTMLElement): Promise<void> {
  const keys: ItemKey[] = [...block.querySelectorAll<HTMLElement>(".tl-item[data-inline-item-index]")].map((el) => ({
    itemId: el.dataset.inlineItemId || "",
    index: Number(el.dataset.inlineItemIndex),
  }));
  const data = planData();
  if (!data || !applyReorder(data, keys)) {
    showEditBarStatus("並べ替えを保存できませんでした。画面を読み込み直しました。");
    return;
  }
  const ok = await commit(editBarStatusEl(), (next) => { applyReorder(next, keys); });
  if (ok) showEditBarStatus("並べ替えを保存しました。");
}

// ---- 配線 ---------------------------------------------------------------

export function bindInlineEditing(): void {
  clearDrag();
  if (!isInlineEditing()) return;
  root.querySelectorAll<HTMLButtonElement>("[data-inline-item-edit]").forEach((button) => {
    const host = button.closest<HTMLElement>("[data-inline-item-index]");
    button.addEventListener("click", () => openItem(Number(host?.dataset.inlineItemIndex ?? -1), ""));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-inline-add-date]").forEach((button) =>
    button.addEventListener("click", () => openItem(-1, button.dataset.inlineAddDate || "")));
  root.querySelectorAll<HTMLButtonElement>("[data-inline-day-insert]").forEach((button) =>
    button.addEventListener("click", () => void insertDayAfter(button.dataset.inlineDayInsert || "")));
  root.querySelectorAll<HTMLButtonElement>("[data-inline-day-remove]").forEach((button) =>
    button.addEventListener("click", () => void removeDay(button.dataset.inlineDayRemove || "")));
  void enableDrag();
}

export function setupInlineEditor(editHead: HTMLElement, editLink?: HTMLElement | null): void {
  const toggle = (event: Event): void => { event.preventDefault(); setInlineEditing(!isInlineEditing()); };
  editHead.addEventListener("click", toggle);
  editLink?.addEventListener("click", toggle);
  root.querySelector<HTMLElement>("[data-inline-edit-done]")?.addEventListener("click", () => setInlineEditing(false));
  root.querySelector<HTMLElement>("[data-inline-trip-edit]")?.addEventListener("click", openTripInfo);
  root.querySelector<HTMLElement>("[data-inline-city-edit]")?.addEventListener("click", openCities);
  root.querySelector<HTMLElement>("[data-inline-day-append]")?.addEventListener("click", () => void appendDay());
  if (location.hash === "#edit") {
    setInlineEditing(true);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
}
