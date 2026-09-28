import type { ExpenseDetail, Settlement, TripInfo } from "./types";

export interface ExpenseSummaryInput {
  trip: Pick<TripInfo, "title" | "dates">;
  settlement: Settlement;
  generatedAt?: Date;
}

function safe(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[char] || char);
}

function dateLabel(value: string): string {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${Number(match[2])}/${Number(match[3])}` : value || "日付なし";
}

function generatedLabel(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function detailShares(detail: ExpenseDetail): string {
  const shares = detail.shares || [];
  if (!shares.length) return detail.mode === "精算不要" ? "精算不要" : "内訳なし";
  return shares.map((share) => `${share.name} ${share.amountLabel}`).join("、");
}

/** LINEやメールへそのまま貼れる、現在時点の費用・精算明細。 */
export function buildExpenseShareText(input: ExpenseSummaryInput): string {
  const { trip, settlement } = input;
  const transfers = settlement.transfers || [];
  const details = settlement.expenseDetails || [];
  const history = settlement.settlementHistory || [];
  const lines = [
    `【${trip.title || "旅行"}｜費用・精算明細】`,
    trip.dates ? `旅行期間: ${trip.dates}` : "",
    `費用総額: ${settlement.expenseTotal || "¥0"}`,
    `作成日時: ${generatedLabel(input.generatedAt || new Date())}`,
    "",
    "■ 現在の精算",
    ...(transfers.length
      ? transfers.map((transfer) => `・${transfer.from} → ${transfer.to}: ${transfer.amountLabel}`)
      : ["・現在、精算が必要な支払いはありません"]),
    "",
    `■ 費用内訳（${details.length}件）`,
    ...details.flatMap((detail) => [
      `・${dateLabel(detail.date)} ${detail.title || "費用"}: ${detail.convertedLabel || detail.amountLabel}`,
      `  支払: ${detail.payer || "不明"} / ${detail.mode || "分け方なし"}`,
      `  ${detail.isAdvance || detail.mode === "立て替え" ? "立替先" : "負担"}: ${detailShares(detail)}`,
    ]),
    ...(history.length ? [
      "",
      `■ 精算済み（${history.length}件）`,
      ...history.map((item) => `・${dateLabel(item.date)} ${item.from} → ${item.to}: ${item.amountLabel}`),
    ] : []),
    "",
    "※この明細は送信時点の記録です。送金後はアプリ内で精算完了を記録してください。",
  ];
  return lines.filter((line, index) => line || lines[index - 1] !== "").join("\n").trim();
}

function expenseHtml(detail: ExpenseDetail): string {
  const amount = detail.convertedLabel || detail.amountLabel || "-";
  const isAdvance = Boolean(detail.isAdvance || detail.mode === "立て替え");
  const shares = detail.shares || [];
  const sharesHtml = shares.length
    ? shares.map((share) => `<li><span>${safe(share.name)}</span><b>${safe(share.amountLabel)}</b></li>`).join("")
    : `<li><span>${detail.mode === "精算不要" ? "精算不要" : "内訳なし"}</span></li>`;
  return `<article class="expense">
    <header>
      <div><time>${safe(dateLabel(detail.date))}</time><h3>${safe(detail.title || "費用")}</h3>
        <p>${safe(detail.category || "その他")} · ${safe(detail.mode || "分け方なし")}</p></div>
      <strong>${safe(amount)}</strong>
    </header>
    <dl><div><dt>支払者</dt><dd>${safe(detail.payer || "不明")}</dd></div></dl>
    <div class="shares"><span>${isAdvance ? "立替先" : "負担内訳"}</span><ul>${sharesHtml}</ul></div>
  </article>`;
}

/** ブラウザの印刷画面からPDF保存するための、共有専用A4文書。 */
export function buildExpensePrintHtml(input: ExpenseSummaryInput): string {
  const { trip, settlement } = input;
  const transfers = settlement.transfers || [];
  const details = settlement.expenseDetails || [];
  const history = settlement.settlementHistory || [];
  const transferHtml = transfers.length
    ? transfers.map((transfer) => `<tr><td>${safe(transfer.from)}</td><td class="arrow">→</td><td>${safe(transfer.to)}</td><td class="money">${safe(transfer.amountLabel)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">現在、精算が必要な支払いはありません</td></tr>`;
  const historyHtml = history.length ? `<section><h2>精算済み <small>${history.length}件</small></h2>
    <table class="history"><tbody>${history.map((item) => `<tr><td>${safe(dateLabel(item.date))}</td><td>${safe(item.from)} → ${safe(item.to)}</td><td class="money">${safe(item.amountLabel)}</td></tr>`).join("")}</tbody></table></section>` : "";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${safe(trip.title || "旅行")} 費用・精算明細</title>
  <style>
    @page { size: A4; margin: 14mm 15mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #17231f; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; font-size: 10.5pt; line-height: 1.55; }
    .page-head { display: flex; justify-content: space-between; gap: 20px; align-items: end; padding: 0 0 10mm; border-bottom: 2px solid #0b5a42; }
    .eyebrow { margin: 0 0 2mm; color: #0b5a42; font-size: 8.5pt; font-weight: 700; letter-spacing: .12em; }
    h1 { margin: 0; font-size: 21pt; line-height: 1.25; }
    .period { margin: 2mm 0 0; color: #65716c; }
    .total { min-width: 42mm; padding: 4mm 5mm; background: #edf6f2; text-align: right; }
    .total span { display: block; color: #65716c; font-size: 8.5pt; }
    .total b { color: #0b5a42; font-size: 18pt; }
    section { margin-top: 8mm; break-inside: avoid; }
    h2 { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 3mm; padding-bottom: 2mm; border-bottom: 1px solid #cfd8d4; font-size: 12.5pt; }
    h2 small { color: #65716c; font-size: 8.5pt; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 2.6mm 2mm; border-bottom: 1px solid #e3e8e6; }
    .arrow { width: 10mm; color: #65716c; text-align: center; }
    .money { color: #0b5a42; font-weight: 700; text-align: right; white-space: nowrap; }
    .empty { color: #65716c; text-align: center; }
    .expenses { display: grid; gap: 3mm; }
    .expense { break-inside: avoid; padding: 4mm; border: 1px solid #d8dfdc; }
    .expense header { display: flex; justify-content: space-between; gap: 8mm; align-items: start; }
    .expense time { color: #65716c; font-size: 8.5pt; font-weight: 700; }
    .expense h3 { margin: .5mm 0 0; font-size: 12pt; }
    .expense header p { margin: .5mm 0 0; color: #65716c; font-size: 8.5pt; }
    .expense header > strong { color: #0b5a42; font-size: 13pt; white-space: nowrap; }
    dl { margin: 2.5mm 0 0; }
    dl div { display: flex; gap: 3mm; }
    dt, .shares > span { color: #65716c; font-size: 8.5pt; font-weight: 700; }
    dd { margin: 0; font-weight: 700; }
    .shares { display: grid; grid-template-columns: 18mm 1fr; gap: 3mm; margin-top: 2mm; padding-top: 2mm; border-top: 1px solid #edf0ef; }
    .shares ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1mm 5mm; margin: 0; padding: 0; list-style: none; }
    .shares li { display: flex; justify-content: space-between; gap: 4mm; }
    .shares li b { white-space: nowrap; }
    .history td:first-child { width: 22mm; color: #65716c; }
    footer { margin-top: 9mm; padding-top: 3mm; border-top: 1px solid #cfd8d4; color: #65716c; font-size: 8pt; }
    @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  </style></head><body>
    <header class="page-head"><div><p class="eyebrow">TABI PLAN · EXPENSE SUMMARY</p><h1>${safe(trip.title || "旅行")}</h1><p class="period">${safe(trip.dates || "日程未設定")} · ${safe(generatedLabel(input.generatedAt || new Date()))} 作成</p></div>
      <div class="total"><span>費用総額</span><b>${safe(settlement.expenseTotal || "¥0")}</b></div></header>
    <section><h2>現在の精算 <small>${transfers.length}件</small></h2><table><tbody>${transferHtml}</tbody></table></section>
    <section><h2>費用内訳 <small>${details.length}件</small></h2><div class="expenses">${details.map(expenseHtml).join("") || '<p class="empty">費用はまだありません</p>'}</div></section>
    ${historyHtml}
    <footer>この明細は送信時点の記録です。送金後はTabi Plan内で精算完了を記録してください。</footer>
  </body></html>`;
}
