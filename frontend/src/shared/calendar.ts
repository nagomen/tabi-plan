// カレンダー連携。サーバー無しで動く2方式:
//  1) Google カレンダーのテンプレートURL（認証不要・ワンクリックで追加）
//  2) .ics 書き出し（Google/Apple など任意のカレンダーにインポート）

export interface CalEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  details?: string;
  location?: string;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function ymd(d: Date): string { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function ymdhms(d: Date): string { return `${ymd(d)}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Google カレンダー「予定を作成」テンプレートURL（all-day は終了日が排他的）。 */
export function gcalUrl(ev: CalEvent): string {
  const dates = ev.allDay ? `${ymd(ev.start)}/${ymd(ev.end)}` : `${ymdhms(ev.start)}/${ymdhms(ev.end)}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates });
  if (ev.details) params.set("details", ev.details);
  if (ev.location) params.set("location", ev.location);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

function icsEscape(value: string | undefined): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** 複数イベントを1つの .ics（VCALENDAR）にまとめる。 */
export function buildIcs(calName: string, events: CalEvent[], now: Date): string {
  const stamp = utcStamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tabi-plan//JP",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(calName)}`,
  ];
  events.forEach((ev, i) => {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:trip-${i}-${ymd(ev.start)}-${i}@tabi-plan`);
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${ymd(ev.start)}`);
      lines.push(`DTEND;VALUE=DATE:${ymd(ev.end)}`);
    } else {
      lines.push(`DTSTART:${ymdhms(ev.start)}`);
      lines.push(`DTEND:${ymdhms(ev.end)}`);
    }
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.details) lines.push(`DESCRIPTION:${icsEscape(ev.details)}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
