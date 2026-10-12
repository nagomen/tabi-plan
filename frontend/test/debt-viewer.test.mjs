// 返済共有ページ（React）のテスト。純粋なロジックは関数を直接呼び、
// 表示は react-dom/server で実際にコンポーネントを描いて確かめる。
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const cache = new Map();

/** src 配下の .ts/.tsx を TypeScript で変換して読み込む。相対 import は再帰的に解決し、react などは node_modules から読む。 */
function load(relativePath, base = import.meta.url) {
  const url = new URL(relativePath, base);
  if (cache.has(url.href)) return cache.get(url.href).exports;
  const javascript = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: url.pathname,
  }).outputText;
  const module = { exports: {} };
  cache.set(url.href, module);
  const require = (id) => {
    if (!id.startsWith(".")) return nodeRequire(id);
    for (const ext of [".ts", ".tsx"]) {
      const candidate = new URL(id + ext, url);
      if (fs.existsSync(candidate)) return load(candidate.href);
    }
    throw new Error(`モジュールが見つかりません: ${id}`);
  };
  new Function("module", "exports", "require", javascript)(module, module.exports, require);
  return module.exports;
}

const { createElement: h } = nodeRequire("react");
const { renderToStaticMarkup } = nodeRequire("react-dom/server");
const render = (component, props) => renderToStaticMarkup(h(component, props));

const api = load("../src/debt/api.ts");
const { normalizePlan, normalizePdf } = load("../src/debt/normalize.ts");
const { scheduleForScenario, repaymentPeriods, scenarioLeftover, statusFor, defaultScenario } = load("../src/debt/schedule.ts");
const { accessFromFragment } = load("../src/debt/access.ts");
const { flowChart } = load("../src/debt/flow.ts");

/** 実データと同じ形の計画（留年ルートを含む3つの進路、交通費支給の差し引き、収入減の月）。 */
function samplePlan() {
  const months = (pairs) => pairs.map(([month, amount]) => ({ due_date: `${month}-21`, amount_yen: amount }));
  return normalizePlan({
    principal_yen: 300000, interest_yen: 0, total_yen: 300000, paid_yen: 20000, updated_at: "2026-10-12T02:00:00Z",
    schedule: [
      { number: 1, due_date: "2026-11-21", amount_yen: 20000, paid_at: "2026-11-20" },
      { number: 2, due_date: "2026-12-21", amount_yen: 10000 },
      { number: 3, due_date: "2027-01-21", amount_yen: 10000 },
      { number: 4, due_date: "2027-02-21", amount_yen: 20000 },
      { number: 5, due_date: "2027-03-21", amount_yen: 20000 },
    ],
    document: {
      submitted_on: "2026-10-01", monthly_income_yen: 180000,
      existing_debts: [{ creditor: "既存債務1", amount_yen: 120000 }, { creditor: "既存債務2", amount_yen: 80000 }],
      promises: [{ title: "毎月21日に返済します", body: "給与日の翌営業日までに振り込みます。" }],
      collateral_note: "担保はありません。", gambling_pledge: "ギャンブルをしません。", closing_note: "責任を持って返済します。",
      income_plan: {
        hourly_wage_yen: 3000, monthly_hours_min: 60, monthly_hours_cap: 80, gross_income_min_yen: 180000, gross_income_yen: 240000,
        estimated_net_income_min_yen: 169000, estimated_net_income_yen: 225000, description: "アルバイト収入を返済原資とします。",
        reduced_income_months: [{ label: "2026年12月", net_income_yen: 150000, note: "官庁訪問で勤務が減るため" }],
      },
      expense_plan: {
        fixed_items: [{ label: "家賃", amount_yen: 26000 }], variable_items: [{ label: "食費", amount_yen: 30000 }],
        living_cost_group: { label: "交通費・生活費等", items: [{ label: "交通チャージ", amount_yen: 12000 }], subtotal_yen: 60000, deduction_items: [{ label: "会社からの交通費支給", amount_yen: -10000 }], total_yen: 50000 },
        fixed_total_yen: 32700, variable_total_yen: 128000, monthly_total_yen: 160700, special_expense_note: "2027年1月に北京旅行を予定しています。",
      },
      funding_plan: { monthly_available_min_yen: 8300, monthly_available_yen: 64300, monthly_repayment_yen: 10000, monthly_buffer_min_yen: -1700, monthly_buffer_yen: 54300, actions: ["給与受取後に最初に確保します。"] },
      repayment_scenarios: [
        { id: "accenture", title: "アクセンチュアルート", net_income_yen: 350000, net_income_min_yen: 350000, monthly_expenses_yen: 152000, monthly_repayment_yen: 60000, completion_date: "2027-07-21", schedule: months([["2027-04", 60000], ["2027-05", 60000], ["2027-06", 60000], ["2027-07", 10000]]) },
        { id: "repeat-year", title: "留年ルート", net_income_yen: 225000, net_income_min_yen: 169000, monthly_expenses_yen: 152000, monthly_repayment_yen: 20000, repayment_summary: "4・5月：10,000円／6月以降：20,000円", completion_date: "2028-02-21", note: "6月からは20,000円を返済します。", schedule: months([["2027-04", 10000], ["2027-05", 10000], ["2027-06", 20000], ["2027-07", 20000], ["2028-01", 20000], ["2028-02", 10000]]) },
      ],
    },
  });
}

// ---- 構成 ----

test("返済共有ページはhidden属性をCSSのdisplay指定より優先する", () => {
  const css = readFileSync(new URL("../src/debt/style.css", import.meta.url), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
});


test("返済共有ページは Vite + React（main.tsx）で描き、JS 到着前と無効時の表示を持つ", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  assert.match(html, /<div id="root">[\s\S]*dn-loading[\s\S]*<\/div>/);
  assert.match(html, /<script type="module" src="\.\.\/src\/debt\/main\.tsx"><\/script>/);
  assert.match(html, /<noscript>[\s\S]*JavaScriptを有効にしてください/);
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /import react from "@vitejs\/plugin-react"/);
  assert.match(config, /react\(\)/);
  // 本番 CSP で Google Fonts（Noto Sans JP）が弾かれないこと
  assert.match(config, /style-src[^"]*https:\/\/fonts\.googleapis\.com/);
  assert.match(config, /font-src[^"]*https:\/\/fonts\.gstatic\.com/);
});

test("公開返済ページは氏名やメールアドレスを表示しない", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const normalize = readFileSync(new URL("../src/debt/normalize.ts", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-borrower|data-creditor/);
  const { App } = load("../src/debt/App.tsx");
  const markup = render(App, { initialHash: "" });
  assert.match(markup, /閲覧専用/);
  assert.match(normalize, /既存債務/);
  assert.match(normalize, /EMAIL/);
});

test("最初の描画は読み込み表示で、本文と目次はまだ出さない", () => {
  const { App } = load("../src/debt/App.tsx");
  const markup = render(App, { initialHash: "#token=" + "A".repeat(43) });
  assert.match(markup, /返済計画を安全に読み込んでいます/);
  assert.doesNotMatch(markup, /data-content|dn-menu-button/);
});

test("共有URLは #token= と債務者用の #manage= を区別し、壊れた URL は空トークンにする", () => {
  const token = "A".repeat(43);
  assert.equal(JSON.stringify(accessFromFragment(`#token=${token}`)), JSON.stringify({ token, manage: false }));
  assert.equal(JSON.stringify(accessFromFragment(`#manage=${token}`)), JSON.stringify({ token, manage: true }));
  assert.equal(accessFromFragment(`#${token}`).token, token);
  assert.equal(accessFromFragment("#token=%E3%8").token, "");
});

// ---- 表示 ----

test("冒頭は残額・次回の返済・借入条件を heroicon 付きで示す", () => {
  const { Overview } = load("../src/debt/components/Overview.tsx");
  const plan = samplePlan();
  const markup = render(Overview, { plan, schedule: plan.schedule });
  assert.match(markup, /残りの返済額/);
  assert.match(markup, /280,000/);
  assert.match(markup, /7% 返済済み/);
  assert.match(markup, /2026年12月21日（月）/);
  for (const label of ["借入元金", "利息", "返済総額", "完済予定"]) assert.match(markup, new RegExp(label));
  assert.ok((markup.match(/<svg/g) || []).length >= 7, "heroicon が描かれていない");
  assert.doesNotMatch(markup, /dn-summary|dn-balance/);
});

test("返済予定が無いときは「完済」と誤表示しない", () => {
  const { Overview } = load("../src/debt/components/Overview.tsx");
  const plan = normalizePlan({ total_yen: 0, schedule: [], document: {} });
  const markup = render(Overview, { plan, schedule: [] });
  assert.match(markup, /返済予定未登録/);
  assert.doesNotMatch(markup, />完済</);
});

test("返済スケジュールは返済額を主役に、状態を heroicon と文字で示す", () => {
  const { ScheduleSection } = load("../src/debt/components/ScheduleSection.tsx");
  const plan = samplePlan();
  const scenarios = plan.document.repayment_scenarios;
  const selected = defaultScenario(scenarios);
  assert.equal(selected.id, "repeat-year");
  const schedule = scheduleForScenario(plan, selected);
  const markup = render(ScheduleSection, { scenarios, selected, onSelect() {}, schedule });
  assert.match(markup, /role="tab" aria-selected="true"[^>]*>留年ルート/);
  assert.match(markup, /返済済み/);
  assert.match(markup, /返済後に残るお金<\/span><small class="dn-formula">手取り − 支出 − 返済<\/small>/);
  assert.match(markup, /4・5月/);
  assert.match(markup, /6月以降/);
  assert.match(markup, /3,000 不足/);
  assert.equal((markup.match(/<tr>/g) || []).length - 1, schedule.length);
});

test("収支は収入(＋)と支出(−)を分け、交通費支給はプラス、不足は「不足」で示す", () => {
  const { FundingSection } = load("../src/debt/components/FundingSection.tsx");
  const markup = render(FundingSection, { documentData: samplePlan().document });
  assert.match(markup, /dn-flow-col is-plus/);
  assert.match(markup, /dn-flow-col is-minus/);
  assert.match(markup, /会社からの交通費支給<\/dt><dd><span class="dn-money is-positive">\+/);
  assert.match(markup, /−[^<]*160,700/);
  assert.match(markup, /返済後に残るお金/);
  assert.match(markup, /1,700 不足/);
  assert.match(markup, /dn-flow-shortage/);
  assert.equal((markup.match(/dn-subcard/g) || []).length, 3);
});

test("収支計画が無い計画では収支セクションを描かない", () => {
  const { FundingSection } = load("../src/debt/components/FundingSection.tsx");
  assert.equal(render(FundingSection, { documentData: normalizePlan({ schedule: [], document: {} }).document }), "");
});

test("計画書は既存債務の合計と誓約を示す", () => {
  const { DocumentSection } = load("../src/debt/components/DocumentSection.tsx");
  const markup = render(DocumentSection, { documentData: samplePlan().document });
  assert.match(markup, /合計<\/dt><dd class="is-total">[^<]*200,000/);
  assert.match(markup, /ギャンブルをしない誓約/);
});

test("目次は各セクションへのリンクを持ち、債務者リンクでは見出しが変わる", () => {
  const { Header } = load("../src/debt/components/Header.tsx");
  const markup = render(Header, { accessLabel: "債務者用", sections: [{ id: "status", label: "返済状況" }, { id: "schedule", label: "毎月の返済スケジュール", no: "01" }] });
  assert.match(markup, /債務者用/);
  assert.match(markup, /href="#schedule"[^>]*><span class="dn-menu-no">01<\/span>毎月の返済スケジュール/);
  assert.match(markup, /aria-controls="dn-menu"/);
  const source = readFileSync(new URL("../src/debt/components/Header.tsx", import.meta.url), "utf8");
  // ハッシュには共有トークンが入っているので、目次のリンクで書き換えない
  assert.match(source, /preventDefault\(\)/);
});

test("債務者専用リンクだけに返済記録ボタンを出し、管理APIへ送る", () => {
  const { PaymentAction } = load("../src/debt/components/PaymentAction.tsx");
  const markup = render(PaymentAction, { plan: samplePlan(), token: "x", onUpdated() {} });
  assert.match(markup, /返済した/);
  assert.match(markup, /貸主へメールで知らせます/);
  const source = readFileSync(new URL("../src/debt/components/PaymentAction.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/debt\/manage\/paid/);
  const app = readFileSync(new URL("../src/debt/App.tsx", import.meta.url), "utf8");
  assert.match(app, /manage && <PaymentAction/);
  assert.match(app, /hashchange/);
});

test("PDF の導線は罫線の1行で、ボタンを持つ", () => {
  const { PdfCard } = load("../src/debt/components/PdfCard.tsx");
  const markup = render(PdfCard, { token: "x", manage: false });
  assert.match(markup, /class="dn-pdf"/);
  assert.match(markup, /PDFをダウンロード/);
  for (const text of ["全4ページ", "個人情報非表示", "保存・印刷対応"]) assert.match(markup, new RegExp(text));
});

test("読み込みエラーは問い合わせ番号と、待ち時間付きの再試行ボタンを出す", () => {
  const { ErrorPanel } = load("../src/debt/components/ErrorPanel.tsx");
  const markup = render(ErrorPanel, { problem: new api.DebtViewerError("混み合っています", "アクセスが集中しています", true, 5, "req123") });
  assert.match(markup, /問い合わせ番号：req123/);
  assert.match(markup, /5秒後に再試行できます/);
  assert.match(markup, /disabled/);
  const fatal = render(ErrorPanel, { problem: new api.DebtViewerError("無効です", "共有リンクを確認できませんでした") });
  assert.doesNotMatch(fatal, /再試行|もう一度読み込む/);
});

// ---- ロジック ----

test("返済の状態は期日と支払い記録から決まる", () => {
  const today = "2026-10-12";
  const state = (item) => statusFor({ number: 1, paid_at: null, amount_yen: 10000, ...item }, today);
  assert.equal(state({ amount_yen: 0, due_date: "2026-12-21" }).icon, "pauseCircle");
  assert.equal(state({ due_date: "2026-09-21", paid_at: "2026-09-20" }).label, "返済済み");
  assert.equal(state({ due_date: "2026-09-21" }).label, "期日超過");
  assert.equal(state({ due_date: today }).label, "本日期日");
  assert.equal(state({ due_date: "2026-11-21" }).icon, "clock");
});

test("返済後に残るお金は「手取り − 支出 − 返済」を返済額の期間ごとに計算する", () => {
  const scenarios = samplePlan().document.repayment_scenarios;
  const repeat = scenarios.find((scenario) => scenario.id === "repeat-year");
  // 完済月の端数(2月 1万円)は独立した期間にしない
  assert.equal(JSON.stringify(repaymentPeriods(repeat.schedule).map((period) => [period.months.length, period.amount])), "[[2,10000],[3,20000]]");
  assert.equal(JSON.stringify(scenarioLeftover(repeat)), JSON.stringify([
    { label: "4・5月", minimum: 7000, maximum: 63000 },
    { label: "6月以降", minimum: -3000, maximum: 53000 },
  ]));
  const accenture = scenarios.find((scenario) => scenario.id === "accenture");
  assert.equal(JSON.stringify(scenarioLeftover(accenture)), JSON.stringify([{ label: "", minimum: 138000, maximum: 138000 }]));
});

test("手取りの使い道の帯は、手取りを超える月の不足分を返す", () => {
  const chart = flowChart(samplePlan().document);
  assert.equal(chart.cases.length, 2);
  const low = chart.cases.find((flow) => flow.label === "収入が少ない月");
  assert.equal(low.buffer, -1700);
  assert.ok(low.shortage && low.shortage.width > 0);
  assert.equal(chart.cases.find((flow) => flow.label === "収入が多い月").shortage, undefined);
});

test("進路を切り替えると3月までを維持し、4月以降だけ選択プランへ差し替える", () => {
  const plan = normalizePlan({
    principal_yen: 230000,
    interest_yen: 10000,
    total_yen: 240000,
    paid_yen: 0,
    updated_at: "2026-10-12",
    schedule: [
      { number: 1, due_date: "2026-11-21", amount_yen: 20000 },
      { number: 2, due_date: "2026-12-21", amount_yen: 10000 },
      { number: 3, due_date: "2027-01-21", amount_yen: 10000 },
      { number: 4, due_date: "2027-02-21", amount_yen: 20000 },
      { number: 5, due_date: "2027-03-21", amount_yen: 20000 },
      { number: 6, due_date: "2027-04-21", amount_yen: 20000 },
    ],
    document: { repayment_scenarios: [] },
  });
  const schedule = scheduleForScenario(plan, {
    id: "accenture",
    title: "アクセンチュアルート",
    net_income_yen: 350000,
    monthly_expenses_yen: 170000,
    monthly_repayment_yen: 60000,
    monthly_buffer_yen: 120000,
    completion_date: "2027-06-21",
    note: "",
    schedule: [
      { due_date: "2027-06-21", amount_yen: 40000 },
      { due_date: "2027-04-21", amount_yen: 60000 },
      { due_date: "2027-05-21", amount_yen: 60000 },
    ],
  });

  assert.deepEqual(Array.from(schedule, (item) => item.due_date), [
    "2026-11-21", "2026-12-21", "2027-01-21", "2027-02-21", "2027-03-21",
    "2027-04-21", "2027-05-21", "2027-06-21",
  ]);
  assert.equal(schedule.reduce((sum, item) => sum + item.amount_yen, 0), 240000);
  assert.deepEqual(Array.from(schedule.slice(5), (item) => item.number), [6, 7, 8]);
});


// ---- エラー処理・データ形式 ----

test("HTMLのプロキシエラーやレート制限も日本語で説明し、再試行可否を返す", () => {
  const gateway = api.errorFromResponse(502, "<html>Bad Gateway</html>", null);
  assert.equal(gateway.retryable, true);
  assert.match(gateway.message, /サーバー/);

  const limited = api.errorFromResponse(429, JSON.stringify({ message: "試行回数が上限に達しました。", retryable: true, retry_after: 42 }), "10");
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfter, 42);
  assert.equal(limited.message, "試行回数が上限に達しました。");

  const headerOnly = api.errorFromResponse(429, "", "15");
  assert.equal(headerOnly.retryAfter, 15);

  const missing = api.errorFromResponse(404, JSON.stringify({ error: "not_found", message: "この共有リンクは無効か、公開が終了しています。", retryable: false }), null);
  assert.equal(missing.retryable, false);
  assert.equal(missing.title, "共有リンクを確認できませんでした");

  const corrupted = api.errorFromResponse(500, JSON.stringify({ error: "data_corrupted", message: "壊れています", retryable: false, request_id: "abc123" }), null);
  assert.equal(corrupted.requestId, "abc123");
  assert.equal(corrupted.retryable, false);
});

test("オフライン・タイムアウト・接続失敗をそれぞれ区別して案内する", () => {
  assert.match(api.errorFromNetwork({ name: "TimeoutError" }, true).message, /時間内に応答/);
  assert.match(api.errorFromNetwork({ name: "AbortError" }, true).message, /時間内に応答/);
  assert.match(api.errorFromNetwork(new TypeError("Failed to fetch"), false).message, /インターネットに接続されていません/);
  const network = api.errorFromNetwork(new TypeError("Failed to fetch"), true);
  assert.match(network.message, /接続できませんでした/);
  assert.equal(network.retryable, true);
});

test("返済データの欠損は既定値で埋め、返済予定が読めないときは表示エラーにする", () => {
  const plan = normalizePlan({
    total_yen: "120000",
    paid_yen: null,
    schedule: [
      { number: 2, due_date: "2027-01-21", amount_yen: "60000" },
      { number: 1, due_date: "2026-12-21", amount_yen: 60000, paid_at: "2026-12-20" },
    ],
    document: { promises: "配列ではない", existing_debts: [{ creditor: "A", amount_yen: "1000" }, null], repayment_scenarios: [{ schedule: [{ due_date: "不明" }] }] },
  });
  assert.equal(plan.total_yen, 120000);
  assert.equal(plan.paid_yen, 0);
  assert.deepEqual(plan.schedule.map((item) => item.due_date), ["2026-12-21", "2027-01-21"]);
  assert.equal(plan.schedule[1].paid_at, null);
  assert.equal(plan.borrower_name, "");
  assert.equal(plan.updated_at, "");
  assert.equal(plan.document.promises.length, 0);
  assert.equal(plan.document.existing_debts.length, 1);
  assert.equal(plan.document.existing_debts[0].amount_yen, 1000);
  assert.equal(plan.document.repayment_scenarios[0].schedule.length, 0);
  assert.equal(plan.document.income_plan, undefined);

  for (const bad of [null, "text", [], { schedule: "x" }, { schedule: [{ due_date: "来月" }] }, { schedule: [null] }]) {
    assert.throws(() => normalizePlan(bad), (error) => error.name === "DebtViewerError" && /形式/.test(error.message));
  }
});

test("月収と返済後余力は下限から上限までの幅を保持する", () => {
  const plan = normalizePlan({
    schedule: [{ due_date: "2026-11-21", amount_yen: 10000 }],
    document: {
      income_plan: {
        hourly_wage_yen: 3000,
        monthly_hours_min: 60,
        monthly_hours_cap: 80,
        gross_income_min_yen: 180000,
        gross_income_yen: 240000,
        estimated_net_income_min_yen: 169000,
        estimated_net_income_yen: 225000,
      },
      funding_plan: {
        monthly_available_min_yen: -13000,
        monthly_available_yen: 43000,
        monthly_repayment_yen: 10000,
        monthly_buffer_min_yen: -23000,
        monthly_buffer_yen: 33000,
      },
      repayment_scenarios: [{
        id: "repeat-year",
        net_income_min_yen: 169000,
        net_income_yen: 225000,
        monthly_repayment_yen: 20000,
        repayment_summary: "1万円→2万円→3万円",
        monthly_buffer_min_yen: -33000,
        monthly_buffer_yen: 23000,
        schedule: [{ due_date: "2027-04-21", amount_yen: 10000 }],
      }],
    },
  });
  assert.equal(plan.document.income_plan?.monthly_hours_min, 60);
  assert.equal(plan.document.income_plan?.estimated_net_income_min_yen, 169000);
  assert.equal(plan.document.funding_plan?.monthly_buffer_min_yen, -23000);
  assert.equal(plan.document.repayment_scenarios[0].repayment_summary, "1万円→2万円→3万円");
  assert.equal(plan.document.repayment_scenarios[0].monthly_buffer_min_yen, -33000);
});

test("交通費と生活費は内訳・交通費支給・差引負担額を一つのグループで保持する", () => {
  const plan = normalizePlan({
    schedule: [{ due_date: "2026-11-21", amount_yen: 10000 }],
    document: {
      expense_plan: {
        variable_items: [{ label: "飲み代", amount_yen: 48000 }],
        living_cost_group: {
          label: "交通費・生活費等",
          items: [
            { label: "交通チャージ", amount_yen: 12000 },
            { label: "生活費の予備", amount_yen: 3000 },
          ],
          subtotal_yen: 60000,
          deduction_items: [{ label: "会社からの交通費支給", amount_yen: -10000 }],
          total_yen: 50000,
        },
        variable_total_yen: 128000,
        monthly_total_yen: 160700,
      },
    },
  });
  const group = plan.document.expense_plan?.living_cost_group;
  assert.equal(group?.label, "交通費・生活費等");
  assert.equal(group?.subtotal_yen, 60000);
  assert.equal(group?.deduction_items[0].amount_yen, -10000);
  assert.equal(group?.total_yen, 50000);
  assert.equal(plan.document.expense_plan?.monthly_total_yen, 160700);
});

test("PDF応答は base64 とファイル名を検査する", () => {
  const pdf = normalizePdf({ filename: "計画:書/最終\u0007.pdf", data_base64: "JVBE\nRi0x" });
  assert.equal(pdf.filename, "計画_書_最終.pdf");
  assert.equal(pdf.data_base64, "JVBERi0x");
  assert.equal(pdf.mime_type, "application/pdf");
  for (const bad of [null, {}, { data_base64: "" }, { data_base64: "!!!not-base64" }]) {
    assert.throws(() => normalizePdf(bad), (error) => error.name === "DebtViewerError");
  }
});

