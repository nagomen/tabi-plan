import { displayDate, yen } from "../format";
import type { DebtDocument } from "../normalize";
import { Icon } from "./Icon";

/** 03 借入・返済計画書。原本PDFの内容を、書類として読める順（債務→約束→担保・誓約→結び）で示す。 */
export function DocumentSection({ documentData }: { documentData: DebtDocument }) {
  const total = documentData.existing_debts.reduce((sum, debt) => sum + debt.amount_yen, 0);
  return (
    <section className="dn-section dn-document" id="document">
      <div className="dn-section-head">
        <div><p className="dn-section-no">03</p><h2>借入・返済計画書</h2></div>
        <span className="dn-pd-date"><Icon name="documentText" />提出日 {displayDate(documentData.submitted_on)}</span>
      </div>
      <p className="dn-pd-intro">現在の債務を整理し、責任を持って返済するための計画書です。原本PDFと同じ内容を画面でも確認できます。</p>

      <section className="dn-subcard dn-pd-debts" aria-labelledby="dn-pd-debts-title">
        <h3 id="dn-pd-debts-title"><Icon name="banknotes" />借入希望額・現在の債務</h3>
        <div className="dn-pd-debts-body">
          <p className="dn-pd-income"><span>現在の月収</span><strong>約{yen.format(documentData.monthly_income_yen)}</strong></p>
          <dl className="dn-pd-ledger">
            {documentData.existing_debts.map((debt, index) => (
              <div key={`${debt.creditor}-${index}`}><dt>{debt.creditor}</dt><dd>{yen.format(debt.amount_yen)}</dd></div>
            ))}
            <div className="is-total"><dt>債務の合計</dt><dd>{yen.format(total)}</dd></div>
          </dl>
        </div>
        {documentData.difference_note && <p className="dn-pd-note">{documentData.difference_note}</p>}
      </section>

      <section className="dn-subcard dn-pd-promises" aria-labelledby="dn-pd-promises-title">
        <h3 id="dn-pd-promises-title"><Icon name="checkCircle" />返済に関するお願いと約束</h3>
        <ol>
          {documentData.promises.map((promise, index) => (
            <li key={index}>
              <span className="dn-pd-no">{String(index + 1).padStart(2, "0")}</span>
              <div><h4>{promise.title}</h4><p>{promise.body}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <div className="dn-pd-pair">
        <section className="dn-subcard dn-pd-collateral" aria-labelledby="dn-pd-collateral-title">
          <h3 id="dn-pd-collateral-title"><Icon name="informationCircle" />担保について</h3>
          <p>{documentData.collateral_note}</p>
        </section>
        <section className="dn-subcard dn-pd-pledge" aria-labelledby="dn-pd-pledge-title">
          <h3 id="dn-pd-pledge-title"><Icon name="shieldCheck" />ギャンブルをしない誓約</h3>
          <p>{documentData.gambling_pledge}</p>
        </section>
      </div>

      <figure className="dn-pd-closing">
        <blockquote><p>{documentData.closing_note}</p></blockquote>
        <figcaption>提出日 <time>{displayDate(documentData.submitted_on)}</time></figcaption>
      </figure>
    </section>
  );
}
