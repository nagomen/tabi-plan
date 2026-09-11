import * as db from "../shared/db";
import * as TripPlans from "../shared/plans-store";
import { formatDurationMinutes } from "../shared/travel-duration";
import { resolveAiMapGeocodeJobs, type AiMapGeocodeSummary } from "./ai-map-geocoding";
import { automaticGeocodingAvailable, type GeoResult } from "../shared/geocoding";
import { type ItemKind, type Item, type GeoTarget, state, model, newItem, autoCoords, latLngKeys } from "./editor-state";
import { countryFromText } from "./move-transport";
import { MAPBOX_TOKEN, geocodeSearch, geocodeContextForDay, geoQueryForItem, conciseGeoLabel } from "./geo-search";

function contextualMapQuery(place: string, area: string): string {
  const query = place.trim();
  const city = area.trim();
  if (!query || !city || query.normalize("NFKC").toLowerCase().includes(city.normalize("NFKC").toLowerCase())) {
    return query;
  }
  return `${query}, ${city}`;
}

function aiCoordinate(value: number | null | undefined, minimum: number, maximum: number): string {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= minimum && number <= maximum
    ? String(number)
    : "";
}

/** 生成結果を編集中のモデルへ流し込む。 */
export function applyItineraryDraft(draft: db.ItineraryDraft): void {
  model.cities = draft.cities.map((city) => {
    const name = city.name.trim();
    const coords = TripPlans.coordsFor(name);
    const latitude = aiCoordinate(city.latitude, -90, 90);
    const longitude = aiCoordinate(city.longitude, -180, 180);
    return {
      id: state.seq++,
      name,
      lat: latitude || (coords ? String(coords.lat) : ""),
      lng: longitude || (coords ? String(coords.lng) : ""),
      fromDate: city.from_date || "",
      toDate: city.to_date || city.from_date || "",
    };
  });
  const byDate = new Map(draft.days.map((day) => [day.date, day]));
  for (const day of model.days) {
    const source = byDate.get(day.date);
    if (!source) {
      // 置き換えに同意してもらっているので、生成が届かなかった日は空にする。
      // 前の予定が混ざったまま残るほうが分かりにくい。
      day.items = [];
      day.stay = null;
      continue;
    }
    if (source.area) day.area = source.area;
    const kinds: ItemKind[] = ["sight", "food", "move", "stay", "todo", "form"];
    const items = source.items.filter((item) => kinds.includes(item.kind as ItemKind));
    // 宿泊はその日の「錨」として別枠に持つ。予定の列には入れない。
    const stay = items.find((item) => item.kind === "stay");
    day.items = items
      .filter((item) => item.kind !== "stay")
      .map((item) => {
        const created = newItem(item.kind as ItemKind, {
          time: item.time || "",
          title: item.title || "",
          place: item.place || "",
          mapQuery: item.kind === "move"
            ? item.address || ""
            : item.address || contextualMapQuery(item.place || item.title, source.area),
          lat: aiCoordinate(item.latitude, -90, 90),
          lng: aiCoordinate(item.longitude, -180, 180),
          note: item.note || "",
          ...(item.kind === "move" ? {
            ...splitMoveTitle(item.title),
            from: item.from_place || splitMoveTitle(item.title).from || "",
            fromLat: aiCoordinate(item.from_latitude, -90, 90),
            fromLng: aiCoordinate(item.from_longitude, -180, 180),
            to: item.to_place || splitMoveTitle(item.title).to || "",
            toLat: aiCoordinate(item.to_latitude ?? item.latitude, -90, 90),
            toLng: aiCoordinate(item.to_longitude ?? item.longitude, -180, 180),
            transport: item.transport || "",
            duration: formatDurationMinutes(item.duration_minutes),
          } : {}),
        });
        if (created.kind === "move") {
          autoCoords(created, "from");
          autoCoords(created, "to");
        } else {
          autoCoords(created, "place");
        }
        return created;
      });
    day.stay = stay
      ? newItem("stay", {
          title: stay.title || "",
          place: stay.place || "",
          mapQuery: stay.address || contextualMapQuery(stay.place || stay.title, source.area),
          lat: aiCoordinate(stay.latitude, -90, 90),
          lng: aiCoordinate(stay.longitude, -180, 180),
          note: stay.note || "",
          nights: 1,
        })
      : null;
    if (day.stay) autoCoords(day.stay, "place");
  }
}

interface AiMapRegistrationSummary extends AiMapGeocodeSummary {
  available: boolean;
}

/** AIが登録した施設名を住所へ正規化し、地図用座標と完全な住所文字列をモデルへ付与する。 */
export async function registerAiDraftPlacesOnMap(): Promise<AiMapRegistrationSummary> {
  const placeItems = model.days.flatMap((day) => [
    ...day.items.map((item) => ({ day, item })),
    ...(day.stay ? [{ day, item: day.stay }] : []),
  ]);
  const targetCount = model.cities.filter((city) => city.name.trim()).length + placeItems.reduce((count, { item }) => {
    if (item.kind === "move") return count + Number(Boolean(item.from.trim())) + Number(Boolean(item.to.trim()));
    return count + Number(["sight", "food", "stay"].includes(item.kind) && Boolean(geoQueryForItem(item, "place")));
  }, 0);
  if (!automaticGeocodingAvailable(MAPBOX_TOKEN)) {
    return { available: false, attempted: targetCount, resolved: 0, unresolved: targetCount };
  }

  const citySummary = await resolveAiMapGeocodeJobs(
    model.cities.map((city) => ({
      query: city.name,
      context: { countryCode: countryFromText(city.name) || undefined, purpose: "city" as const },
      apply: (result: GeoResult) => {
        city.lat = String(result.lat);
        city.lng = String(result.lng);
      },
    })),
    (query, context) => geocodeSearch(query, context, true),
  );

  const jobs = placeItems.flatMap(({ day, item }) => {
    const targets: GeoTarget[] = item.kind === "move" ? ["from", "to"] : ["place"];
    if (item.kind !== "move" && !["sight", "food", "stay"].includes(item.kind)) return [];
    return targets.flatMap((target) => {
      const query = geoQueryForItem(item, target);
      if (!query) return [];
      return [{
        query,
        context: geocodeContextForDay(day, item, target),
        apply: (result: GeoResult) => {
          const [latKey, lngKey] = latLngKeys(target);
          item[latKey] = String(result.lat);
          item[lngKey] = String(result.lng);
          if (target === "place") {
            // providerの完全な住所を、Google Mapsリンクと再保存にも使う。
            item.mapQuery = result.label;
            if (!item.place.trim()) item.place = conciseGeoLabel(result.label);
          }
        },
      }];
    });
  });
  const itemSummary = await resolveAiMapGeocodeJobs(
    jobs,
    (query, context) => geocodeSearch(query, context, true),
  );
  return {
    available: true,
    attempted: citySummary.attempted + itemSummary.attempted,
    resolved: citySummary.resolved + itemSummary.resolved,
    unresolved: citySummary.unresolved + itemSummary.unresolved,
  };
}

/** 「A → B」の移動タイトルから出発地・到着地を拾う。 */
function splitMoveTitle(title: string): Partial<Item> {
  const parts = String(title || "").split(/[→⇒]|->/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? { from: parts[0], to: parts[1] } : {};
}
