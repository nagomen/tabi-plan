import { displayDate, yen } from "../format";
import type { DebtDocument } from "../normalize";

export function DocumentSection({ documentData }: { documentData: DebtDocument }) {
  const total = documentData.existing_debts.reduce((sum, debt) => sum + debt.amount_yen, 0);
  return (
    <section className="dn-section dn-document" id="document">
      <div className="dn-section-head">
        <div><p className="dn-section-no">03</p><h2>借入・返済計画書</h2></div>
        <span>画面でも内容を確認できます</span>
      </div>
      <p className="dn-doc-intro">現在の債務を整理し、責任を持って返済するための計画書です。原本の内容を画面上でも確認できます。</p>
      <div className="dn-doc-grid">
        <section>
          <h3>借入希望額・現在の債務</h3>
          <p>現在の月収：約{yen.format(documentData.monthly_income_yen)}。</p>
          <dl className="dn-debts">
            {documentData.existing_debts.map((debt, index) => [
              <dt key={`t${index}`}>{debt.creditor}</dt>,
              <dd key={`d${index}`}>{yen.format(debt.amount_yen)}</dd>,
            ])}
            <dt className="is-total">合計</dt><dd className="is-total">{yen.format(total)}</dd>
          </dl>
          <p>{documentData.difference_note}</p>
        </section>
        <section>
          <h3>返済に関するお願いと約束</h3>
          <div className="dn-promises">
            {documentData.promises.map((promise, index) => (
              <article key={index}><h4>{promise.title}</h4><p>{promise.body}</p></article>
            ))}
          </div>
        </section>
        <section>
          <h3>担保について</h3>
          <p>{documentData.collateral_note}</p>
        </section>
        <section className="dn-pledge">
          <h3>ギャンブルをしない誓約</h3>
          <p>{documentData.gambling_pledge}</p>
        </section>
      </div>
      <p className="dn-closing">{documentData.closing_note}</p>
      <p className="dn-submitted">提出日 <time>{displayDate(documentData.submitted_on)}</time></p>
    </section>
  );
}
