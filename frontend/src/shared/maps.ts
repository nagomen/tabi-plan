// Google マップのリンク生成（認証不要のテンプレートURL）。

import type { ItineraryItem, TripData } from "./types";

/** 地名・住所を Google マップ検索で開くURL。 */
export function mapsSearchUrl(query: string | undefined): string {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query || "");
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function xmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function kmlCoordinates(lat: unknown, lng: unknown): string {
  const nextLat = finiteNumber(lat);
  const nextLng = finiteNumber(lng);
  if (nextLat == null || nextLng == null) return "";
  return `${nextLng},${nextLat},0`;
}

function itemLabel(item: ItineraryItem): string {
  return [item.day, item.date, item.time].filter(Boolean).join(" ") || item.date || "予定";
}

function placeName(item: ItineraryItem, fallback = ""): string {
  return item.place || item.mapQuery || item.title || item.area || fallback;
}

function placemarkDescription(item: ItineraryItem, extra: string[] = []): string {
  return [
    item.typeLabel || item.type,
    item.area ? `エリア: ${item.area}` : "",
    item.duration ? `所要時間: ${item.duration}` : "",
    item.transport ? `移動手段: ${item.transport}` : "",
    item.note || "",
    ...extra,
  ].filter(Boolean).join("\n");
}

function pointPlacemark(name: string, description: string, coordinates: string): string {
  return `    <Placemark>
      <name>${xmlText(name)}</name>
      <description>${xmlText(description)}</description>
      <styleUrl>#trip-pin</styleUrl>
      <Point><coordinates>${coordinates}</coordinates></Point>
    </Placemark>`;
}

function linePlacemark(name: string, description: string, fromCoordinates: string, toCoordinates: string): string {
  return `    <Placemark>
      <name>${xmlText(name)}</name>
      <description>${xmlText(description)}</description>
      <styleUrl>#trip-route</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${fromCoordinates} ${toCoordinates}</coordinates>
      </LineString>
    </Placemark>`;
}

/**
 * Google My Maps に読み込ませるためのKML。
 * My Maps公式のインポート対応形式に寄せ、予定はピン、移動は線として出す。
 */
export function buildGoogleMyMapsKml(data: TripData): string {
  const placemarks: string[] = [];
  const seenPoints = new Set<string>();

  const pushPoint = (item: ItineraryItem, label: string, lat: unknown, lng: unknown, descriptionExtra: string[] = []): void => {
    const coordinates = kmlCoordinates(lat, lng);
    if (!coordinates) return;
    const key = `${coordinates}:${label}:${item.date}`;
    if (seenPoints.has(key)) return;
    seenPoints.add(key);
    placemarks.push(pointPlacemark(label, placemarkDescription(item, descriptionExtra), coordinates));
  };

  for (const item of data.itinerary || []) {
    if (String(item.type) === "move") {
      const fromCoordinates = kmlCoordinates(item.originLat, item.originLng);
      const toCoordinates = kmlCoordinates(item.destinationLat, item.destinationLng);
      const origin = item.origin || item.place || item.mapQuery || "出発地";
      const destination = item.destination || item.title || "到着地";
      if (fromCoordinates && toCoordinates) {
        placemarks.push(linePlacemark(
          `${itemLabel(item)} ${origin} → ${destination}`,
          placemarkDescription(item),
          fromCoordinates,
          toCoordinates,
        ));
        pushPoint(item, `${itemLabel(item)} ${origin}`, item.originLat, item.originLng, ["移動の出発地"]);
        pushPoint(item, `${itemLabel(item)} ${destination}`, item.destinationLat, item.destinationLng, ["移動の到着地"]);
        continue;
      }
    }
    pushPoint(item, `${itemLabel(item)} ${placeName(item)}`, item.lat, item.lng);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlText(data.trip?.title || "旅行計画")}</name>
    <Style id="trip-pin">
      <IconStyle>
        <color>ff425a0b</color>
        <scale>1.1</scale>
        <Icon><href>https://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon>
      </IconStyle>
    </Style>
    <Style id="trip-route">
      <LineStyle>
        <color>ff8c7a1b</color>
        <width>4</width>
      </LineStyle>
    </Style>
${placemarks.join("\n")}
  </Document>
</kml>
`;
}

export function googleMyMapsKmlFilename(title: string | undefined): string {
  const safe = String(title || "trip")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[\\/:*?"<>|]/g, "")
    .slice(0, 80);
  return `${safe || "trip"}-google-mymaps.kml`;
}
