import { useRef, type KeyboardEvent } from "react";
import { displayDate, todayInJapan, yen, yenRange } from "../format";
import type { Installment, RepaymentScenario } from "../normalize";
import { scenarioLeftover, statusFor } from "../schedule";
import { LeftoverRange } from "./Money";
import { StateBadge } from "./StateBadge";

interface ScheduleSectionProps {
  scenarios: RepaymentScenario[];
  selected?: RepaymentScenario;
  onSelect: (scenario: RepaymentScenario) => void;
  /** 選択中の進路を反映した返済予定。 */
  schedule: Installment[];
}

function PlanSwitch({ scenarios, selected, onSelect }: Required<Pick<ScheduleSectionProps, "scenarios" | "selected" | "onSelect">>) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % scenarios.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + scenarios.length) % scenarios.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = scenarios.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = scenarios[nextIndex];
    onSelect(next);
    tabs.current.get(next.id)?.focus();
  };

  const leftover = scenarioLeftover(selected);
  return (
    <div className="dn-schedule-plans">
      <div className="dn-plan-switch-copy">
        <p className="dn-section-no">APRIL 2027 — SELECT A PLAN</p>
        <h3>4月以降の進路別返済プラン</h3>
        <p>11月から3月までは共通の返済計画です。進路を選ぶと、4月以降の返済額・予備費・完済予定が下の表へ反映されます。</p>
      </div>
      <div className="dn-plan-tabs" role="tablist" aria-label="4月以降の返済プラン">
        {scenarios.map((scenario, index) => {
          const active = scenario.id === selected.id;
          return (
            <button
              key={scenario.id}
              ref={(node) => { if (node) tabs.current.set(scenario.id, node); else tabs.current.delete(scenario.id); }}
              type="button"
              className="dn-plan-tab"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(scenario)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {scenario.title}
            </button>
          );
        })}
      </div>
      <div className="dn-plan-summary" aria-live="polite">
        <div><span>4月以降の想定手取り</span><strong>{yenRange(selected.net_income_min_yen, selected.net_income_yen)}</strong></div>
        <div><span>毎月の返済</span><strong>{selected.repayment_summary || yen.format(selected.monthly_repayment_yen)}</strong></div>
        <div>
          <span>返済後に残るお金</span><small className="dn-formula">手取り − 支出 − 返済</small>
          <strong data-selected-buffer>
            {leftover.length === 1 && !leftover[0].label
              ? <LeftoverRange minimum={leftover[0].minimum} maximum={leftover[0].maximum} />
              : leftover.map((row) => (
                <span className="dn-leftover-period" key={row.label}>
                  <small>{row.label}</small>
                  <span><LeftoverRange minimum={row.minimum} maximum={row.maximum} /></span>
                </span>
              ))}
          </strong>
        </div>
        <div><span>完済予定</span><strong>{displayDate(selected.completion_date)}</strong></div>
      </div>
      <p className="dn-plan-note">{selected.note}</p>
    </div>
  );
}

export function ScheduleSection({ scenarios, selected, onSelect, schedule }: ScheduleSectionProps) {
  const today = todayInJapan();
  const paymentCount = schedule.filter((item) => item.amount_yen > 0).length;
  const deferredCount = schedule.length - paymentCount;
  let cumulative = 0;

  return (
    <section className="dn-section" id="schedule">
      <div className="dn-section-head">
        <div><p className="dn-section-no">01</p><h2>毎月の返済スケジュール</h2></div>
        <span>{deferredCount ? `全${paymentCount}回返済・${deferredCount}か月猶予` : `全${paymentCount}回`}</span>
      </div>
      {selected && scenarios.length > 0 && <PlanSwitch scenarios={scenarios} selected={selected} onSelect={onSelect} />}
      <div className="dn-table-wrap">
        <table>
          <thead><tr><th>回</th><th>返済期日</th><th>返済額</th><th>累計</th><th>状態</th></tr></thead>
          <tbody>
            {schedule.map((item) => {
              cumulative += item.amount_yen;
              return (
                <tr key={item.due_date}>
                  <td>{item.amount_yen === 0 ? "—" : item.number}</td>
                  <td>{displayDate(item.due_date)}</td>
                  <td>{yen.format(item.amount_yen)}</td>
                  <td>{yen.format(cumulative)}</td>
                  <td><StateBadge state={statusFor(item, today)} /></td>
                </tr>
              );
            })}
            {!schedule.length && <tr><td colSpan={5}>返済予定はまだ登録されていません。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
