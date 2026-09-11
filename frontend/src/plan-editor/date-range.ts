import flatpickr from "flatpickr";
import { Japanese } from "flatpickr/dist/l10n/ja.js";
import { toISO } from "../shared/date";
import { model, datesString } from "./editor-state";
import { rangeEl, rangeTrigger, rangeLabel } from "./editor-dom";
import { markDirty } from "./persist";
import { refreshMap } from "./map";
import { rebuildDays, renderDays } from "./days-render";
import { renderMembers } from "./members";

// 期間レンジピッカー（flatpickr・カレンダーで開始日→終了日を一括選択）
const fp = flatpickr(rangeEl, {
  mode: "range",
  dateFormat: "Y-m-d",
  locale: Japanese,
  clickOpens: false,
  disableMobile: true,
  onChange: (dates: Date[]) => {
    model.startDate = dates[0] ? toISO(dates[0]) : "";
    model.endDate = dates[1] ? toISO(dates[1]) : model.startDate;
    updateRangeButton();
    rebuildDays();
    renderDays();
    renderMembers(); // 参加期間の初期値・min/max・サマリ表示は旅行期間に依存する
    refreshMap(false);
    markDirty();
  },
  onOpen: () => {
    rangeTrigger.setAttribute("aria-expanded", "true");
  },
  onClose: () => {
    rangeTrigger.setAttribute("aria-expanded", "false");
  },
});

export function updateRangeButton(): void {
  rangeLabel.textContent = datesString() || "期間を選択";
  rangeTrigger.classList.toggle("is-empty", !model.startDate);
}

/** 読み込んだ計画の期間をカレンダーへ映す（onChange は起こさない）。 */
export function showRangeDates(startDate: string, endDate: string): void {
  fp.setDate([startDate, endDate], false);
}

export function onRangeTriggerClick(): void {
  fp.open(undefined, rangeTrigger);
}
