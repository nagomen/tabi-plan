import { displayDate, yen } from "../format";
import type { DebtDocument, Installment } from "../normalize";
import { travelSavings } from "../travel";
import { Icon } from "./Icon";
import { Leftover } from "./Money";

function monthLabel(month: string): string {
  const [year, value] = month.split("-");
  return `${Number(year)}年${Number(value)}月`;
}

/** 旅行予定と必要資金。目標額・期限・月ごとの勤務時間と貯まる額・約束を、ひと目で読める形に分ける。 */
export function TravelCard({ documentData, schedule }: { documentData: DebtDocument; schedule: Installment[] }) {
  const savings = travelSavings(documentData, schedule);
  if (!savings) {
    // 構造化データが無い計画は、従来どおり文章で示す。
    return (
      <aside className="dn-special-expense dn-subcard">
        <strong><Icon name="paperAirplane" />旅行予定と必要資金</strong>
        <p>{documentData.expense_plan?.special_expense_note}</p>
      </aside>
    );
  }
  const { plan, months } = savings;
  const single = plan.budget_min_yen === plan.budget_max_yen;
  const reaches = single ? savings.reachesLow : savings.reachesLow && savings.reachesHigh;

  return (
    <aside className="dn-special-expense dn-subcard dn-travel" aria-labelledby="dn-travel-title">
      <div className="dn-travel-head">
        <strong id="dn-travel-title"><Icon name="paperAirplane" />旅行予定と必要資金</strong>
        <span>{plan.title}{plan.travel_month ? `・${monthLabel(plan.travel_month)}` : ""}</span>
      </div>

      <dl className="dn-travel-keys">
        <div><dt>必要な旅行費</dt><dd>{single ? yen.format(plan.budget_min_yen) : `${yen.format(plan.budget_min_yen)}〜${yen.format(plan.budget_max_yen)}`}</dd></div>
        <div><dt>貯める期限</dt><dd>{plan.deadline ? displayDate(plan.deadline) : "未定"}</dd></div>
        <div>
          <dt>期限までに貯まる見込み</dt>
          <dd>
            {single ? yen.format(savings.totalLow) : `${yen.format(savings.totalLow)}〜${yen.format(savings.totalHigh)}`}
            <span className={`dn-travel-verdict ${reaches ? "is-ok" : "is-short"}`}>
              <Icon name={reaches ? "checkCircle" : "exclamationTriangle"} className="dn-state-ic" />{reaches ? "目標に届く" : "目標に届かない"}
            </span>
          </dd>
        </div>
      </dl>

      <table className="dn-travel-table">
        <caption>月ごとの勤務時間と、支出・返済を払ったあとに貯まる額</caption>
        <thead>
          <tr>
            <th scope="col">月</th>
            <th scope="col">{single ? "勤務と貯まる額" : <><span>{yen.format(plan.budget_min_yen)}</span><small>を貯める</small></>}</th>
            {!single && <th scope="col"><span>{yen.format(plan.budget_max_yen)}</span><small>を貯める</small></th>}
          </tr>
        </thead>
        <tbody>
          {months.map((item) => (
            <tr key={item.month}>
              <th scope="row"><small className="dn-travel-year">{item.month.slice(0, 4)}年</small>{Number(item.month.slice(5, 7))}月<small>{item.repayment ? `返済 ${yen.format(item.repayment)}` : "返済なし"}</small></th>
              <td><span className="dn-travel-hours">{item.low.hours}時間</span><Leftover value={item.low.saving} /></td>
              {!single && <td><span className="dn-travel-hours">{item.high.hours}時間</span><Leftover value={item.high.saving} /></td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">合計</th>
            <td><Leftover value={savings.totalLow} /></td>
            {!single && <td><Leftover value={savings.totalHigh} /></td>}
          </tr>
        </tfoot>
      </table>
      <p className="dn-travel-formula">貯まる額 ＝ 手取り（時給 × 勤務時間{plan.tax_free_limit_yen ? `、額面${yen.format(plan.tax_free_limit_yen)}超は${Math.round(plan.taxed_net_ratio * 10000) / 100}%` : ""}） − 支出 − その月の返済</p>

      {plan.rules.length > 0 && (
        <ul className="dn-travel-rules">
          {plan.rules.map((rule, index) => <li key={index}><Icon name="exclamationTriangle" className="dn-state-ic" />{rule}</li>)}
        </ul>
      )}
      {plan.basis_note && <p className="dn-travel-basis">{plan.basis_note}</p>}
    </aside>
  );
}
