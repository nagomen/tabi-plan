import { monthNames, yen } from "../format";
import { flowChart, SEGMENTS, type FlowChart } from "../flow";
import type { BudgetItem, DebtDocument, Installment } from "../normalize";
import { Icon } from "./Icon";
import { LeftoverRange, Money, MoneyRange, type Sign } from "./Money";
import { TravelCard } from "./TravelCard";

function Rows({ items, sign, nested = false }: { items: BudgetItem[]; sign: Sign; nested?: boolean }) {
  return (
    <dl className={`dn-flow-rows${nested ? " is-nested" : ""}`}>
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd><Money value={item.amount_yen} sign={sign} /></dd></div>
      ))}
    </dl>
  );
}

function FlowBars({ chart, bufferMin, bufferMax }: { chart: FlowChart; bufferMin: number; bufferMax: number }) {
  const legend: Record<string, string> = {
    fixed: yen.format(chart.fixed),
    variable: yen.format(chart.variable),
    repayment: yen.format(chart.repayment),
    buffer: chart.cases.length > 1
      ? `${yen.format(Math.max(0, bufferMin))}〜${yen.format(Math.max(0, bufferMax))}`
      : yen.format(Math.max(0, bufferMax)),
  };
  const values = { fixed: chart.fixed, variable: chart.variable, repayment: chart.repayment };
  return (
    <div className="dn-flow-chart">
      <div className="dn-flow-chart-head"><h3>手取りの使い道</h3><span>1か月あたり</span></div>
      <div className="dn-flow-bars">
        {chart.cases.map((flow) => (
          <div className="dn-flow-bar-row" key={flow.label}>
            <p className="dn-flow-bar-head">
              <span>{flow.label}・手取り {yen.format(flow.net)}</span>
              <strong className={flow.buffer < 0 ? "is-negative" : "is-positive"}>
                {flow.buffer < 0 ? `${yen.format(Math.abs(flow.buffer))} 不足` : `${yen.format(flow.buffer)} 残る`}
              </strong>
            </p>
            <div
              className="dn-flow-bar"
              role="img"
              aria-label={`${flow.label}：手取り${yen.format(flow.net)}のうち、固定費${yen.format(chart.fixed)}、変動費${yen.format(chart.variable)}、返済${yen.format(chart.repayment)}。`
                + (flow.buffer < 0 ? `${yen.format(Math.abs(flow.buffer))}不足します。` : `${yen.format(flow.buffer)}残ります。`)}
            >
              {SEGMENTS.map(({ key }) => {
                const amount = key === "buffer" ? Math.max(0, flow.buffer) : values[key];
                return amount ? <span key={key} className={`dn-flow-seg is-${key}`} style={{ width: `${flow.widths[key]}%` }}></span> : null;
              })}
              {flow.shortage && <span className="dn-flow-shortage" style={{ left: `${flow.shortage.left}%`, width: `${flow.shortage.width}%` }}></span>}
              <span className="dn-flow-marker" style={{ left: `${flow.netAt}%` }}></span>
            </div>
          </div>
        ))}
      </div>
      <ul className="dn-flow-legend">
        {SEGMENTS.map(({ key, label }) => <li key={key}><i className={`is-${key}`}></i><span>{label}</span><b>{legend[key]}</b></li>)}
        {chart.cases.some((flow) => flow.buffer < 0) && <li><i className="is-shortage"></i><span>不足</span></li>}
      </ul>
    </div>
  );
}

/** 02 返済原資と月次収支計画。収入（＋・緑）と支出（−・赤）を左右に分け、最後に計算式で結論を示す。 */
export function FundingSection({ documentData, schedule }: { documentData: DebtDocument; schedule: Installment[] }) {
  const income = documentData.income_plan;
  const expenses = documentData.expense_plan;
  const funding = documentData.funding_plan;
  const chart = flowChart(documentData);
  if (!income || !expenses || !funding || !chart) return null;
  const group = expenses.living_cost_group;

  return (
    <section className="dn-section dn-funding" id="funding">
      <div className="dn-section-head">
        <div><p className="dn-section-no">02</p><h2>返済原資と月次収支計画</h2></div>
        <span>毎月の返済可能性</span>
      </div>
      <p className="dn-funding-intro">{income.description}</p>
      <FlowBars chart={chart} bufferMin={funding.monthly_buffer_min_yen} bufferMax={funding.monthly_buffer_yen} />

      <div className="dn-flow-ledger">
        <section className="dn-flow-col is-plus" aria-labelledby="dn-flow-income-title">
          <h3 id="dn-flow-income-title"><Icon name="plusCircle" />収入<em>プラス</em></h3>
          <dl className="dn-flow-rows">
            <div><dt>時給</dt><dd>{yen.format(income.hourly_wage_yen)}</dd></div>
            <div><dt>勤務時間</dt><dd>{income.monthly_hours_min === income.monthly_hours_cap
              ? `${income.monthly_hours_cap}時間`
              : `${income.monthly_hours_min}〜${income.monthly_hours_cap}時間`}</dd></div>
            <div><dt>額面収入</dt><dd><MoneyRange minimum={income.gross_income_min_yen} maximum={income.gross_income_yen} sign="plus" /></dd></div>
          </dl>
          <p className="dn-flow-total"><span>手取り</span><strong><MoneyRange minimum={income.estimated_net_income_min_yen} maximum={income.estimated_net_income_yen} sign="plus" /></strong></p>
        </section>
        <section className="dn-flow-col is-minus" aria-labelledby="dn-flow-expense-title">
          <h3 id="dn-flow-expense-title"><Icon name="minusCircle" />支出<em>マイナス</em></h3>
          <h4>固定費</h4>
          <Rows items={expenses.fixed_items} sign="minus" />
          <p className="dn-flow-subtotal"><span>固定費 計</span><strong><Money value={expenses.fixed_total_yen} sign="minus" /></strong></p>
          <h4>変動費</h4>
          <Rows items={expenses.variable_items} sign="minus" />
          {group && (
            <div className="dn-flow-group">
              <p className="dn-flow-group-head"><span>{group.label}</span><span>小計 <Money value={group.subtotal_yen} sign="minus" /></span></p>
              <Rows items={group.items} sign="minus" nested />
              {/* 交通費支給などの差し引きは支出を減らす＝プラス。保存値は負数なので絶対値で＋表示する。 */}
              <Rows items={group.deduction_items.map((item) => ({ ...item, amount_yen: Math.abs(item.amount_yen) }))} sign="plus" nested />
              <p className="dn-flow-group-total"><span>差引負担額</span><strong><Money value={group.total_yen} sign="minus" /></strong></p>
            </div>
          )}
          <p className="dn-flow-subtotal"><span>変動費 計</span><strong><Money value={expenses.variable_total_yen} sign="minus" /></strong></p>
          <p className="dn-flow-total"><span>支出合計</span><strong><Money value={expenses.monthly_total_yen} sign="minus" /></strong></p>
        </section>
      </div>

      <ol className="dn-flow-equation" aria-label="毎月の収支計算">
        <li className="is-plus"><span>手取り</span><strong><MoneyRange minimum={income.estimated_net_income_min_yen} maximum={income.estimated_net_income_yen} sign="plus" /></strong></li>
        <li className="is-minus"><span>支出合計</span><strong><Money value={expenses.monthly_total_yen} sign="minus" /></strong></li>
        <li className="is-result"><span>返済前に残るお金</span><strong><LeftoverRange minimum={funding.monthly_available_min_yen} maximum={funding.monthly_available_yen} /></strong></li>
        <li className="is-minus"><span>毎月の返済</span><strong><Money value={funding.monthly_repayment_yen} sign="minus" /></strong></li>
        <li className="is-final"><span>返済後に残るお金</span><strong><LeftoverRange minimum={funding.monthly_buffer_min_yen} maximum={funding.monthly_buffer_yen} /></strong></li>
      </ol>

      <TravelCard documentData={documentData} schedule={schedule} />
      {income.reduced_income_months.length > 0 && (
        <section className="dn-reduced-income dn-subcard">
          <div>
            <p className="dn-section-no">MINIMUM WORK MONTHS</p>
            <h3><Icon name="calendarDays" />{monthNames(income.reduced_income_months.map((month) => month.label))}は最低勤務で少額返済</h3>
            <p>官庁訪問のため勤務を最低時間に抑える月です。返済額を少額にして支払いを続けます。各月の手取りと、支出・返済後に残る見込みは次のとおりです。</p>
          </div>
          <div className="dn-reduced-income-grid">
            {income.reduced_income_months.map((month) => (
              <article key={month.label}>
                <h4>{month.label}</h4>
                <strong><Money value={month.net_income_yen} sign="plus" /></strong>
                <p>{month.note}</p>
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="dn-funding-actions dn-subcard">
        <h3><Icon name="listBullet" />返済資金を確保するための実行計画</h3>
        <ol>{funding.actions.map((action, index) => <li key={index}>{action}</li>)}</ol>
      </div>
    </section>
  );
}
