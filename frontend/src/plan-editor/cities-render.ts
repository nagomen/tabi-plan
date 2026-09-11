import { escapeHtml } from "../shared/dom";
import { parseISO, weekday } from "../shared/date";
import { icon } from "../shared/icons";
import { model, hasLatLng } from "./editor-state";
import { citiesEl, cityOptions } from "./editor-dom";
import { updateSteps } from "./steps";

// ---- レンダリング: 都市（ルート） ---------------------------------------

function dayOptions(selected: string): string {
  return `<option value="">—</option>` + model.days
    .map((d) => {
      const dt = parseISO(d.date);
      const label = dt ? `${dt.getMonth() + 1}/${dt.getDate()}(${weekday(dt)})` : d.date;
      return `<option value="${d.date}"${d.date === selected ? " selected" : ""}>${label}</option>`;
    })
    .join("");
}
export function renderCities(): void {
  updateSteps();
  cityOptions.innerHTML = model.cities.map((c) => `<option value="${escapeHtml(c.name)}">`).join("");
  if (!model.cities.length) {
    citiesEl.innerHTML = "";
    return;
  }
  const hasDays = model.days.length > 0;
  citiesEl.innerHTML = model.cities
    .map((c, i) => {
      const noGeo = hasLatLng(c.lat, c.lng) ? "" : " no-geo";
      const dateCtl = hasDays
        ? `<span class="pe-city-dates">` +
          `<span class="pe-city-dateicon">${icon("calendarDays")}</span>` +
          `<select data-city-from="${c.id}" aria-label="開始日">${dayOptions(c.fromDate)}</select>` +
          `<span class="pe-city-sep">${icon("arrowLongRight")}</span>` +
          `<select data-city-to="${c.id}" aria-label="終了日">${dayOptions(c.toDate)}</select>` +
          `</span>`
        : "";
      return `<div class="pe-city${noGeo}" data-city="${c.id}">` +
        `<span class="pe-city-n">${i + 1}</span>` +
        `<input class="pe-city-name" data-city-name="${c.id}" value="${escapeHtml(c.name)}" placeholder="都市名" aria-label="都市名">` +
        `<button class="pe-mini pe-city-action" type="button" data-city-geo="${c.id}" title="地図で探す" aria-label="地図で探す">${icon("mapPin")}</button>` +
        dateCtl +
        `<button class="pe-icon-btn danger pe-city-action" type="button" data-city-del="${c.id}" aria-label="削除">${icon("xCircle")}</button>` +
        (noGeo
          ? `<p class="pe-city-nogeo" data-city-nogeo="${c.id}">地図に未登録です。` +
            `<button class="pe-mini" type="button" data-city-pin="${c.id}">${icon("mapPin")}<span>地図で指定</span></button>` +
            `</p>`
          : "") +
        `<div class="pe-geo-results pe-city-results" data-city-geores="${c.id}" hidden></div>` +
        `</div>`;
    })
    .join("");
}
