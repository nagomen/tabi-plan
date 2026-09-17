const MAX_BUDGET_KRW = 100_000_000;
const MAX_SESSIONS = 10;

export interface BudgetCalculatorOptions {
  currency?: string;
  maxBudget?: number;
}

function boundedNumber(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

/** 入力値をUIの制約内に正規化して、1回分の上限を整数の通貨単位で返す。 */
export function calculateSessionBudget(
  totalValue: string,
  sessionValue: string,
  maxBudget = MAX_BUDGET_KRW,
): number {
  const total = boundedNumber(totalValue, 0, maxBudget, 0);
  const sessions = boundedNumber(sessionValue, 1, MAX_SESSIONS, 1);
  return Math.floor(total / sessions);
}

/** 予算フォームを初期化する。計算規則はDOMから分離して単体検証可能にする。 */
export function initializeBudgetCalculator(options: BudgetCalculatorOptions = {}): void {
  const total = document.querySelector<HTMLInputElement>("[data-budget-total]");
  const sessions = document.querySelector<HTMLInputElement>("[data-budget-sessions]");
  const perSession = document.querySelector<HTMLElement>("[data-budget-per]");
  if (!total || !sessions || !perSession) return;

  const formatter = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: options.currency || "KRW",
    maximumFractionDigits: 0,
  });
  const update = (): void => {
    perSession.textContent = formatter.format(calculateSessionBudget(
      total.value,
      sessions.value,
      options.maxBudget ?? MAX_BUDGET_KRW,
    ));
  };

  total.addEventListener("input", update);
  sessions.addEventListener("input", update);
  update();
}
