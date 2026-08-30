// 旅程を LINE などにそのまま貼れるプレーンテキストへ整形する。
// マークダウンは解釈されない前提で、記号と改行だけで読みやすくする。

import { WEEKDAYS } from "./date";
import type { ItineraryItem, TripInfo } from "./types";

/** buildItineraryShareText が必要とする1日分の最小形（dashboard の DayGroup 互換）。 */
export interface ShareDay {
  date: string;
  day: string;
  area?: string;
  items: ItineraryItem[];
}

/** "2026-08-01" → "8/1(金)"。パースできなければ元文字列を返す。 */
function dateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!match) return String(iso || "").trim();
  const month = Number(match[2]);
  const dayNum = Number(match[3]);
  const weekday = WEEKDAYS[new Date(Number(match[1]), month - 1, dayNum).getDay()];
  return `${month}/${dayNum}(${weekday})`;
}

/** 1つの予定を1行に。時刻・タイトル・場所を「なければ省く」形で連結する。 */
function itemLine(item: ItineraryItem): string {
  const time = String(item.time || "").trim();
  const title = String(item.title || item.typeLabel || "").trim();
  const place = String(item.place || "").trim();
  if (!title && !place) return "";
  let line = time ? `${time} ` : "";
  line += title || place;
  if (place && place !== title) line += `＠${place}`;
  return line.trim();
}

/**
 * 旅程全体を LINE 送付用テキストへ整形する。
 * 予定のない日は見出しだけ出し、全日空なら空文字を返す（呼び出し側で「日程なし」を判定できる）。
 */
export function buildItineraryShareText(trip: Partial<TripInfo> | undefined, days: ShareDay[]): string {
  const title = String(trip?.title || "旅行").trim();
  const dates = String(trip?.dates || "").trim();
  const members = String(trip?.members || "").trim();

  const blocks: string[] = [];
  let hasAnyItem = false;

  days.forEach((day, index) => {
    const lines = (day.items || [])
      .map(itemLine)
      .filter(Boolean);
    if (lines.length) hasAnyItem = true;

    const headParts = [day.day || `Day ${index + 1}`, dateLabel(day.date), day.area || ""]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    const head = `■ ${headParts.join(" ")}`;
    blocks.push([head, ...(lines.length ? lines : ["（予定は未定）"])].join("\n"));
  });

  if (!hasAnyItem) return "";

  const header = [`🧳 ${title}`, dates ? `📅 ${dates}` : "", members ? `👥 ${members}` : ""]
    .filter(Boolean)
    .join("\n");

  return `${header}\n\n${blocks.join("\n\n")}\n`;
}
