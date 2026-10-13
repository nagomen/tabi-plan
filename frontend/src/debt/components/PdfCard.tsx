import { useState } from "react";
import { post } from "../api";
import { describe } from "../errors";
import { normalizePdf } from "../normalize";
import { savePdf } from "../pdf";
import { Icon } from "./Icon";

export function PdfCard({ token, manage }: { token: string; manage: boolean }) {
  const [busy, setBusy] = useState(false);

  const download = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      savePdf(normalizePdf(await post(manage ? "/api/debt/manage/pdf" : "/api/debt/share/pdf", { token })));
    } catch (error) {
      const problem = describe(error, "PDFを取得できませんでした。");
      const wait = problem.retryAfter ? `（${problem.retryAfter}秒ほど待ってから）` : "";
      alert(`${problem.message}${problem.retryable && wait ? `\n${wait}もう一度お試しください。` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="dn-pdf" id="pdf" aria-labelledby="dn-pdf-title">
      <Icon name="documentText" className="dn-ic dn-pdf-mark" />
      <div className="dn-pdf-copy">
        <p className="dn-pdf-eyebrow">DOCUMENT / PDF</p>
        <h2 id="dn-pdf-title">返済計画書（PDF）</h2>
        <p className="dn-pdf-desc">この画面と同じ内容（借入条件、毎月の返済予定、進路別プラン、収支計画、計画書）をA4にまとめています。</p>
        <ul className="dn-pdf-meta" aria-label="PDFの内容">
          <li>A4・印刷用</li><li>個人情報非表示</li><li>画面と同じ最新の内容</li>
        </ul>
      </div>
      <div className="dn-pdf-action">
        <button className="dn-pdf-button" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void download()}>
          <Icon name="arrowDownTray" /><span>{busy ? "PDFを準備中…" : "PDFをダウンロード"}</span>
        </button>
        <small className="dn-pdf-file">repayment_plan_final.pdf</small>
      </div>
    </aside>
  );
}
