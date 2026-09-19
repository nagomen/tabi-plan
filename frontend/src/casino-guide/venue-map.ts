import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { escapeHtml } from "../shared/dom";
import { addBaseLayer } from "../shared/map-tiles";
import type { CasinoVenue } from "./venue-model";

export interface VenueMapController {
  initialize: () => void;
  focusVenue: (venueId: string) => void;
}

function selectMapPlace(venueId: string): void {
  document.querySelectorAll<HTMLElement>("[data-map-place]").forEach((button) => {
    const selected = button.dataset.mapPlace === venueId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

/** Leafletの状態をこのモジュール内に閉じ込め、呼び出し側へ小さな操作APIだけを公開する。 */
export function createVenueMapController(venues: readonly CasinoVenue[]): VenueMapController {
  let map: L.Map | null = null;
  const markers = new Map<string, L.Marker>();

  const initialize = (): void => {
    const element = document.querySelector<HTMLElement>("[data-venue-map]");
    if (!element || element.offsetParent === null) return;
    if (map) {
      map.invalidateSize();
      return;
    }

    map = L.map(element, {
      scrollWheelZoom: false,
      attributionControl: true,
      zoomControl: true,
    });
    addBaseLayer(L, map);
    venues.forEach((venue) => {
      const marker = L.marker([venue.lat, venue.lng], {
        icon: L.divIcon({
          className: "cg-map-marker-wrap",
          html: `<span class="cg-map-marker">${escapeHtml(venue.number)}</span>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      })
        .addTo(map as L.Map)
        .bindPopup(`<b>${escapeHtml(venue.name)}</b><br>${escapeHtml(venue.area)}`)
        .on("click", () => selectMapPlace(venue.id));
      markers.set(venue.id, marker);
    });
    map.fitBounds(L.latLngBounds(venues.map((venue) => [venue.lat, venue.lng])), {
      padding: [34, 34],
      maxZoom: 12,
    });
  };

  const focusVenue = (venueId: string): void => {
    initialize();
    const venue = venues.find((candidate) => candidate.id === venueId);
    if (!map || !venue) return;
    map.setView([venue.lat, venue.lng], 14, { animate: true });
    markers.get(venueId)?.openPopup();
    selectMapPlace(venueId);
  };

  return { initialize, focusVenue };
}
