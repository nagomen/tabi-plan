import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("返済共有ページはhidden属性をCSSのdisplay指定より優先する", () => {
  const css = readFileSync(new URL("../src/debt/style.css", import.meta.url), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
});

test("返済共有ページは返済表の中で進路別プランを切り替える", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  // 収支の描画は funding.ts に分けたので、両方をまとめて検査する
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8")
    + readFileSync(new URL("../src/debt/funding.ts", import.meta.url), "utf8");
  for (const marker of ["data-reduced-income-panel", "data-schedule-plans", "data-plan-tabs", "data-selected-repayment", "data-selected-completion"]) {
    assert.match(html, new RegExp(marker));
  }
  assert.doesNotMatch(html, /data-scenarios-panel|data-repayment-scenarios|dn-scenarios/);
  for (const field of ["reduced_income_months", "repayment_scenarios", "monthly_repayment_yen", "completion_date"]) {
    assert.match(viewer, new RegExp(field));
  }
  assert.match(viewer, /scheduleForScenario/);
  assert.match(viewer, /aria-selected/);
  assert.match(viewer, /返済猶予/);
});

test("公開返済ページは氏名やメールアドレスを表示しない", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8");
  const normalize = readFileSync(new URL("../src/debt/normalize.ts", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-borrower|data-creditor/);
  assert.doesNotMatch(viewer, /\[data-borrower\]|\[data-creditor\]/);
  assert.match(html, /氏名・メールアドレスは表示されません/);
  assert.match(normalize, /既存債務/);
  assert.match(normalize, /EMAIL/);
});

test("返済共有ページは返済原資と月次収支の内訳を表示する", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  // 収支の描画は funding.ts に分けたので、両方をまとめて検査する
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8")
    + readFileSync(new URL("../src/debt/funding.ts", import.meta.url), "utf8");
  for (const marker of ["data-funding-plan", "data-fixed-expenses", "data-variable-expenses", "data-monthly-buffer"]) {
    assert.match(html, new RegExp(marker));
  }
  for (const field of ["income_plan", "expense_plan", "funding_plan"]) {
    assert.match(viewer, new RegExp(field));
  }
});

// ---- エラー処理: 通信・応答・データ形式 ----
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function loadModule(relativePath, stubs = {}) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require: (id) => stubs[id] || {} });
  return module.exports;
}

const api = loadModule("../src/debt/api.ts");
const { normalizePlan, normalizePdf } = loadModule("../src/debt/normalize.ts", { "./api": api });
const { scheduleForScenario } = loadModule("../src/debt/viewer.ts", {
  "./api": api,
  "./normalize": { normalizePlan, normalizePdf },
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

test("返済共有画面はエラー表示・再試行・二重描画防止の仕組みを持つ", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8");
  for (const marker of ["data-error-title", "data-error-reference", "data-error-retry", "<noscript>"]) {
    assert.match(html, new RegExp(marker));
  }
  for (const marker of ["class=\"dn-pdf\"", "data-ic=\"arrowDownTray\"", "data-download-label", "全4ページ", "個人情報非表示", "保存・印刷対応"]) {
    assert.match(html, new RegExp(marker));
  }
  assert.match(viewer, /replaceChildren\(\)/);
  assert.match(viewer, /download\.onclick\s*=/);
  assert.match(viewer, /aria-busy/);
  assert.match(viewer, /hashchange/);
  assert.doesNotMatch(viewer, /addEventListener\("click"/);
});

test("返済共有ページはヘッダーのメニューから各セクションへ移動できる", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../src/debt/nav.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8");
  assert.match(html, /data-menu-toggle[^>]*aria-controls="dn-menu"|aria-controls="dn-menu"[^>]*data-menu-toggle/);
  for (const id of ["status", "pdf", "schedule", "funding", "document"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-nav=`));
  }
  // ハッシュには共有トークンが入っているので、目次のリンクで書き換えない
  assert.match(nav, /preventDefault\(\)/);
  assert.match(nav, /scrollIntoView/);
  assert.match(nav, /closest\("\[hidden\]"\)/);
  assert.match(viewer, /initDebtNav\(\)/);
});

test("冒頭の返済計画は heroicon と仕切り線で組み、描画用の目印を保つ", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/debt/style.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/debt/main.ts", import.meta.url), "utf8");
  const overview = html.match(/<section class="dn-overview"[\s\S]*?<\/section>/)?.[0] || "";
  assert.ok(overview);
  for (const hook of ["data-remaining", "data-progress", "data-progress-label", "data-count-label", "data-next-date",
    "data-next-amount", "data-next-status", "data-principal", "data-interest", "data-total", "data-completion", "data-updated"]) {
    assert.match(overview, new RegExp(hook));
  }
  for (const name of ["banknotes", "calendarDays", "currencyYen", "receiptPercent", "calculator", "flag", "clock"]) {
    assert.match(overview, new RegExp(`data-ic="${name}"`));
  }
  assert.match(main, /fillIcons\(\)/);
  // 旧デザインの箱（塗りつぶしの残高カード）を残さない
  assert.doesNotMatch(css, /\.dn-summary|\.dn-balance/);
});

test("収支セクションは収入(＋)と支出(−)を列・符号・色で分け、計算式で結論を示す", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const funding = readFileSync(new URL("../src/debt/funding.ts", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8");
  assert.match(html, /dn-flow-col is-plus[\s\S]*data-ic="plusCircle"/);
  assert.match(html, /dn-flow-col is-minus[\s\S]*data-ic="minusCircle"/);
  for (const hook of ["data-flow-bars", "data-flow-legend", "data-cashflow-income", "data-cashflow-expenses", "data-available", "data-monthly-repayment", "data-monthly-buffer"]) {
    assert.match(html, new RegExp(hook));
  }
  // 交通費支給などの差し引きは支出を減らす＝プラスとして表示する
  assert.match(funding, /deduction_items\.map\([\s\S]*Math\.abs[\s\S]*"plus"/);
  // 手取りを超える月は不足として示す
  assert.match(funding, /dn-flow-shortage/);
  assert.match(viewer, /from "\.\/funding"/);
  assert.doesNotMatch(viewer, /function renderFundingPlan/);
});
