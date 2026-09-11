import { escapeHtml } from "../shared/dom";
import { distinctPlaceCount, countriesFromPins, type PersonTrip, type HistoryPin } from "../shared/travel-history";
import { $ } from "./context";
import { tripDays } from "./trip-summary";

export function renderStats(statsEl: HTMLElement | null, trips: PersonTrip[], allPins: HistoryPin[]): void {
  const countries = countriesFromPins(allPins);
  const totalDays = trips.reduce((sum, t) => sum + tripDays(t), 0);

  // 統計バンド
  if (statsEl) statsEl.hidden = false;
  const set = (sel: string, value: number): void => {
    const el = $(sel);
    if (el) el.textContent = String(value);
  };
  set("[data-country-count]", countries.length);
  set("[data-trip-count]", trips.length);
  set("[data-place-count]", distinctPlaceCount(trips));
  set("[data-day-count]", totalDays);

  // 国旗ストリップ
  const flagsEl = $("[data-flags]");
  if (flagsEl) {
    flagsEl.hidden = !countries.length;
    flagsEl.innerHTML = countries
      .map((c) => `<span class="pv-flag" title="${escapeHtml(c.name)}（${c.count}か所）">${c.flag}</span>`)
      .join("");
  }
}
