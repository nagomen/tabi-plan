/** AI旅程の初回生成（ai-itinerary）と会話修正（ai-itinerary-refine）で共有する正規化・検証。 */
import { AiOutputError } from "./ai-errors.js";

export function normalizedPlaceName(value: string): string {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "");
}

/** 「盛岡」と「盛岡市」のように行政区分だけ補われた都市名を同一視する。 */
export function cityNamesEquivalent(left: string, right: string): boolean {
  const exactLeft = normalizedPlaceName(left);
  const exactRight = normalizedPlaceName(right);
  if (!exactLeft || !exactRight) return false;
  if (exactLeft === exactRight) return true;
  const cityKey = (value: string): string => normalizedPlaceName(value)
    .replace(/[・･,，.。'’"“”()（）\[\]＿_\-—–]/gu, "")
    .replace(/^.+?[都道府県](?=.+)/u, "")
    .replace(/(?:prefecture|city|ward|town|village)$/u, "")
    .replace(/[都道府県市区町村]$/u, "");
  const leftKey = cityKey(left);
  const rightKey = cityKey(right);
  return Boolean(leftKey) && leftKey === rightKey;
}

export function strictTimeMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// ---- 1日の行程検証 --------------------------------------------------------
// 初回生成とチャット修正は入力の形が違うが、「同時刻の予定を置かない」「移動の
// 到着前に次を始めない」「移動は現在地から出発する」「予定はその時点の滞在都市に
// 置く」という業務ルールは同一。ここに1実装だけ持ち、分裂によるルールの
// 食い違い（過去に実際に文言・許容手段がずれた）を防ぐ。

export interface ScheduleEvent {
  /** strictTimeMinutes で検証済みの開始時刻（分）。 */
  minutes: number;
  /** エラー文言に使う表示名（タイトルか場所名）。 */
  label: string;
  /** 都市間・都市内の移動のときだけ設定する。 */
  move?: {
    fromCity: string;
    toCity: string;
    durationMinutes: number;
    /** 移動を確定する直前の追加検証（訪問順の照合など）。 */
    onCommit?: () => void;
  };
  /** move 以外の実施都市。 */
  city?: string;
}

/** 同じ開始時刻の予定（移動含む）を拒否する。events は時刻昇順であること。 */
export function assertDistinctStartTimes(date: string, events: ScheduleEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].minutes === events[index].minutes) {
      throw new AiOutputError(`${date}に同じ開始時刻の予定があります。移動を含め、実行順が分かる別々の時刻にしてください`);
    }
  }
}

/**
 * 時刻昇順の1日の予定を、現在都市を追跡しながら検証する。
 * 検証後の最終滞在都市名を返す（宿泊の検証と翌日への引き継ぎに使う）。
 */
export function walkDaySchedule(date: string, events: ScheduleEvent[], initialCity = ""): string {
  let currentCity = initialCity;
  let unavailableUntil = 0;
  for (const event of events) {
    if (event.minutes < unavailableUntil) {
      throw new AiOutputError(`${date}の「${event.label}」が直前の移動の到着前に始まります`);
    }
    if (event.move) {
      if (!currentCity) currentCity = event.move.fromCity;
      if (!cityNamesEquivalent(currentCity, event.move.fromCity)) {
        throw new AiOutputError(`${date}の移動「${event.label}」が現在地${currentCity}から始まっていません`);
      }
      event.move.onCommit?.();
      currentCity = event.move.toCity;
      unavailableUntil = event.minutes + Math.max(0, event.move.durationMinutes);
      continue;
    }
    if (!currentCity) currentCity = event.city || "";
    if (event.city && !cityNamesEquivalent(currentCity, event.city)) {
      throw new AiOutputError(`${date}の「${event.label}」は${currentCity}滞在中の時刻ですが、${event.city}の予定になっています`);
    }
  }
  return currentCity;
}

/** 宿泊はその日の最終到着都市にあること。finalCity が未確定なら最初の宿泊都市を採用する。 */
export function assertStaysInFinalCity(
  date: string,
  stays: { city: string }[],
  finalCity: string,
): string {
  let city = finalCity;
  for (const stay of stays) {
    if (!city) city = stay.city;
    if (!cityNamesEquivalent(city, stay.city)) {
      throw new AiOutputError(`${date}の宿泊先が最終到着都市${city}にありません`);
    }
  }
  return city;
}
