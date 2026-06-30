// 天気の自動取得（Open-Meteo / APIキー不要・無料）。
// 行程の緯度経度と日付から、その日の天気（絵文字・最高/最低気温）を取得する。
// 予報は概ね16日先まで。範囲外の日付や取得失敗時は null を返す（手入力の weather を優先表示に使える）。
//
// 結果は localStorage に短時間キャッシュし、同じ日・同じ地点の再取得を抑える。

export interface DayWeather {
  date: string;
  code: number;
  emoji: string;
  label: string;
  tMax: number;
  tMin: number;
}

const CACHE_PREFIX = "trip-weather-";
const TTL_HIT = 3 * 60 * 60 * 1000; // 取得できた日は3時間
const TTL_MISS = 30 * 60 * 1000; // 取れなかった日は30分（後で予報が出ることがある）

interface CacheEntry {
  at: number;
  w: DayWeather | null;
}

// WMO weather code → 絵文字・ラベル
function describe(code: number): { emoji: string; label: string } {
  if (code === 0) return { emoji: "☀️", label: "快晴" };
  if (code === 1) return { emoji: "🌤️", label: "晴れ" };
  if (code === 2) return { emoji: "⛅", label: "晴れ時々曇り" };
  if (code === 3) return { emoji: "☁️", label: "曇り" };
  if (code === 45 || code === 48) return { emoji: "🌫️", label: "霧" };
  if (code >= 51 && code <= 57) return { emoji: "🌦️", label: "霧雨" };
  if (code >= 61 && code <= 67) return { emoji: "🌧️", label: "雨" };
  if (code >= 71 && code <= 77) return { emoji: "🌨️", label: "雪" };
  if (code >= 80 && code <= 82) return { emoji: "🌧️", label: "にわか雨" };
  if (code === 85 || code === 86) return { emoji: "🌨️", label: "にわか雪" };
  if (code >= 95) return { emoji: "⛈️", label: "雷雨" };
  return { emoji: "🌡️", label: "" };
}

function toNum(value: number | string | undefined): number | null {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100; // 約1km粒度。近い地点はキャッシュを共有
}

function cacheKey(lat: number, lng: number, date: string): string {
  return `${CACHE_PREFIX}${round(lat)},${round(lng)},${date}`;
}

function readCache(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    const ttl = entry.w ? TTL_HIT : TTL_MISS;
    if (Date.now() - entry.at > ttl) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(key: string, w: DayWeather | null): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), w } satisfies CacheEntry));
  } catch {
    /* ignore quota */
  }
}

const inflight = new Map<string, Promise<DayWeather | null>>();

/** 指定地点・指定日の天気を返す。範囲外・失敗時は null。 */
export function fetchDayWeather(
  lat: number | string | undefined,
  lng: number | string | undefined,
  date: string,
): Promise<DayWeather | null> {
  const la = toNum(lat);
  const ln = toNum(lng);
  if (la == null || ln == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Promise.resolve(null);
  }
  const key = cacheKey(la, ln, date);
  const cached = readCache(key);
  if (cached) return Promise.resolve(cached.w);
  const existing = inflight.get(key);
  if (existing) return existing;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${ln}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto` +
    `&start_date=${date}&end_date=${date}`;

  const task = fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown) => {
      const daily = (json as { daily?: Record<string, unknown[]> } | null)?.daily;
      const code = daily?.weather_code?.[0];
      if (daily == null || code == null) {
        writeCache(key, null);
        return null;
      }
      const c = Number(code);
      const { emoji, label } = describe(c);
      const w: DayWeather = {
        date,
        code: c,
        emoji,
        label,
        tMax: Math.round(Number(daily.temperature_2m_max?.[0] ?? NaN)),
        tMin: Math.round(Number(daily.temperature_2m_min?.[0] ?? NaN)),
      };
      writeCache(key, w);
      return w;
    })
    .catch(() => {
      writeCache(key, null);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}

/** 表示用の短い文字列（例: "☀️ 28°/19°"）。 */
export function weatherLabel(w: DayWeather): string {
  const temp =
    Number.isFinite(w.tMax) && Number.isFinite(w.tMin) ? ` ${w.tMax}°/${w.tMin}°` : "";
  return `${w.emoji}${temp}`;
}
