// 行き先と日程から旅行計画の下書きを作る。
//
// OpenAI のキーはサーバーにだけ置く（静的サイトに出すと誰でも使えてしまう）。
// ブラウザからは /api/ai/itinerary を叩き、ここが代理で問い合わせる。
//
// 返す形は計画エディタのモデルにそのまま流し込めるようにしてある。
// 構造化出力（json_schema, strict）を使うので、壊れた JSON は返ってこない。

import { config } from "./config.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** 一度に作る日数の上限。長すぎる旅程は時間も費用もかさむので切る。 */
const MAX_DAYS = 14;

export interface ItineraryInput {
  area: string;
  startDate: string;
  endDate: string;
  note?: string;
  people?: number;
}

export interface ItineraryDraft {
  cities: { name: string; from_date: string; to_date: string }[];
  days: {
    date: string;
    area: string;
    items: { kind: string; time: string; title: string; place: string; note: string }[];
  }[];
}

const ITEM_KINDS = ["sight", "food", "move", "stay", "todo", "form"] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cities", "days"],
  properties: {
    cities: {
      type: "array",
      description: "訪問する都市・エリア。滞在順に並べる。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "from_date", "to_date"],
        properties: {
          name: { type: "string", description: "都市名。日本語。例: 仙台市" },
          from_date: { type: "string", description: "YYYY-MM-DD" },
          to_date: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "area", "items"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          area: { type: "string", description: "その日の中心となる都市名" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "time", "title", "place", "note"],
              properties: {
                kind: { type: "string", enum: ITEM_KINDS },
                time: { type: "string", description: "HH:MM。決めないときは空文字" },
                title: { type: "string", description: "予定の名前。日本語" },
                place: {
                  type: "string",
                  description: "地図で引ける具体的な地名や施設名。市区町村まで含める",
                },
                note: { type: "string", description: "一言メモ。不要なら空文字" },
              },
            },
          },
        },
      },
    },
  },
} as const;

function daysBetween(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw new Error("日程が正しくありません");
  }
  const out: string[] = [];
  for (let d = start; d <= end && out.length < MAX_DAYS; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function prompt(input: ItineraryInput, dates: string[]): string {
  const people = input.people && input.people > 0 ? `${input.people}人` : "人数の指定なし";
  return [
    `行き先: ${input.area}`,
    `日程: ${dates[0]} 〜 ${dates[dates.length - 1]}（全${dates.length}日）`,
    `対象の日付: ${dates.join(", ")}`,
    `人数: ${people}`,
    input.note ? `希望: ${input.note}` : "",
    "",
    "この条件で旅行の下書きを作ってください。守ること:",
    "- days は対象の日付ちょうどぶん、同じ順で作る。日付を飛ばさない。",
    "- 1日あたり3〜5件。移動の少ない、実際に回れる並びにする。",
    "- 昼と夜に food を1件ずつ入れる。最終日以外は宿泊(stay)を1日1件、最後に置く。",
    "- 都市をまたぐ日は move を入れ、title は「A → B」の形にする。",
    "- place は地図で引ける具体名にする（市区町村名まで入れる）。曖昧な「市内観光」は使わない。",
    "- 実在する場所だけを挙げる。自信のない施設名は出さない。",
    "- cities は滞在順に並べ、from_date と to_date で滞在期間を示す。",
    "- 文章は日本語。営業時間や料金など、変わりやすい情報は書かない。",
  ].filter(Boolean).join("\n");
}

/** 利用者ごとの実行間隔。有料APIなので連打で費用が伸びないようにする。 */
const lastRunAt = new Map<string, number>();
const COOLDOWN_MS = 20_000;

export function checkCooldown(userId: string): number {
  const last = lastRunAt.get(userId) || 0;
  const wait = COOLDOWN_MS - (Date.now() - last);
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

export async function generateItinerary(userId: string, input: ItineraryInput): Promise<ItineraryDraft> {
  if (!config.ai.apiKey) throw new Error("AI の設定がされていません");
  const area = String(input.area || "").trim();
  if (!area) throw new Error("行き先を入れてください");
  const dates = daysBetween(input.startDate, input.endDate);

  lastRunAt.set(userId, Date.now());
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [
        {
          role: "system",
          content: "あなたは旅行の行程を組むプランナーです。実在する場所だけを、日本語で簡潔に挙げます。",
        },
        { role: "user", content: prompt({ ...input, area }, dates) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "itinerary", strict: true, schema: SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`AI の呼び出しに失敗しました (${response.status}) ${text.slice(0, 200)}`);
  }
  const data = await response.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI から結果が返りませんでした");
  const draft = JSON.parse(content) as ItineraryDraft;

  // 念のため、頼んだ日付だけに揃える（多い日・知らない日を落とす）
  const allowed = new Set(dates);
  draft.days = (draft.days || []).filter((day) => allowed.has(day.date));
  draft.cities = (draft.cities || []).filter((city) => city.name && city.name.trim());
  return draft;
}
