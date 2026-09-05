// 移動が「飛行機」のとき、便名・航空会社・発着（時刻＋空港コード）を
// 予定データの文字列から読み取る純ロジック。DB・DOM に依存しない。
//
// AI生成の行程は transport と note に同じ便情報を重複して書きがちなので
// （例: transport「Hong Kong Express UO857」/ note「… UO857 / 08:00 NRT発、11:55 HKG着 / 所要…」）、
// 表示側が構造化して1回だけ見せられるよう、残りの補足メモ（restNote）も返す。

export interface FlightSegment {
  time: string; // "08:00"
  code: string; // "NRT"
}

export interface FlightInfo {
  /** 便名（例: UO857）。スペースは詰める。 */
  flightNo: string;
  /** 航空会社名。便名の直前の文字列から取れたときだけ。 */
  airline: string;
  dep: FlightSegment | null;
  arr: FlightSegment | null;
  /** 便名・発着・所要時間の重複を除いた、残りの補足メモ。 */
  restNote: string;
}

/** 便名らしきパターン。数字の後に「:」等が続くもの（時刻）は除外する。 */
const FLIGHT_NO_RE = /\b([A-Z]{2,3})\s?(\d{1,4})(?![:\d])/;
/** 航空文脈の語。誤検出を避けるため、これが無い予定は飛行機として扱わない。 */
const AVIATION_RE = /空港|飛行機|フライト|航空|airport|airlines?|airways|flight/i;
/** transport が明示的に非航空なら、note に便名があっても航空券カード化しない。 */
const FLIGHT_TRANSPORT_RE = /飛行機|フライト|航空|airlines?|airways|flight/i;

const DEP_RE = /(?:([A-Z]{3})\s*(\d{1,2}:\d{2})|(\d{1,2}:\d{2})\s*([A-Z]{3}))\s*発/;
const ARR_RE = /(?:([A-Z]{3})\s*(\d{1,2}:\d{2})|(\d{1,2}:\d{2})\s*([A-Z]{3}))\s*着/;

function segmentFrom(match: RegExpMatchArray | null): FlightSegment | null {
  if (!match) return null;
  const code = match[1] || match[4] || "";
  const time = match[2] || match[3] || "";
  return code && time ? { code, time } : null;
}

export interface FlightSource {
  transport?: string;
  note?: string;
  title?: string;
  origin?: string;
  destination?: string;
}

/** 予定から便情報を読み取る。飛行機と判断できなければ null（従来表示のまま）。 */
export function parseFlight(source: FlightSource): FlightInfo | null {
  const transport = String(source.transport || "");
  const note = String(source.note || "");
  const transportHasFlightNo = FLIGHT_NO_RE.test(transport);
  const transportAllowsFlight = !transport.trim() || transportHasFlightNo || FLIGHT_TRANSPORT_RE.test(transport);
  if (!transportAllowsFlight) return null;
  const context = [transport, note, source.title, source.origin, source.destination]
    .map((part) => String(part || "")).join(" / ");
  if (!AVIATION_RE.test(context)) return null;

  // 便名は transport を優先し、無ければ note から拾う。
  const host = transportHasFlightNo ? transport : note;
  const match = host.match(FLIGHT_NO_RE);
  if (!match) return null;
  const flightNo = `${match[1]}${match[2]}`;

  // 便名の直前までを航空会社名とみなす（「Hong Kong Express UO857」→「Hong Kong Express」）。
  const airline = host.slice(0, match.index ?? 0).replace(/[\s・/|,\-]+$/, "").trim();

  const dep = segmentFrom(context.match(DEP_RE));
  const arr = segmentFrom(context.match(ARR_RE));

  // note から、構造化して見せる情報と重複する断片を除く。
  const restNote = note
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      if (part.replace(/\s+/g, "").includes(flightNo)) return false;
      if ((dep || arr) && /発|着/.test(part) && (DEP_RE.test(part) || ARR_RE.test(part))) return false;
      if (/^所要/.test(part)) return false;
      return true;
    })
    .join(" / ");

  return { flightNo, airline, dep, arr, restNote };
}
