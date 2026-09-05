import type { TransportOption, TransportSearchInput, TransportSearchResult } from "@tabi/contracts";
import { config } from "./config.js";

const MAX_OPTIONS = 8;
const AMADEUS_TOKEN_SKEW_MS = 60_000;

interface AmadeusToken {
  value: string;
  expiresAt: number;
}

let amadeusToken: AmadeusToken | null = null;

const IATA_BY_CITY = new Map<string, string>([
  ["東京", "TYO"], ["成田", "NRT"], ["成田空港", "NRT"], ["羽田", "HND"], ["羽田空港", "HND"],
  ["大阪", "OSA"], ["関西空港", "KIX"], ["関空", "KIX"],
  ["台北", "TPE"], ["桃園", "TPE"], ["桃園空港", "TPE"], ["台北桃園", "TPE"], ["松山", "TSA"],
  ["高雄", "KHH"], ["花蓮", "HUN"],
  ["香港", "HKG"], ["香港国際空港", "HKG"],
  ["マカオ", "MFM"], ["澳門", "MFM"],
  ["深圳", "SZX"], ["深セン", "SZX"],
  ["広州", "CAN"], ["廣州", "CAN"],
  ["厦門", "XMN"], ["廈門", "XMN"], ["アモイ", "XMN"],
  ["上海", "SHA"], ["浦東", "PVG"], ["北京", "BJS"], ["ソウル", "SEL"], ["仁川", "ICN"],
]);

const UTC_OFFSET_BY_IATA = new Map<string, string>([
  ["TYO", "+09:00"], ["NRT", "+09:00"], ["HND", "+09:00"], ["OSA", "+09:00"], ["KIX", "+09:00"],
  ["SEL", "+09:00"], ["ICN", "+09:00"],
  ["TPE", "+08:00"], ["TSA", "+08:00"], ["KHH", "+08:00"], ["HUN", "+08:00"],
  ["HKG", "+08:00"], ["MFM", "+08:00"], ["SZX", "+08:00"], ["CAN", "+08:00"],
  ["XMN", "+08:00"], ["SHA", "+08:00"], ["PVG", "+08:00"], ["BJS", "+08:00"],
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[・･]/g, "")
    .toLowerCase();
}

function cityCode(value: string): string {
  const raw = String(value || "").trim();
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();
  const normalized = normalizeText(raw);
  for (const [city, code] of IATA_BY_CITY) {
    const key = normalizeText(city);
    if (normalized === key || normalized.includes(key)) return code;
  }
  return "";
}

function parseDurationMinutes(duration: unknown): number {
  const raw = String(duration || "");
  const seconds = /^(\d+)s$/.exec(raw);
  if (seconds) return Math.max(0, Math.round(Number(seconds[1]) / 60));
  const iso = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(raw);
  if (iso) return Math.max(0, Number(iso[1] || 0) * 60 + Number(iso[2] || 0));
  return 0;
}

function parseDateTime(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function addMinutes(localDate: string, minutes: number): string {
  if (!localDate) return "";
  const date = new Date(localDate);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function departureDateTime(input: TransportSearchInput): string {
  const date = String(input.date || "").slice(0, 10);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time || "")) ? input.time : "09:00";
  const offset = UTC_OFFSET_BY_IATA.get(cityCode(input.from)) || "+09:00";
  return date ? `${date}T${time}:00${offset}` : "";
}

function transportMode(input: TransportSearchInput): NonNullable<TransportSearchInput["mode"]> {
  return input.mode || "any";
}

async function amadeusAccessToken(fetchImpl: typeof fetch): Promise<string> {
  if (amadeusToken && Date.now() < amadeusToken.expiresAt - AMADEUS_TOKEN_SKEW_MS) return amadeusToken.value;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.transport.amadeusClientId,
    client_secret: config.transport.amadeusClientSecret,
  });
  const response = await fetchImpl(`${config.transport.amadeusBaseUrl}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`amadeus auth failed: ${response.status}`);
  const json = await response.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("amadeus auth returned no token");
  amadeusToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in) || 1800) * 1000,
  };
  return amadeusToken.value;
}

async function searchAmadeusFlights(input: TransportSearchInput, fetchImpl: typeof fetch): Promise<TransportOption[]> {
  if (!config.transport.amadeusClientId || !config.transport.amadeusClientSecret) return [];
  const mode = transportMode(input);
  if (mode !== "any" && mode !== "flight") return [];
  const origin = cityCode(input.from);
  const destination = cityCode(input.to);
  if (!origin || !destination || origin === destination) return [];
  const token = await amadeusAccessToken(fetchImpl);
  const params = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate: String(input.date || "").slice(0, 10),
    adults: String(Math.max(1, Math.min(9, Math.round(Number(input.people) || 1)))),
    currencyCode: "JPY",
    max: "3",
  });
  const response = await fetchImpl(`${config.transport.amadeusBaseUrl}/v2/shopping/flight-offers?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`amadeus flight search failed: ${response.status}`);
  const json = await response.json() as {
    data?: {
      id?: string;
      itineraries?: {
        duration?: string;
        segments?: {
          carrierCode?: string;
          number?: string;
          departure?: { iataCode?: string; at?: string };
          arrival?: { iataCode?: string; at?: string };
        }[];
      }[];
      price?: { grandTotal?: string; currency?: string };
    }[];
    dictionaries?: { carriers?: Record<string, string> };
  };
  return (json.data || []).slice(0, 3).flatMap((offer, index): TransportOption[] => {
    const itinerary = offer.itineraries?.[0];
    const segments = itinerary?.segments || [];
    const first = segments[0];
    const last = segments[segments.length - 1];
    const duration = parseDurationMinutes(itinerary?.duration);
    if (!first || !last || !duration) return [];
    const carrierCode = first.carrierCode || "";
    const carrier = json.dictionaries?.carriers?.[carrierCode] || carrierCode;
    const flightNumber = [carrierCode, first.number].filter(Boolean).join("");
    const price = offer.price?.grandTotal
      ? `${Math.round(Number(offer.price.grandTotal)).toLocaleString("ja-JP")} ${offer.price.currency || "JPY"}`
      : "";
    return [{
      id: `amadeus-${offer.id || index + 1}`,
      mode: "flight",
      provider: "amadeus",
      from: first.departure?.iataCode || origin,
      to: last.arrival?.iataCode || destination,
      departure_time: parseDateTime(first.departure?.at),
      arrival_time: parseDateTime(last.arrival?.at),
      duration_minutes: duration,
      price_label: price,
      carrier,
      service_name: flightNumber,
      flight_number: flightNumber,
      confidence: "live_offer",
      note: segments.length > 1 ? `${segments.length - 1}回乗継` : "直行または同一予約候補",
    }];
  });
}

function googleTravelMode(mode: TransportSearchInput["mode"]): "TRANSIT" | "DRIVE" | "WALK" {
  if (mode === "drive") return "DRIVE";
  if (mode === "walk") return "WALK";
  return "TRANSIT";
}

async function searchGoogleRoutes(input: TransportSearchInput, fetchImpl: typeof fetch): Promise<TransportOption[]> {
  if (!config.transport.googleRoutesApiKey) return [];
  const mode = transportMode(input);
  if (mode === "flight") return [];
  const travelMode = googleTravelMode(mode);
  const departureTime = departureDateTime(input);
  const response = await fetchImpl("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.transport.googleRoutesApiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.localizedValues,routes.legs.steps.travelMode,routes.legs.steps.transitDetails",
    },
    body: JSON.stringify({
      origin: { address: input.from },
      destination: { address: input.to },
      travelMode,
      languageCode: "ja",
      units: "METRIC",
      ...(departureTime ? { departureTime } : {}),
      ...(travelMode === "TRANSIT" ? {
        transitPreferences: { routingPreference: "FEWER_TRANSFERS" },
      } : {}),
    }),
  });
  if (!response.ok) throw new Error(`google routes failed: ${response.status}`);
  const json = await response.json() as {
    routes?: {
      duration?: string;
      distanceMeters?: number;
      localizedValues?: { duration?: { text?: string }; distance?: { text?: string } };
      legs?: { steps?: { travelMode?: string; transitDetails?: { transitLine?: { nameShort?: string; name?: string; vehicle?: { type?: string } } } }[] }[];
    }[];
  };
  return (json.routes || []).slice(0, 2).flatMap((route, index): TransportOption[] => {
    const duration = parseDurationMinutes(route.duration);
    if (!duration) return [];
    const transitLines = (route.legs || []).flatMap((leg) => leg.steps || [])
      .filter((step) => step.travelMode === "TRANSIT")
      .map((step) => step.transitDetails?.transitLine?.nameShort || step.transitDetails?.transitLine?.name || "")
      .filter(Boolean);
    const serviceName = transitLines.slice(0, 4).join(" / ");
    return [{
      id: `google-routes-${travelMode.toLowerCase()}-${index + 1}`,
      mode: travelMode === "DRIVE" ? "drive" : travelMode === "WALK" ? "walk" : "transit",
      provider: "google_routes",
      from: input.from,
      to: input.to,
      departure_time: departureTime,
      arrival_time: addMinutes(departureTime, duration),
      duration_minutes: duration,
      service_name: serviceName || undefined,
      confidence: "estimated",
      note: [
        route.localizedValues?.duration?.text || "",
        route.localizedValues?.distance?.text || (route.distanceMeters ? `${Math.round(route.distanceMeters / 1000)}km` : ""),
      ].filter(Boolean).join(" / "),
    }];
  });
}

export async function searchTransportOptions(
  input: TransportSearchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TransportSearchResult> {
  const normalized: TransportSearchInput = {
    from: String(input.from || "").trim().slice(0, 160),
    to: String(input.to || "").trim().slice(0, 160),
    date: String(input.date || "").slice(0, 10),
    time: String(input.time || "").slice(0, 5),
    mode: input.mode || "any",
    people: input.people,
  };
  if (!normalized.from || !normalized.to || !normalized.date) {
    return { options: [], warnings: ["from/to/date が不足しています"] };
  }
  const warnings: string[] = [];
  const results = await Promise.allSettled([
    searchAmadeusFlights(normalized, fetchImpl),
    searchGoogleRoutes(normalized, fetchImpl),
  ]);
  const options = results.flatMap((result) => {
    if (result.status === "fulfilled") return result.value;
    warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    return [];
  });
  return { options: options.slice(0, MAX_OPTIONS), warnings };
}

export async function transportOptionsForCities(
  cities: { name: string; from_date?: string; to_date?: string }[],
  people?: number,
): Promise<TransportOption[]> {
  const pairs = cities
    .filter((city) => city.name && city.name.trim())
    .slice(0, 8)
    .flatMap((city, index, list): TransportSearchInput[] => {
      const next = list[index + 1];
      if (!next) return [];
      const date = next.from_date || city.to_date || "";
      if (!date) return [];
      return [{ from: city.name, to: next.name, date, time: "09:00", mode: "any", people }];
    });
  const results = await Promise.allSettled(pairs.map((pair) => searchTransportOptions(pair)));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value.options : []).slice(0, 16);
}
