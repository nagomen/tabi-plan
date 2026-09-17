import { escapeHtml } from "../shared/dom";
import type { CasinoVenue } from "./venue-model";

type ComparisonField = keyof CasinoVenue["comparison"];

const COMPARISON_ROWS: ReadonlyArray<{ label: string; field: ComparisonField }> = [
  { label: "今回の使い方", field: "use" },
  { label: "テーブル", field: "tables" },
  { label: "マシン／ETG", field: "machines" },
  { label: "個性", field: "trait" },
  { label: "最寄り動線", field: "access" },
];

function comparisonCells(venues: readonly CasinoVenue[], field: ComparisonField): string {
  return venues.map((venue) =>
    `<span>${escapeHtml(venue.comparison[field])}</span>`,
  ).join("");
}

function mapPlaceHtml(venue: CasinoVenue): string {
  return `<button type="button" data-map-place="${escapeHtml(venue.id)}" aria-pressed="false">
    <span>${escapeHtml(venue.number)}</span>
    <b>${escapeHtml(venue.shortName)}</b>
    <small>${escapeHtml(venue.mapSummary)}</small>
  </button>`;
}

function venueArticleHtml(venue: CasinoVenue): string {
  const classes = ["cg-venue", venue.recommended && "is-recommended", venue.airport && "is-airport"]
    .filter(Boolean).join(" ");
  return `<article class="${classes}">
    <span class="cg-badge${venue.recommended ? "" : " is-muted"}">${escapeHtml(venue.badge)}</span>
    <p>${escapeHtml(venue.eyebrow)}</p>
    <h3>${venue.titleLines.map(escapeHtml).join("<br>")}</h3>
    <p class="cg-venue-lead">${escapeHtml(venue.lead)}</p>
    <dl class="cg-venue-facts">${venue.facts.map((fact) =>
      `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`,
    ).join("")}</dl>
    <p class="cg-venue-fit"><b>選ぶ理由</b> ${escapeHtml(venue.fit)}</p>
    <div class="cg-venue-links">${venue.links.map((link) =>
      `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>`,
    ).join("")}</div>
  </article>`;
}

/** 店舗関連の表示をCASINO_VENUESだけから生成する。 */
export function renderVenueGuide(venues: readonly CasinoVenue[]): void {
  const mapPlaces = document.querySelector<HTMLElement>("[data-map-places]");
  if (mapPlaces) mapPlaces.innerHTML = venues.map(mapPlaceHtml).join("");

  const comparison = document.querySelector<HTMLElement>("[data-venue-comparison]");
  if (comparison) {
    const head = `<div class="cg-matrix-head"><span></span>${venues.map((venue) =>
      `<b>${escapeHtml(venue.matrixName)}</b>`,
    ).join("")}</div>`;
    const rows = COMPARISON_ROWS.map(({ label, field }) =>
      `<div class="cg-matrix-row"><strong>${escapeHtml(label)}</strong>${comparisonCells(venues, field)}</div>`,
    ).join("");
    comparison.innerHTML = head + rows;
  }

  const grid = document.querySelector<HTMLElement>("[data-venue-grid]");
  if (grid) grid.innerHTML = venues.map(venueArticleHtml).join("");
}

export function bindVenueSelection(onSelect: (venueId: string) => void): void {
  document.querySelectorAll<HTMLButtonElement>("[data-map-place]").forEach((button) => {
    button.addEventListener("click", () => onSelect(button.dataset.mapPlace || ""));
  });
}
