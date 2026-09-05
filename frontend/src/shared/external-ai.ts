import type {
  ItineraryAiBaseInput,
  ItineraryAiPreferences,
  ItineraryOptions,
  ItineraryRefineCity,
  ItineraryRefineItem,
  ItineraryRefineMember,
} from "./db";
import type { ItineraryItem, RouteCity } from "./types";

export type ExternalAiProvider = "chatgpt" | "gemini";

const PROVIDER_URLS: Record<ExternalAiProvider, string> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
};

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function itineraryItemForExternalAi(item: ItineraryItem): Record<string, unknown> {
  return {
    date: item.date || "",
    time: item.time || "",
    kind: item.type || "sight",
    city: item.area || "",
    title: item.title || "",
    place: item.place || "",
    address: item.mapQuery || "",
    latitude: item.lat ?? null,
    longitude: item.lng ?? null,
    note: item.note || "",
    from_place: item.origin || "",
    to_place: item.destination || "",
    transport: item.transport || "",
    duration: item.duration || "",
    members: Array.isArray(item.members) ? item.members : [],
  };
}

function routeCityForExternalAi(city: RouteCity): ItineraryRefineCity {
  return {
    name: String(city.name || ""),
    from_date: String(city.fromDate || ""),
    to_date: String(city.toDate || ""),
  };
}

const OUTPUT_SCHEMA = {
  trip: { title: "string", start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" },
  cities: [{ name: "string", from_date: "YYYY-MM-DD", to_date: "YYYY-MM-DD" }],
  itinerary: [{
    date: "YYYY-MM-DD",
    time: "HH:MM。宿泊だけ空文字可",
    kind: "sight | move | food | stay | todo | form",
    city: "この予定を実施する都市。moveは到着都市",
    title: "string",
    place: "string",
    address: "string",
    latitude: "number | null",
    longitude: "number | null",
    note: "string",
    from_city: "moveの出発都市。move以外は空文字",
    from_place: "string",
    from_address: "string",
    from_latitude: "number | null",
    from_longitude: "number | null",
    to_city: "moveの到着都市。move以外は空文字",
    to_place: "string",
    to_address: "string",
    to_latitude: "number | null",
    to_longitude: "number | null",
    transport: "電車 | 新幹線 | 飛行機 | 車 | バス | フェリー | 徒歩 | その他",
    duration_minutes: "integer",
    members: ["対象メンバーuser_id。全員参加は空配列"],
  }],
};

export function buildExternalAiCreatePrompt(input: {
  base: ItineraryAiBaseInput | null;
  title: string;
  members: string;
  selectedCandidates?: ItineraryOptions["candidates"];
  preferences?: ItineraryAiPreferences;
}): string {
  const base = input.base;
  return [
    "あなたは旅行計画作成アシスタントです。以下の条件で、実行可能な旅行計画をJSONだけで出力してください。",
    "説明文、Markdown、コードフェンスは不要です。JSONオブジェクトだけを返してください。",
    "",
    "守ること:",
    "- 全日程を日付順に作る。",
    "- 複数都市の日は、観光と移動を実際の順番で交互に置く。移動だけを先頭へまとめない。",
    "- moveは出発地・到着地・交通手段・所要時間を入れ、到着前に次の予定を置かない。",
    "- 場所と移動は実在性を確認し、不明な座標はnullにする。",
    "- 時刻表・料金は断定しすぎず、必要なら要確認とnoteに書く。",
    "",
    `旅行名: ${input.title || base?.area || "旅行計画"}`,
    `期間: ${base?.start_date || ""}〜${base?.end_date || ""}`,
    `エリア: ${base?.area || ""}`,
    `人数: ${base?.people || ""}`,
    `メンバー: ${input.members || ""}`,
    `メモ: ${base?.note || ""}`,
    `登録済み訪問地: ${compactJson(base?.cities || [])}`,
    `選択済み候補: ${compactJson(input.selectedCandidates || [])}`,
    `希望条件: ${compactJson(input.preferences || {})}`,
    "",
    `出力JSONスキーマ例: ${compactJson(OUTPUT_SCHEMA)}`,
  ].join("\n");
}

export function buildExternalAiRefinePrompt(input: {
  title: string;
  startDate: string;
  endDate: string;
  instruction: string;
  cities: RouteCity[] | ItineraryRefineCity[];
  members: ItineraryRefineMember[];
  currentItinerary: ItineraryItem[] | ItineraryRefineItem[];
}): string {
  const cities = input.cities.map((city) =>
    "fromDate" in city ? routeCityForExternalAi(city) : city
  );
  const currentItinerary = input.currentItinerary.map((item) =>
    "kind" in item ? item : itineraryItemForExternalAi(item)
  );
  return [
    "あなたは既存の旅行計画を修正するアシスタントです。以下の依頼を反映し、旅行全体の完全な行程をJSONだけで出力してください。",
    "説明文、Markdown、コードフェンスは不要です。JSONオブジェクトだけを返してください。",
    "",
    "守ること:",
    "- 依頼で触れていない日・予定は維持する。",
    "- 全日程を日付順に作る。",
    "- 複数都市の日は、観光と移動を実際の順番で交互に置く。移動だけを先頭へまとめない。",
    "- moveは出発地・到着地・交通手段・所要時間を入れ、到着前に次の予定を置かない。",
    "- 参加期間外のメンバーをmembersへ入れない。全員参加予定はmembersを空配列にする。",
    "- 具体的な便名・出発時刻・到着時刻がある移動は、依頼がない限り削除・変更しない。",
    "- 場所と移動は実在性を確認し、不明な座標はnullにする。",
    "",
    `旅行名: ${input.title || "旅行計画"}`,
    `期間: ${input.startDate}〜${input.endDate}`,
    `今回の依頼: ${input.instruction}`,
    `登録済み訪問地: ${compactJson(cities)}`,
    `参加メンバーと参加期間: ${compactJson(input.members)}`,
    `現在の全行程: ${compactJson(currentItinerary)}`,
    "",
    `出力JSONスキーマ例: ${compactJson(OUTPUT_SCHEMA)}`,
  ].join("\n");
}

export async function copyExternalAiPrompt(prompt: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch {
    window.prompt("外部AIへ貼り付けるプロンプトをコピーしてください", prompt);
    return false;
  }
}

export function openExternalAi(provider: ExternalAiProvider = "chatgpt"): Window | null {
  return window.open(PROVIDER_URLS[provider], "_blank", "noopener");
}
