// 場所検索プロバイダーの差し替え口。UI状態は持たず、検索・順位付け・キャッシュだけを担当する。

export type GeoPurpose = "city" | "place" | "move";
export type GeoProvider = "mapbox" | "nominatim";

export interface GeoResult {
  id: string;
  label: string;
  lat: number;
  lng: number;
  provider: GeoProvider;
  featureType: string;
  countryCode: string;
  providerRank: number;
}

export interface GeoContext {
  cityName?: string;
  cityAliases?: string[];
  lat?: number;
  lng?: number;
  countryCode?: string;
  purpose?: GeoPurpose;
  requireNearby?: boolean;
  radiusKm?: number;
}

interface SearchOptions {
  mapboxToken?: string;
  /** 公開Nominatimでは自動補完が禁止されているため、自動検索はMapbox時だけ許可する。 */
  automatic?: boolean;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const resultCache = new Map<string, { expiresAt: number; results: GeoResult[] }>();
const pending = new Map<string, Promise<GeoResult[]>>();
const reverseCache = new Map<string, { expiresAt: number; label: string }>();
let nominatimQueue: Promise<void> = Promise.resolve();
let lastNominatimAt = 0;

const GEO_QUERY_ALIASES: Array<[RegExp, string]> = [
  [/マリオット/gi, "Marriott"],
  [/アパホテル|apaホテル|アパ/gi, "APA Hotel"],
  [/ヒルトン/gi, "Hilton"],
  [/ハイアット/gi, "Hyatt"],
  [/シェラトン/gi, "Sheraton"],
  [/ウェスティン/gi, "Westin"],
];

const CITY_ALIASES: Record<string, string[]> = {
  バンコク: ["Bangkok", "Krung Thep Maha Nakhon", "Thailand"],
  東京: ["Tokyo"], ニューヨーク: ["New York", "NYC"], 長野: ["Nagano"],
  ソウル: ["Seoul"], 台北: ["Taipei"], 上海: ["Shanghai"], 香港: ["Hong Kong"],
  シンガポール: ["Singapore"], パリ: ["Paris"], ロンドン: ["London"],
  ローマ: ["Rome"], バルセロナ: ["Barcelona"], ミュンヘン: ["Munich", "München"],
};

export function cityAliasesFor(name: string): string[] {
  const key = Object.keys(CITY_ALIASES).find((city) => searchTextIncludes(name, city));
  return key ? CITY_ALIASES[key] : [];
}

export function automaticGeocodingAvailable(mapboxToken: string): boolean {
  return Boolean(mapboxToken.trim());
}

export function geocodingAttribution(results: GeoResult[]): string {
  return results.some((result) => result.provider === "nominatim") ? "© OpenStreetMap contributors" : "Mapbox";
}

export async function searchLocations(
  query: string,
  context: GeoContext = {},
  options: SearchOptions = {},
): Promise<GeoResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const mapboxToken = String(options.mapboxToken || "").trim();
  if (options.automatic && !mapboxToken) return [];

  const provider: GeoProvider = mapboxToken ? "mapbox" : "nominatim";
  const key = cacheKey(provider, trimmed, context);
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results.map((result) => ({ ...result }));
  const active = pending.get(key);
  if (active) return active;

  const task = (async (): Promise<GeoResult[]> => {
    const enriched = enrichedQuery(trimmed, context);
    const primary = provider === "mapbox"
      ? await searchMapbox(enriched, context, mapboxToken)
      : await searchNominatim(enriched, context);
    let collected = primary;

    // Mapboxだけは英字ブランド別名を追加照会する。公開Nominatimには1操作1照会とする。
    const alias = geoQueryAlias(trimmed);
    if (provider === "mapbox" && compactSearchText(alias) !== compactSearchText(trimmed) && primary.length < 5) {
      collected = mergeResults(primary, await searchMapbox(enrichedQuery(alias, context), context, mapboxToken));
    }
    const ranked = rankResults(collected, trimmed, context).slice(0, 5);
    resultCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, results: ranked });
    return ranked.map((result) => ({ ...result }));
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export async function reverseLocation(lat: number, lng: number, mapboxToken = ""): Promise<string> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)},${mapboxToken ? "mapbox" : "nominatim"}`;
  const cached = reverseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.label;
  let label = "";
  if (mapboxToken.trim()) {
    try {
      const params = new URLSearchParams({ language: "ja", limit: "1", access_token: mapboxToken.trim() });
      const response = await fetch(
        `https://api.mapbox.com/search/searchbox/v1/reverse?longitude=${encodeURIComponent(String(lng))}` +
        `&latitude=${encodeURIComponent(String(lat))}&${params.toString()}`,
      );
      if (response.ok) {
        const data = await response.json() as { features?: MapboxFeature[] };
        label = mapboxLabel(data.features?.[0]);
      }
    } catch {
      // 明示的な地図指定なので、Mapbox障害時はNominatimの逆引きへフォールバックする。
    }
  }
  if (!label) {
    label = await scheduleNominatim(async () => {
      const params = new URLSearchParams({
        format: "jsonv2", "accept-language": "ja", lat: String(lat), lon: String(lng), zoom: "18",
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`住所確認に失敗しました (${response.status})`);
      const data = await response.json() as { display_name?: string };
      return String(data.display_name || "").trim();
    });
  }
  reverseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, label });
  return label;
}

function enrichedQuery(query: string, context: GeoContext): string {
  // 移動の端点は現在の滞在都市とは限らない。羽田→台湾の検索に
  // 「金門島」を付けると0件になるため、移動地点へ都市名を混ぜない。
  if (context.purpose === "move") return query;
  const city = context.cityName?.trim() || "";
  return city && !searchTextIncludes(query, city) ? `${query}, ${city}` : query;
}

function geoQueryAlias(query: string): string {
  return GEO_QUERY_ALIASES.reduce((next, [pattern, replacement]) => next.replace(pattern, replacement), query);
}

function compactSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s,./・、。／_-]+/g, "");
}

function searchTextIncludes(query: string, part: string): boolean {
  const q = compactSearchText(query);
  const p = compactSearchText(part);
  return Boolean(q && p && q.includes(p));
}

function cacheKey(provider: GeoProvider, query: string, context: GeoContext): string {
  return JSON.stringify([
    provider, compactSearchText(query), compactSearchText(context.cityName || ""),
    Number(context.lat).toFixed(3), Number(context.lng).toFixed(3),
    context.countryCode || "", context.purpose || "place", Boolean(context.requireNearby),
  ]);
}

function mergeResults(first: GeoResult[], second: GeoResult[]): GeoResult[] {
  const merged = [...first];
  for (const result of second) {
    if (!merged.some((current) => current.id === result.id || distanceKm(current.lat, current.lng, result.lat, result.lng) < 0.003)) {
      merged.push(result);
    }
  }
  return merged;
}

function rankResults(results: GeoResult[], query: string, context: GeoContext): GeoResult[] {
  const queryKey = compactSearchText(query);
  const cityTerms = [context.cityName || "", ...(context.cityAliases || [])].filter(Boolean);
  const radius = context.radiusKm || (context.requireNearby ? 60 : 120);
  const airportIntent = /空港|エアポート|airport|aerodrome/i.test(query);
  return results
    .map((result) => {
      const labelKey = compactSearchText(result.label);
      const airportFacility = /aeroway|aerodrome|airport/.test(result.featureType);
      const airportNamed = /空港|エアポート|airport/i.test(result.label);
      let score = 200 - result.providerRank * 4;
      if (queryKey && labelKey.startsWith(queryKey)) score += 180;
      else if (queryKey && labelKey.includes(queryKey)) score += 120;
      // 「台湾空港」で同じ語を含まない会社が上位に来る例があるため、
      // 文字列一致より施設種別を強く優先する。
      if (airportIntent) score += airportFacility ? 360 : airportNamed ? 80 : -260;
      if (cityTerms.some((city) => searchTextIncludes(result.label, city))) score += 70;
      if (context.countryCode && result.countryCode.toUpperCase() === context.countryCode.toUpperCase()) score += 60;
      if (context.purpose === "city" && /place|locality|district|city|town|village|municipality/.test(result.featureType)) score += 100;
      if (context.purpose !== "city" && /poi|address|street|amenity|tourism|shop|leisure|railway|aeroway|aerodrome/.test(result.featureType)) score += 35;
      if (context.purpose !== "move" && Number.isFinite(context.lat) && Number.isFinite(context.lng)) {
        const km = distanceKm(context.lat!, context.lng!, result.lat, result.lng);
        score += Math.max(-120, 100 - km * 2);
        if (context.requireNearby && km > radius) score -= 1000;
      }
      return { result, score };
    })
    .filter((entry) => entry.score > -500)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.result);
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bboxAround(lat: number, lng: number, radiusKm: number): string {
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.max(0.2, Math.abs(Math.cos(lat * Math.PI / 180))));
  return [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta].map((value) => value.toFixed(5)).join(",");
}

interface MapboxFeature {
  id?: string;
  properties?: {
    mapbox_id?: string;
    name?: string;
    name_preferred?: string;
    place_formatted?: string;
    full_address?: string;
    feature_type?: string;
    context?: { country?: { country_code?: string; name?: string } };
    coordinates?: { latitude?: number; longitude?: number };
  };
  geometry?: { coordinates?: [number, number] };
}

function mapboxLabel(feature: MapboxFeature | undefined): string {
  if (!feature) return "";
  const properties = feature.properties;
  const name = properties?.name_preferred || properties?.name || "";
  const area = properties?.full_address || properties?.place_formatted || "";
  return [name, area].filter(Boolean).join(" / ");
}

async function searchMapbox(query: string, context: GeoContext, token: string): Promise<GeoResult[]> {
  const params = new URLSearchParams({ q: query, language: "ja", limit: "10", access_token: token });
  if (context.purpose !== "move" && Number.isFinite(context.lat) && Number.isFinite(context.lng)) {
    params.set("proximity", `${context.lng},${context.lat}`);
    if (context.requireNearby) params.set("bbox", bboxAround(context.lat!, context.lng!, context.radiusKm || 60));
  }
  if (context.countryCode) params.set("country", context.countryCode.toUpperCase());
  if (context.purpose === "city") params.set("types", "place,locality,district");
  const response = await fetch(`https://api.mapbox.com/search/searchbox/v1/forward?${params.toString()}`);
  if (!response.ok) throw new Error(`検索に失敗しました (${response.status})`);
  const data = await response.json() as { features?: MapboxFeature[] };
  return (data.features || []).map((feature, index) => {
    const coordinates = feature.geometry?.coordinates;
    const lat = coordinates?.[1] ?? feature.properties?.coordinates?.latitude ?? NaN;
    const lng = coordinates?.[0] ?? feature.properties?.coordinates?.longitude ?? NaN;
    return {
      id: feature.properties?.mapbox_id || feature.id || `mapbox-${lat}-${lng}`,
      label: mapboxLabel(feature), lat, lng, provider: "mapbox" as const,
      featureType: String(feature.properties?.feature_type || ""),
      countryCode: String(feature.properties?.context?.country?.country_code || ""),
      providerRank: index,
    };
  }).filter((result) => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
}

interface NominatimResult {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  addresstype?: string;
  category?: string;
  address?: { country_code?: string };
}

/**
 * 国コードでの絞り込みは当てが外れることがある。
 *
 * 「香港」は入力文から HK と判定されるが、OSM 上の香港は国コード cn
 * （中国）に属しているため countrycodes=hk では 0 件になっていた。
 * マカオも同じ形。国は順位付け（同じ国なら加点）で十分効くので、
 * 絞り込みで 0 件になったときは国の条件を外してもう一度だけ引く。
 */
async function searchNominatim(query: string, context: GeoContext): Promise<GeoResult[]> {
  const results = await searchNominatimOnce(query, context, true);
  if (results.length || !context.countryCode) return results;
  return searchNominatimOnce(query, context, false);
}

async function searchNominatimOnce(
  query: string,
  context: GeoContext,
  withCountry: boolean,
): Promise<GeoResult[]> {
  return scheduleNominatim(async () => {
    const params = new URLSearchParams({
      format: "jsonv2", limit: "10", "accept-language": "ja", addressdetails: "1", q: query,
    });
    if (withCountry && context.countryCode) params.set("countrycodes", context.countryCode.toLowerCase());
    if (context.purpose !== "move" && Number.isFinite(context.lat) && Number.isFinite(context.lng)) {
      params.set("viewbox", bboxAround(context.lat!, context.lng!, context.radiusKm || (context.requireNearby ? 60 : 120)));
      if (context.requireNearby) params.set("bounded", "1");
    }
    if (context.purpose === "city") {
      params.set("featuretype", "settlement");
      params.set("layer", "address");
    }
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`検索に失敗しました (${response.status})`);
    const data = await response.json() as NominatimResult[];
    return data.map((result, index) => ({
      id: result.osm_type && result.osm_id ? `${result.osm_type}${result.osm_id}` : `nominatim-${result.place_id || index}`,
      label: String(result.display_name || ""),
      lat: Number(result.lat), lng: Number(result.lon), provider: "nominatim" as const,
      featureType: String(result.addresstype || result.type || result.category || ""),
      countryCode: String(result.address?.country_code || ""), providerRank: index,
    })).filter((result) => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
  });
}

function scheduleNominatim<T>(work: () => Promise<T>): Promise<T> {
  const task = nominatimQueue.then(async () => {
    const wait = 1100 - (Date.now() - lastNominatimAt);
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    lastNominatimAt = Date.now();
    return work();
  });
  nominatimQueue = task.then(() => undefined, () => undefined);
  return task;
}
