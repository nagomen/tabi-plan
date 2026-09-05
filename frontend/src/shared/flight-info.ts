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

export interface TrainSegment {
  time: string;
  station: string;
}

export interface TrainInfo {
  /** 列車名・便名（例: のぞみ23号 / G1602 / 自強号）。取れなければ transport の代表名。 */
  serviceName: string;
  dep: TrainSegment | null;
  arr: TrainSegment | null;
  /** 指定席・自由席・座席番号など。入力が無ければ空。 */
  seat: string;
  /** 列車名・座席など、カードで見せる情報を除いた補足メモ。 */
  restNote: string;
}

/** 便名らしきパターン。数字の後に「:」等が続くもの（時刻）は除外する。 */
const FLIGHT_NO_RE = /\b([A-Z]{2,3})\s?(\d{1,4})(?![:\d])/;
/** 航空文脈の語。誤検出を避けるため、これが無い予定は飛行機として扱わない。 */
const AVIATION_RE = /空港|飛行機|フライト|航空|airport|airlines?|airways|flight/i;
/** transport が明示的に非航空なら、note に便名があっても航空券カード化しない。 */
const FLIGHT_TRANSPORT_RE = /飛行機|フライト|航空|airlines?|airways|flight/i;
const TRAIN_TRANSPORT_RE = /新幹線|高鉄|高速鉄道|特急|急行|自強号?|普悠瑪|太魯閣|台湾鉄路|台鉄|臺鐵|JR|Shinkansen|HSR|High Speed Rail|Airport Express|Railway|Railroad|Train/i;
const NON_TRAIN_TRANSPORT_RE = /飛行機|航空|フライト|バス|フェリー|船|タクシー|徒歩|レンタカー|自動車|車移動|MRT|地下鉄/i;
const TRAIN_SERVICE_RE = /(?:のぞみ|ひかり|こだま|みずほ|さくら|はやぶさ|はやて|やまびこ|なすの|つばさ|こまち|かがやき|はくたか|あさま|とき|たにがわ|つるぎ|サンダーバード|しらさぎ|成田エクスプレス|N'?EX|自強号?|普悠瑪|太魯閣)\s*\d{0,4}\s*号?|[GCDZ]\s?\d{1,4}|[A-Z]{1,3}\s?\d{1,4}\s*号/i;
const TRAIN_SEAT_RE = /(グランクラス|グリーン車|普通車指定席|普通車自由席|指定席|自由席|商務座|一等座|二等座|無座)(?:\s*[0-9０-９]+(?:号車|車))?(?:\s*[A-ZＡ-Ｚ]?[0-9０-９]+[A-ZＡ-Ｚ]?|\s*[0-9０-９]+[A-ZＡ-Ｚ]?)?/;

const DEP_RE = /(?:([A-Z]{3})\s*(\d{1,2}:\d{2})|(\d{1,2}:\d{2})\s*([A-Z]{3}))\s*発/;
const ARR_RE = /(?:([A-Z]{3})\s*(\d{1,2}:\d{2})|(\d{1,2}:\d{2})\s*([A-Z]{3}))\s*着/;
const TRAIN_DEP_RE = /(?:(\d{1,2}:\d{2})\s*([^、/→]+?)\s*発|([^、/→]+?)\s*(\d{1,2}:\d{2})\s*発)/;
const TRAIN_ARR_RE = /(?:(\d{1,2}:\d{2})\s*([^、/→]+?)\s*着|([^、/→]+?)\s*(\d{1,2}:\d{2})\s*着)/;

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
  time?: string;
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

function trainSegmentFrom(match: RegExpMatchArray | null): TrainSegment | null {
  if (!match) return null;
  const time = match[1] || match[4] || "";
  const station = (match[2] || match[3] || "").trim();
  return time && station ? { time, station } : null;
}

function cleanTrainService(value: string): string {
  return value
    .replace(TRAIN_SEAT_RE, "")
    .replace(/\s*[,/|]\s*$/, "")
    .trim();
}

/** 予定から鉄道情報を読み取る。個人の座席入力は任意で、無ければ席表示を省略する。 */
export function parseTrain(source: FlightSource): TrainInfo | null {
  const transport = String(source.transport || "").trim();
  const note = String(source.note || "").trim();
  if (!transport || NON_TRAIN_TRANSPORT_RE.test(transport) || !TRAIN_TRANSPORT_RE.test(transport)) return null;

  const context = [transport, note, source.title, source.origin, source.destination]
    .map((part) => String(part || "")).join(" / ");
  const serviceMatch = context.match(TRAIN_SERVICE_RE);
  const serviceName = cleanTrainService(serviceMatch?.[0] || transport);
  if (!serviceName) return null;

  const dep = trainSegmentFrom(context.match(TRAIN_DEP_RE)) ||
    (source.time && source.origin ? { time: source.time, station: source.origin } : null);
  const arr = trainSegmentFrom(context.match(TRAIN_ARR_RE)) ||
    (source.destination ? { time: "", station: source.destination } : null);
  const seat = (context.match(TRAIN_SEAT_RE)?.[0] || "").trim();
  const compactService = serviceName.replace(/\s+/g, "");
  const compactSeat = seat.replace(/\s+/g, "");
  const restNote = note
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const compact = part.replace(/\s+/g, "");
      if (compactService && compact.includes(compactService)) return false;
      if (compactSeat && compact.includes(compactSeat)) return false;
      if ((dep || arr) && /発|着/.test(part) && (TRAIN_DEP_RE.test(part) || TRAIN_ARR_RE.test(part))) return false;
      if (/^所要/.test(part)) return false;
      return true;
    })
    .join(" / ");

  return { serviceName, dep, arr, seat, restNote };
}
