import { useCallback, useEffect, useMemo, useState } from "react";
import { DebtViewerError, post } from "./api";
import { accessFromFragment, TOKEN, type Access } from "./access";
import { describe } from "./errors";
import { normalizePlan, type DebtPlan, type RepaymentScenario } from "./normalize";
import { defaultScenario, scheduleForScenario } from "./schedule";
import { DocumentSection } from "./components/DocumentSection";
import { ErrorPanel } from "./components/ErrorPanel";
import { FundingSection } from "./components/FundingSection";
import { Header, type NavSection } from "./components/Header";
import { Overview } from "./components/Overview";
import { PaymentAction } from "./components/PaymentAction";
import { PdfCard } from "./components/PdfCard";
import { ScheduleSection } from "./components/ScheduleSection";

type ViewState =
  | { status: "loading" }
  | { status: "error"; problem: DebtViewerError }
  | { status: "ready"; plan: DebtPlan; access: Access };

async function loadPlan(access: Access): Promise<DebtPlan> {
  if (!TOKEN.test(access.token)) {
    throw new DebtViewerError(
      "共有URLが正しくありません。途中で切れていないか確認し、URL全体をコピーして開いてください。",
      "共有リンクを確認できませんでした",
    );
  }
  return normalizePlan(await post(access.manage ? "/api/debt/manage" : "/api/debt/share", { token: access.token }));
}

/** 本文を表示している間の目次。描画されないセクション（収支計画が無い等）は出さない。 */
function navSections(plan: DebtPlan): NavSection[] {
  const document = plan.document;
  return [
    { id: "status", label: "返済状況" },
    { id: "pdf", label: "計画書PDF" },
    { id: "schedule", label: "毎月の返済スケジュール", no: "01" },
    ...(document.income_plan && document.expense_plan && document.funding_plan ? [{ id: "funding", label: "返済原資と月次収支計画", no: "02" }] : []),
    { id: "document", label: "借入・返済計画書", no: "03" },
  ];
}

export function App({ initialHash }: { initialHash: string }) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [scenarioId, setScenarioId] = useState("");

  useEffect(() => {
    // 別の共有URLを同じタブへ貼り直したとき、前の計画を表示したままにしない。
    const reload = (): void => location.reload();
    window.addEventListener("hashchange", reload);
    const access = accessFromFragment(initialHash);
    loadPlan(access)
      .then((plan) => setState({ status: "ready", plan, access }))
      .catch((error: unknown) => setState({ status: "error", problem: describe(error, "返済計画の表示中に問題が発生しました。") }))
      .finally(() => document.documentElement.classList.add("ui-ready"));
    return () => window.removeEventListener("hashchange", reload);
  }, [initialHash]);

  const plan = state.status === "ready" ? state.plan : undefined;
  const scenarios = plan?.document.repayment_scenarios ?? [];
  const selected: RepaymentScenario | undefined = scenarios.find((scenario) => scenario.id === scenarioId) || defaultScenario(scenarios);
  const schedule = useMemo(
    () => (plan ? (selected ? scheduleForScenario(plan, selected) : plan.schedule) : []),
    [plan, selected],
  );
  const sections = useMemo(() => (plan ? navSections(plan) : []), [plan]);
  const onUpdated = useCallback((updated: DebtPlan) => {
    setState((current) => current.status === "ready" ? { ...current, plan: updated } : current);
  }, []);

  const manage = state.status === "ready" && state.access.manage;
  return (
    <>
      <Header accessLabel={manage ? "債務者用" : "閲覧専用"} sections={sections} />
      <main className="dn-shell">
        {state.status === "loading" && (
          <section className="dn-loading" aria-live="polite">
            <span className="dn-loader" aria-hidden="true"></span>
            <p>返済計画を安全に読み込んでいます</p>
          </section>
        )}
        {state.status === "error" && <ErrorPanel problem={state.problem} />}
        {state.status === "ready" && (
          <div data-content>
            <Overview plan={state.plan} schedule={schedule} />
            {manage && <PaymentAction plan={state.plan} token={state.access.token} onUpdated={onUpdated} />}
            <PdfCard token={state.access.token} manage={manage} />
            <ScheduleSection scenarios={scenarios} selected={selected} onSelect={(scenario) => setScenarioId(scenario.id)} schedule={schedule} />
            <FundingSection documentData={state.plan.document} schedule={state.plan.schedule} />
            <DocumentSection documentData={state.plan.document} />
            <footer className="dn-footer">
              <p>このページは共有リンクを知っている人だけが閲覧できます。リンクを第三者へ転送しないでください。</p>
              <p>{manage
                ? "氏名・メールアドレスは表示されません。この債務者専用URLは第三者へ転送しないでください。"
                : "氏名・メールアドレスは表示されません。返済状態の変更もこの画面からはできません。"}</p>
            </footer>
          </div>
        )}
      </main>
    </>
  );
}
