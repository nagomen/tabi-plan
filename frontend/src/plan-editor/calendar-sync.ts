import type { ItineraryItem } from "../shared/types";
import { parseISO, mdOf } from "../shared/date";
import { gcalUrl, buildIcs, type CalEvent } from "../shared/calendar";
import { model } from "./editor-state";
import { gcalBtn, icsBtn, toast } from "./editor-dom";
import { buildData } from "./plan-data";

// ---- カレンダー連携（Google テンプレート / .ics） ----------------------

function fmtMd(iso: string): string {
  const d = parseISO(iso);
  return d ? mdOf(d) : "";
}

/** カレンダー予定の説明文: メンバー・訪問地に加え、日ごとの詳細を書き出す。 */
function tripDescription(): string {
  const data = buildData();
  const lines: string[] = [];
  if (model.members) lines.push(`メンバー: ${model.members}`);
  const cities = model.cities.map((c) => c.name).filter(Boolean);
  if (cities.length) lines.push(`訪問地: ${cities.join(" → ")}`);
  if (model.note) lines.push(model.note);

  const byDate = new Map<string, ItineraryItem[]>();
  (data.itinerary || []).forEach((it) => {
    const key = it.date || "";
    if (!key) return;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(it);
  });
  const dates = Array.from(byDate.keys()).sort();
  if (dates.length) {
    lines.push("", "【日程】");
    dates.forEach((d) => {
      const items = byDate.get(d)!;
      const area = items.map((it) => it.area).find(Boolean) || "";
      const dayLabel = items[0]?.day || "";
      lines.push(`■ ${[dayLabel, fmtMd(d), area].filter(Boolean).join(" ")}`);
      items.forEach((it) => {
        const head = [it.typeLabel, it.title].filter(Boolean).join(" ") || it.place || "予定";
        const place = it.place && it.place !== it.title ? `（${it.place}）` : "";
        const time = it.time ? `${it.time} ` : "";
        lines.push(`  ${time}${head}${place}`);
      });
    });
  }
  return lines.join("\n");
}

/** 旅行全体を1つの終日イベントとして組み立てる。期間未設定なら null。 */
function planSpanEvent(): CalEvent | null {
  const s = parseISO(model.startDate);
  if (!s) return null;
  const e = parseISO(model.endDate) || s;
  const start = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const endExclusive = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
  const cities = model.cities.map((c) => c.name).filter(Boolean);
  return { title: model.title || "旅行", start, end: endExclusive, allDay: true, details: tripDescription(), location: cities[0] || "" };
}

/** 各行程アイテムを時刻付きイベントにする（.ics 用）。 */
function itineraryEvents(): CalEvent[] {
  const data = buildData();
  const out: CalEvent[] = [];
  (data.itinerary || []).forEach((it) => {
    const d = parseISO(it.date);
    if (!d) return;
    const [hhRaw, mmRaw] = String(it.time || "").split(":");
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const title = [it.typeLabel, it.title || it.place].filter(Boolean).join(" ") || "予定";
    out.push({ title, start, end, allDay: false, location: it.place || it.mapQuery || "", details: it.note || "" });
  });
  return out;
}

export function updateCalsync(): void {
  const ok = Boolean(parseISO(model.startDate));
  gcalBtn.disabled = !ok;
  icsBtn.disabled = !ok;
}

export function onGcalClick(): void {
  const ev = planSpanEvent();
  if (!ev) { toast("先に期間を設定してください"); return; }
  window.open(gcalUrl(ev), "_blank", "noopener");
}

export function onIcsClick(): void {
  const span = planSpanEvent();
  if (!span) { toast("先に期間を設定してください"); return; }
  const ics = buildIcs(model.title || "旅行", [span, ...itineraryEvents()], new Date());
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (model.title || "trip").replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "") + ".ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("カレンダー(.ics)を書き出しました");
}
