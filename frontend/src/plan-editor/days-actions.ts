import * as db from "../shared/db";
import {
  type ItemKind, type ItemStrKey, type GeoTarget, state, model, newItem, findItem, timeOrder, clearItemCoords, autoCoords,
} from "./editor-state";
import { daysEl } from "./editor-dom";
import { maybeDefaultMoveTransport, syncTransportSelect } from "./move-transport";
import { markDirty } from "./persist";
import { refreshMap, scheduleMapRefresh } from "./map";
import {
  editTrackChoice, selectedEditTrack, renderDays, refreshNode, refreshDayHeader, focusOpenItem, stayNightLimits,
} from "./days-render";
import {
  disarm, arm, runGeocode, applyGeo, geoCache, geoSuggestTimers, clearGeoResults, scheduleNamePlaceSuggest,
} from "./place-geocode";

// ---- イベント委譲 -------------------------------------------------------

export function onDaysClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-grip]")) return; // ドラッグハンドルのクリックは無視
  const actEl = target.closest<HTMLElement>("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  const itemId = Number(actEl.dataset.item || actEl.closest<HTMLElement>("[data-node]")?.dataset.node || 0);
  const dayIndex = Number(actEl.dataset.day || 0);

  if (act === "toggle") {
    state.openItemId = state.openItemId === itemId ? null : itemId;
    disarm();
    renderDays();
    focusOpenItem();
    return;
  }
  if (act === "close") { state.openItemId = null; disarm(); renderDays(); return; }
  if (act === "remove") {
    const found = findItem(itemId);
    if (found) {
      if (found.item.kind === "stay") found.day.stay = null;
      else found.day.items = found.day.items.filter((x) => x.id !== itemId);
      markDirty(); renderDays(); refreshMap(false);
    }
    return;
  }
  if (act === "track") {
    const day = model.days[dayIndex];
    if (day) {
      editTrackChoice.set(day.date, actEl.dataset.track || "");
      renderDays();
      refreshMap(false);
    }
    return;
  }
  if (act === "add") {
    const kind = (actEl.dataset.kind || "sight") as ItemKind;
    const day = model.days[dayIndex];
    if (!day) return;
    const it = newItem(kind);
    maybeDefaultMoveTransport(it, day, "", undefined, true);
    // 班タブを選んでいる日は、追加した予定をその班のものにする
    // （全員の予定にしたければ、予定を開いて対象メンバーを「全員」に戻せる）
    const track = selectedEditTrack(day);
    if (track && kind !== "stay") it.members = [...track.memberIds];
    if (kind === "stay") day.stay = it;
    else day.items.push(it);
    state.openItemId = it.id;
    markDirty(); renderDays(); refreshMap(false); focusOpenItem();
    return;
  }
  if (act === "members-all") {
    const found = findItem(itemId);
    if (found && found.item.members.length) {
      found.item.members = [];
      markDirty(); renderDays();
    }
    return;
  }
  if (act === "member-toggle") {
    const found = findItem(itemId);
    const uid = actEl.dataset.member || "";
    if (found && uid) {
      const set = new Set(found.item.members);
      if (set.has(uid)) set.delete(uid);
      else set.add(uid);
      // 全員を選んだ状態は「全員（空）」と同じ意味なので空へ正規化する
      const ids = model.memberIds.filter((id) => id && db.nameOf(id));
      found.item.members = ids.length && ids.every((id) => set.has(id)) ? [] : [...set];
      markDirty(); renderDays();
    }
    return;
  }
  if (act === "copy-prev") {
    const day = model.days[dayIndex];
    const prev = model.days[dayIndex - 1];
    if (!day || !prev) return;
    day.area = day.area || prev.area;
    prev.items.forEach((it) => day.items.push(newItem(it.kind, it)));
    if (prev.stay && !day.stay) day.stay = newItem("stay", prev.stay);
    markDirty(); renderDays(); refreshMap(true);
    return;
  }
  if (act === "sort-time") {
    const day = model.days[dayIndex];
    if (day) {
      day.items = day.items
        .map((it, i) => ({ it, i }))
        .sort((a, b) => timeOrder(a.it.time) - timeOrder(b.it.time) || a.i - b.i)
        .map((x) => x.it);
      markDirty(); renderDays(); refreshMap(false);
    }
    return;
  }
  if (act === "geo") { void runGeocode(itemId, (actEl.dataset.target || "place") as GeoTarget); return; }
  if (act === "geo-arm") { arm(itemId, (actEl.dataset.target || "place") as GeoTarget, actEl); return; }
  if (act === "geo-pick") {
    const key = `${itemId}-${actEl.dataset.target}`;
    const list = geoCache.get(key);
    const r = list && list[Number(actEl.dataset.idx || 0)];
    if (r) applyGeo(itemId, (actEl.dataset.target || "place") as GeoTarget, r);
    return;
  }
}

export function onDaysInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLSelectElement)) return;

  // 日の拠点エリア
  const areaIdx = target.getAttribute("data-area");
  if (areaIdx !== null) {
    const day = model.days[Number(areaIdx)];
    if (day) { day.area = target.value; refreshDayHeader(Number(areaIdx)); markDirty(); }
    return;
  }

  const fieldName = target.getAttribute("data-field");
  const itemId = Number(target.getAttribute("data-item") || 0);
  if (!fieldName || !itemId) return;
  const found = findItem(itemId);
  if (!found) return;

  // 泊数（数値・連泊範囲が変わるので全再描画）
  if (fieldName === "nights") {
    found.item.nights = Math.max(1, Math.min(stayNightLimits(found.item).tripMax, Number(target.value) || 1));
    markDirty();
    renderDays();
    refreshMap(false);
    return;
  }

  const field = fieldName as ItemStrKey;
  const previousValue = found.item[field];
  found.item[field] = target.value;

  // 入力名と座標は一組として扱う。名前だけ変わったのに以前の座標が残る状態を作らない。
  if (previousValue !== target.value && (field === "place" || field === "mapQuery")) {
    clearItemCoords(found.item, "place");
    if (field === "place") found.item.mapQuery = "";
    autoCoords(found.item, "place");
  }
  if (previousValue !== target.value && field === "from") {
    clearGeoResults(found.item.id, "from");
    clearItemCoords(found.item, "from");
    autoCoords(found.item, "from");
  }
  if (previousValue !== target.value && field === "to") {
    clearGeoResults(found.item.id, "to");
    clearItemCoords(found.item, "to");
    autoCoords(found.item, "to");
  }
  if (field === "from" || field === "to") {
    maybeDefaultMoveTransport(found.item, found.day, "", field);
    syncTransportSelect(found.item);
  }
  if (field === "title") scheduleNamePlaceSuggest(found.item);
  if (field === "place") {
    const timer = geoSuggestTimers.get(found.item.id);
    if (timer) window.clearTimeout(timer);
    geoSuggestTimers.delete(found.item.id);
    clearGeoResults(found.item.id, "place");
  }

  refreshNode(found.item);
  const di = model.days.indexOf(found.day);
  if (found.item.kind === "stay" || field === "place" || field === "from" || field === "to") refreshDayHeader(di);
  markDirty();
  scheduleMapRefresh();
}

// 行のキーボード操作（Enter/Space で開閉）
export function onDaysKeydown(event: KeyboardEvent): void {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const row = t.closest<HTMLElement>('.pe-row[data-act="toggle"]');
  if (!row) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const id = Number(row.dataset.item || 0);
    state.openItemId = state.openItemId === id ? null : id;
    disarm();
    renderDays();
    focusOpenItem();
  }
}

// 日へジャンプ
export function onDayStripClick(event: MouseEvent): void {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const chip = t.closest<HTMLElement>("[data-jump]");
  if (!chip) return;
  daysEl.querySelector<HTMLElement>(`article[data-day="${chip.dataset.jump}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
