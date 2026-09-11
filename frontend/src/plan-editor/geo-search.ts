import { readGlobalTripConfig } from "../shared/config";
import { cityAliasesFor, searchLocations, type GeoContext, type GeoResult } from "../shared/geocoding";
import { type Item, type Day, type GeoTarget, num, hasLatLng, cityForDate } from "./editor-state";
import { countryFromText, countryForCity } from "./move-transport";

export const MAPBOX_TOKEN = readGlobalTripConfig().geocoding?.mapboxToken || "";

export function geocodeSearch(query: string, context?: GeoContext, automatic = false): Promise<GeoResult[]> {
  return searchLocations(query, context, { mapboxToken: MAPBOX_TOKEN, automatic });
}

export function geocodeContextForDay(day: Day, item?: Item, target?: GeoTarget): GeoContext | undefined {
  const city = cityForDate(day.date);
  const cityName = (city?.name || day.area || "").trim();
  const hasCityCoords = city ? hasLatLng(city.lat, city.lng) : false;
  const endpointText = target === "from" ? item?.from : target === "to" ? item?.to : item?.place;
  const endpointCountry = countryFromText(endpointText);
  const isMoveEndpoint = target === "from" || target === "to";
  // 国・都市を含む移動地点は旅行中の都市から独立して検索する。
  // 例: 金門島の日程にある「羽田空港」へ金門島の座標を付けない。
  if (isMoveEndpoint && endpointCountry) {
    return { countryCode: endpointCountry, purpose: "move" };
  }
  const countryCode = endpointCountry || countryForCity(city);
  if (!cityName && !hasCityCoords && !countryCode) return undefined;
  return {
    cityName,
    cityAliases: cityAliasesFor(cityName),
    lat: hasCityCoords ? num(city!.lat) : undefined,
    lng: hasCityCoords ? num(city!.lng) : undefined,
    countryCode: countryCode || undefined,
    purpose: isMoveEndpoint ? "move" : "place",
    requireNearby: item?.kind === "stay" && target === "place",
    radiusKm: item?.kind === "stay" ? 60 : 120,
  };
}

export function geoQueryForItem(item: Item, target: GeoTarget): string {
  if (target === "from") return item.from.trim();
  if (target === "to") return item.to.trim();
  if (item.kind === "stay") return (item.place || item.mapQuery || item.title).trim();
  return (item.mapQuery || item.place || item.title).trim();
}

export function conciseGeoLabel(label: string): string {
  return String(label || "").split(" / ")[0]?.trim() || String(label || "").trim();
}

export function geoAppliedMessage(label: string): string {
  const clean = label.trim();
  return clean
    ? `設定先: ${clean}。違う場合は再検索、または地図で指定し直してください。`
    : "設定先: 住所未確認。違う場合は再検索、または地図で指定し直してください。";
}

export function formatLatLng(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}
