// 費用の通貨換算・割り勘の端数・負担額の集計。金額がずれると精算がそのまま狂うので、
// DOM を伴わない計算部分だけを取り出して検証する。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function load(relativePath, stubs = {}) {
  const source = fs.readFileSync(new URL(relativePath, root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: (id) => stubs[id] || {} };
  vm.runInNewContext(javascript, context);
  return module.exports;
}

const currency = load("src/shared/currency.ts");
const {
  currencyDecimals, currencyStep, toMinor, toMajor, fxRateFromUnitRate, unitRateFromFxRate, formatMoneyMinor,
} = currency;

// db は DOM とネットワークに触るので、テストでは呼ばれた入力を捕まえるだけのスタブにする。
function expenseStoreWith(db) {
  return load("src/shared/expense-store.ts", { "./db": db, "./currency": currency });
}

test("小数を持つ通貨と持たない通貨で最小単位を切り替える", () => {
  assert.equal(currencyDecimals("JPY"), 0);
  assert.equal(currencyDecimals("KRW"), 0);
  assert.equal(currencyDecimals("usd"), 2);
  assert.equal(currencyDecimals("KWD"), 3);
  assert.equal(currencyStep("KWD"), "0.001");
  assert.equal(toMinor(1200, "JPY"), 1200);
  assert.equal(toMinor(12.34, "USD"), 1234);
  assert.equal(toMinor(1.234, "KWD"), 1234);
  assert.equal(toMajor(1234, "USD"), 12.34);
  assert.equal(toMajor(1234, "KWD"), 1.234);
  assert.equal(formatMoneyMinor(1234, "USD"), "USD 12.34");
  assert.equal(formatMoneyMinor(1234, "KWD"), "KWD 1.234");
  assert.equal(formatMoneyMinor(9750, "JPY"), "¥9,750");
});

test("「1通貨 = ?円」から、最小単位どうしの換算レートを作る", () => {
  // 1 HKD = 19.5円。HKD は 100 minor、JPY は 1 minor なので 0.195 になる。
  const rate = fxRateFromUnitRate(19.5, "HKD", "JPY");
  assert.equal(rate, 0.195);
  assert.equal(Math.round(toMinor(500, "HKD") * rate), 9750);
  assert.equal(unitRateFromFxRate(rate, "HKD", "JPY"), 19.5);
  // 未入力・0・負値は保存させない。
  assert.equal(fxRateFromUnitRate(0, "HKD", "JPY"), 0);
  assert.equal(fxRateFromUnitRate(-1, "HKD", "JPY"), 0);
  assert.equal(fxRateFromUnitRate(Number.NaN, "HKD", "JPY"), 0);
});

test("外貨の費用はレートを掛けた額で保存し、負担額も換算後で配る", async () => {
  let saved = null;
  const store = expenseStoreWith({
    addExpense: async (_planId, input) => { saved = input; return { id: "exp_1" }; },
  });
  await store.add("pln_1", {
    payerUserId: "u1",
    amountMinor: toMinor(500, "HKD"),
    currency: "HKD",
    fxRate: fxRateFromUnitRate(19.5, "HKD", "JPY"),
    splitMethod: "equal_all",
    memberIds: ["u1", "u2"],
  });
  assert.equal(saved.amount_minor, 50000);
  assert.equal(saved.currency, "HKD");
  assert.equal(saved.fx_rate, 0.195);
  // 9750円を2人で等分する。HKD の 50000 を配ってはいけない。
  assert.deepEqual(Array.from(saved.shares, (share) => [share.user_id, share.amount_base_minor]), [
    ["u1", 4875],
    ["u2", 4875],
  ]);
});

test("個別金額も費用の通貨で受け取り、換算の丸め残りは最大の負担へ寄せる", async () => {
  let saved = null;
  const store = expenseStoreWith({
    addExpense: async (_planId, input) => { saved = input; return { id: "exp_1" }; },
  });
  // 1 USD = 151.7円。支払 20.00 USD = 3034円。個別は 12.34 / 7.66 USD。
  const rate = fxRateFromUnitRate(151.7, "USD", "JPY");
  await store.add("pln_1", {
    payerUserId: "u1",
    amountMinor: toMinor(20, "USD"),
    currency: "USD",
    fxRate: rate,
    splitMethod: "custom",
    memberIds: ["u1", "u2"],
    customAmounts: { u1: toMinor(12.34, "USD"), u2: toMinor(7.66, "USD") },
  });
  const total = saved.shares.reduce((sum, share) => sum + share.amount_base_minor, 0);
  // APIは合計＝支払額の完全一致を要求するので、1円のずれも残してはいけない。
  assert.equal(total, saved.amount_base_minor ?? Math.round(saved.amount_minor * saved.fx_rate));
  assert.equal(total, 3034);
});

test("等分の端数は先頭から1単位ずつ配り、合計を支払額に一致させる", () => {
  const store = expenseStoreWith({});
  const shares = store.computeShares({
    amountBaseMinor: 1000,
    splitMethod: "equal_all",
    memberIds: ["u1", "u2", "u3"],
  });
  assert.deepEqual(Array.from(shares, (s) => s.amount_base_minor), [334, 333, 333]);
  assert.equal(shares.reduce((sum, s) => sum + s.amount_base_minor, 0), 1000);
});

test("個別金額の入力ミスは寄せずに残し、APIの検証へ渡す", () => {
  const store = expenseStoreWith({});
  // 1000 に対して合計 900。丸めでは説明できないずれなので黙って直さない。
  const shares = store.computeShares({
    amountBaseMinor: 1000,
    splitMethod: "custom",
    memberIds: ["u1", "u2"],
    customAmounts: { u1: 500, u2: 400 },
  });
  assert.equal(shares.reduce((sum, s) => sum + s.amount_base_minor, 0), 900);
});

test("負担額の集計は user_id で持つ（同名メンバーで潰れない）", () => {
  const rows = [
    { id: "e1", plan_id: "p1", payer_user_id: "u1", amount_base_minor: 1000, amount_minor: 1000,
      currency: "JPY", fx_rate: 1, category: "food", title: "昼食", split_method: "equal_all", deleted_at: null },
  ];
  const shares = [
    { expense_id: "e1", user_id: "u1", amount_base_minor: 500 },
    { expense_id: "e1", user_id: "u2", amount_base_minor: 500 },
  ];
  const store = expenseStoreWith({
    expenses: () => rows,
    expenseShares: () => shares,
    settlements: () => [],
    // 2人とも同じ表示名。名前をキーにすると片方が消える。
    nameOf: () => "たろう",
    planMemberName: () => "たろう",
  });
  const settlement = store.computeSettlement("p1", ["u1", "u2"], "u1");
  assert.deepEqual({ ...settlement.expenseByPerson }, { u1: 500, u2: 500 });
  assert.equal(settlement.expenseTotal, "¥1,000");
});

test("費用明細も同名メンバーをuser_idで区別できる", () => {
  const rows = [
    { id: "e1", plan_id: "p1", payer_user_id: "u1", amount_base_minor: 1000, amount_minor: 1000,
      currency: "JPY", fx_rate: 1, category: "food", title: "昼食", split_method: "custom", deleted_at: null },
  ];
  const shares = [
    { expense_id: "e1", user_id: "u1", amount_base_minor: 700 },
    { expense_id: "e1", user_id: "u2", amount_base_minor: 300 },
  ];
  const store = expenseStoreWith({
    expenses: () => rows,
    expenseShares: () => shares,
    settlements: () => [],
    nameOf: () => "たろう",
    planMemberName: () => "たろう",
  });
  const detail = store.computeSettlement("p1", ["u1", "u2"], "u2").expenseDetails[0];
  assert.equal(detail.payerId, "u1");
  assert.deepEqual(Array.from(detail.targetIds), ["u1", "u2"]);
  assert.deepEqual(Array.from(detail.shares, (share) => share.userId), ["u1", "u2"]);
  assert.equal(detail.myShareLabel, "¥300");
});

const expenseForm = load("src/shared/expense-form.ts", {
  "./country": load("src/shared/country.ts"),
  "./currency": currency,
});

test("通貨候補は行き先の座標から出し、JPYとUSDを常に添える", () => {
  const macau = expenseForm.expenseCurrencyCodes({
    cities: [
      { name: "マカオ", lat: 22.15, lng: 113.55 },
      { name: "香港", lat: 22.32, lng: 114.17 },
    ],
  }, ["EUR", "THB", "AUD"]);
  // 行き先が分かるなら、設定に並べた世界中の通貨は混ぜない。
  assert.deepEqual(Array.from(macau), ["JPY", "MOP", "HKD", "USD"]);
});

test("座標が無い訪問地は地名から国を推定する", () => {
  const seoul = expenseForm.expenseCurrencyCodes({ cities: [{ name: "ソウル" }] }, ["EUR"]);
  assert.deepEqual(Array.from(seoul), ["JPY", "KRW", "USD"]);
});

test("国内旅行はJPYとUSDだけにする", () => {
  const domestic = expenseForm.expenseCurrencyCodes({
    cities: [{ name: "京都", lat: 35.0, lng: 135.77 }],
  }, ["EUR", "THB"]);
  assert.deepEqual(Array.from(domestic), ["JPY", "USD"]);
});

test("行き先を判定できない旅行だけ、設定の通貨一覧へ戻す", () => {
  const unknown = expenseForm.expenseCurrencyCodes({ cities: [{ name: "どこか" }] }, ["EUR", "THB"]);
  assert.deepEqual(Array.from(unknown), ["JPY", "EUR", "THB", "USD"]);
  const none = expenseForm.expenseCurrencyCodes({}, []);
  assert.deepEqual(Array.from(none), ["JPY", "USD"]);
});

test("現地情報に書かれた通貨コードも候補へ含める", () => {
  const codes = expenseForm.expenseCurrencyCodes({
    cities: [{ name: "台北", lat: 25.03, lng: 121.56 }],
    localInfo: [{ currencyCode: "twd" }, { 通貨コード: "CNY" }],
  }, []);
  assert.deepEqual(Array.from(codes), ["JPY", "TWD", "CNY", "USD"]);
});

test("通貨コードには国旗を添える（ユーロはEU旗）", () => {
  assert.equal(currency.currencyLabel("JPY"), "🇯🇵 JPY");
  assert.equal(currency.currencyLabel("EUR"), "🇪🇺 EUR");
  assert.equal(currency.currencyLabel("twd"), "🇹🇼 TWD");
  assert.equal(currency.currencyLabel("MOP"), "🇲🇴 MOP");
  // 表に無い通貨でもコードだけは必ず返す。
  assert.equal(currency.currencyLabel("ZZZ"), "ZZZ");
  assert.equal(currency.currencyFlag("ZZZ"), "");
});

test("台湾・ヨーロッパ・イギリスの旅行で現地通貨が候補に出る", () => {
  const taiwan = expenseForm.expenseCurrencyCodes({ cities: [{ name: "台北", lat: 25.03, lng: 121.56 }] }, []);
  assert.deepEqual(Array.from(taiwan), ["JPY", "TWD", "USD"]);
  const europe = expenseForm.expenseCurrencyCodes({
    cities: [
      { name: "パリ", lat: 48.86, lng: 2.35 },
      { name: "ロンドン", lat: 51.51, lng: -0.13 },
      { name: "チューリッヒ", lat: 47.37, lng: 8.54 },
    ],
  }, []);
  assert.deepEqual(Array.from(europe), ["JPY", "EUR", "GBP", "CHF", "USD"]);
});
