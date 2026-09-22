// 編集モードの「旅行情報」と「日程・都市」。どちらも観覧画面の上に
// ダイアログで開き、保存すると同じ画面がその場で描き直される。

import { escapeHtml } from "../shared/dom";
import type { RouteCity } from "../shared/types";
import { dialogHead, dialogNode, field } from "./inline-dialog";
import {
  applyCityEdit, applyDayAppend, applyDayInsert, applyDayRemove, applyTripEdit,
  commit, itemsOnDate, itineraryDates, planData, setStatus, tripEnd, tripStart,
} from "./inline-store";
import { showEditBarStatus, editBarStatusEl } from "./inline-mode";

// ---- 旅行情報 -----------------------------------------------------------

function tripDialog(): HTMLDialogElement {
  return dialogNode("data-inline-trip-dialog", `<form method="dialog" data-inline-trip-form>
      ${dialogHead("旅行情報を編集")}
      <div class="tl-inline-fields">
        <label class="is-wide"><span>旅行名</span><input name="trip-title" maxlength="120" required></label>
        <label><span>開始日</span><input name="trip-start" type="date" required></label>
        <label><span>終了日</span><input name="trip-end" type="date" required></label>
        <label class="is-wide"><span>カバー画像URL</span><input name="trip-cover" type="url" maxlength="1000" placeholder="https://…"></label>
      </div>
      <p data-inline-trip-status aria-live="polite"></p>
      <div class="tl-inline-dialog-actions"><span></span><button type="button" data-dialog-close>キャンセル</button><button type="submit" class="is-primary">保存</button></div>
    </form>`, (node) => {
    node.querySelector<HTMLFormElement>("[data-inline-trip-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveTripInfo(node);
    });
  });
}

export function openTripInfo(): void {
  const node = tripDialog();
  const data = planData();
  field(node, "trip-title").value = data?.trip?.title || "";
  field(node, "trip-start").value = data ? tripStart(data) : "";
  field(node, "trip-end").value = data ? tripEnd(data) : "";
  field(node, "trip-cover").value = data?.trip?.cover || "";
  setStatus(node.querySelector<HTMLElement>("[data-inline-trip-status]"), "");
  node.showModal();
}

async function saveTripInfo(node: HTMLDialogElement): Promise<void> {
  const status = node.querySelector<HTMLElement>("[data-inline-trip-status]");
  const title = field(node, "trip-title").value.trim();
  const start = field(node, "trip-start").value;
  const end = field(node, "trip-end").value;
  const cover = field(node, "trip-cover").value.trim();
  if (!title || !start || !end || start > end) {
    setStatus(status, "旅行名と正しい期間を入力してください。");
    return;
  }
  const data = planData();
  const dates = data ? itineraryDates(data) : [];
  const dropped = dates.filter((date) => date < start || date > end);
  if (dropped.length && !window.confirm(
    `期間の外になる ${dropped.length} 日分の予定（${dropped[0]} など）は日程に表示されなくなります。続けますか？`)) return;
  const ok = await commit(status, (next) => applyTripEdit(next, { title, start, end, cover }));
  if (ok) node.close();
}

// ---- 日程・都市 ---------------------------------------------------------

function cityDialog(): HTMLDialogElement {
  return dialogNode("data-inline-city-dialog", `<form method="dialog" data-inline-city-form>
      ${dialogHead("日程・都市を編集")}
      <p class="tl-inline-hint">滞在する都市と期間を並べます。日付ごとの見出しや地図の並びはここから決まります。</p>
      <div data-inline-city-rows></div>
      <button type="button" class="tl-inline-add" data-inline-city-add>＋ 都市を追加</button>
      <p data-inline-city-status aria-live="polite"></p>
      <div class="tl-inline-dialog-actions"><span></span><button type="button" data-dialog-close>キャンセル</button><button type="submit" class="is-primary">保存</button></div>
    </form>`, (node) => {
    node.querySelector<HTMLElement>("[data-inline-city-add]")?.addEventListener("click", () => {
      const data = planData();
      addCityRow(node, { name: "", fromDate: data ? tripStart(data) : "", toDate: data ? tripEnd(data) : "" });
    });
    node.querySelector<HTMLElement>("[data-inline-city-rows]")?.addEventListener("click", (event) => {
      const remove = (event.target as HTMLElement).closest<HTMLElement>("[data-inline-city-remove]");
      if (remove) remove.closest("[data-inline-city-row]")?.remove();
    });
    node.querySelector<HTMLFormElement>("[data-inline-city-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCities(node);
    });
  });
}

function addCityRow(node: HTMLDialogElement, city: RouteCity): void {
  const rows = node.querySelector<HTMLElement>("[data-inline-city-rows]");
  if (!rows) return;
  rows.insertAdjacentHTML("beforeend", `<div class="tl-inline-city-row" data-inline-city-row
      data-origin-name="${escapeHtml(city.name || "")}"
      data-lat="${escapeHtml(String(city.lat ?? ""))}" data-lng="${escapeHtml(String(city.lng ?? ""))}">
    <label><span>都市名</span><input data-city-name maxlength="80" value="${escapeHtml(city.name || "")}"></label>
    <label><span>開始日</span><input data-city-from type="date" value="${escapeHtml(city.fromDate || "")}"></label>
    <label><span>終了日</span><input data-city-to type="date" value="${escapeHtml(city.toDate || "")}"></label>
    <button type="button" data-inline-city-remove aria-label="この都市を削除">削除</button>
  </div>`);
}

export function openCities(): void {
  const node = cityDialog();
  const data = planData();
  const rows = node.querySelector<HTMLElement>("[data-inline-city-rows]");
  if (rows) rows.innerHTML = "";
  (data?.cities || []).forEach((city) => addCityRow(node, city));
  if (!data?.cities?.length && data) {
    addCityRow(node, { name: "", fromDate: tripStart(data), toDate: tripEnd(data) });
  }
  setStatus(node.querySelector<HTMLElement>("[data-inline-city-status]"), "");
  node.showModal();
}

async function saveCities(node: HTMLDialogElement): Promise<void> {
  const status = node.querySelector<HTMLElement>("[data-inline-city-status]");
  const rows = [...node.querySelectorAll<HTMLElement>("[data-inline-city-row]")];
  const cities: RouteCity[] = rows.map((row) => {
    const name = row.querySelector<HTMLInputElement>("[data-city-name]")?.value.trim() || "";
    // 座標は同じ都市のときだけ引き継ぐ。名前を変えたら別の場所なので捨てる。
    const sameCity = name === (row.dataset.originName || "");
    return {
      name,
      fromDate: row.querySelector<HTMLInputElement>("[data-city-from]")?.value || "",
      toDate: row.querySelector<HTMLInputElement>("[data-city-to]")?.value || "",
      lat: sameCity ? row.dataset.lat || "" : "",
      lng: sameCity ? row.dataset.lng || "" : "",
    };
  });
  const filled = cities.filter((city) => city.name || city.fromDate || city.toDate);
  const broken = filled.find((city) => !city.name || !city.fromDate || !city.toDate || city.fromDate > city.toDate);
  if (broken) {
    setStatus(status, "都市名と、開始日・終了日（開始日が先）を入れてください。");
    return;
  }
  const ok = await commit(status, (data) => applyCityEdit(data, filled));
  if (ok) node.close();
}

// ---- 日の追加・削除 -----------------------------------------------------

export async function appendDay(): Promise<void> {
  const ok = await commit(editBarStatusEl(), (data) => applyDayAppend(data));
  if (ok) showEditBarStatus("最終日の後に1日足しました。");
}

export async function insertDayAfter(date: string): Promise<void> {
  if (!date) return;
  const ok = await commit(editBarStatusEl(), (data) => applyDayInsert(data, date));
  if (ok) showEditBarStatus("この日の後に空の1日を差し込みました。以降の予定は1日ずつ後ろへずらしました。");
}

export async function removeDay(date: string): Promise<void> {
  const data = planData();
  if (!data || !date) return;
  if (tripStart(data) === tripEnd(data)) {
    showEditBarStatus("1日だけの旅行なので、この日は削除できません。");
    return;
  }
  const items = itemsOnDate(data, date);
  const message = items.length
    ? `この日の予定 ${items.length} 件を削除し、以降の予定を1日ずつ前へ詰めます。よろしいですか？`
    : "この日を旅程から外し、以降の予定を1日ずつ前へ詰めます。よろしいですか？";
  if (!window.confirm(message)) return;
  const ok = await commit(editBarStatusEl(), (next) => applyDayRemove(next, date));
  if (ok) showEditBarStatus("この日を旅程から外しました。間違えたときは行程履歴から戻せます。");
}
