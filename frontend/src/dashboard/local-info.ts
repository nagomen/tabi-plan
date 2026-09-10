import { escapeHtml } from "../shared/dom";
import type { LocalInfoItem } from "../shared/types";
import { setHtml } from "./dom";

export function renderLocalInfo(rows: LocalInfoItem[]): void {
  const items = (rows || []).slice(0, 9);
  setHtml("[data-local-info]", items.map((item) => {
    const currency = [item.currencyCode, item.currencyName].filter(Boolean).join(" / ");
    const rate = [item.approxRate, item.rateUpdatedAt ? `更新 ${item.rateUpdatedAt}` : ""].filter(Boolean).join(" · ");
    const rideRecommendations = [item.rideBest].concat(String(item.rideAlt || "").split("/"))
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 2)
      .join(" / ");
    return `<article class="tl-local-card">
      <div class="tl-local-top">
        <b class="tl-local-country">${escapeHtml(item.country)}</b>
        <span class="tl-local-currency">${escapeHtml(currency || item.approxRate || "")}</span>
      </div>
      <dl class="tl-local-meta">
        <div><dt>為替</dt><dd>${escapeHtml(rate || "-")}</dd></div>
        <div><dt>無料ATM</dt><dd>${escapeHtml(item.feeFreeAtm || "-")}</dd></div>
        <div><dt>配車おすすめ</dt><dd>${escapeHtml(rideRecommendations || "-")}</dd></div>
      </dl>
      <p class="tl-local-note">${escapeHtml([item.atmNote, item.paymentNote].filter(Boolean).join(" / "))}</p>
    </article>`;
  }).join(""));
}
