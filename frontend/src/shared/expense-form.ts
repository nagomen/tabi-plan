// 費用入力UIが共通で使う、取得元の緩いデータからの選択肢抽出。

interface ExpenseFormSource {
  participants?: unknown;
  trip?: { members?: unknown } | null;
  localInfo?: unknown;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function expenseParticipantNames(source: ExpenseFormSource, fallback: string[] = []): string[] {
  const raw = Array.isArray(source.participants) ? source.participants : [];
  const participants = raw.map((member) => {
    if (typeof member === "string") return member;
    if (!member || typeof member !== "object") return "";
    const record = member as Record<string, unknown>;
    return String(record.name || record.displayName || record["表示名"] || "");
  });
  const fromParticipants = unique(participants);
  if (fromParticipants.length) return fromParticipants;

  const fromMembers = String(source.trip?.members || "")
    .split(/\s*\/\s*|、|,|\n/)
    .map((name) => name.trim())
    .filter((name) => name && !/\d+人|共有メンバー/.test(name));
  return fromMembers.length ? unique(fromMembers) : unique(fallback);
}

export function expenseCurrencyCodes(source: ExpenseFormSource, configured: string[] = []): string[] {
  const localInfo = Array.isArray(source.localInfo) ? source.localInfo : [];
  const discovered = localInfo.map((row) => {
    if (!row || typeof row !== "object") return "";
    const record = row as Record<string, unknown>;
    return String(record.currencyCode || record.currency || record["通貨コード"] || "");
  });
  return unique(["JPY", ...configured, ...discovered].map((code) => code.toUpperCase()));
}

export interface ExpenseSplitController {
  mode: () => string;
  amount: () => number;
  selectedNames: () => string[];
  individualAmounts: () => Record<string, number>;
  individualTotal: () => number;
  validationMessage: () => string;
  refresh: () => void;
}

function numericValue(value: unknown): number {
  const parsed = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 割り勘モードの表示切替・合計表示・共通検証をフォームへ結び付ける。 */
export function bindExpenseSplitForm(
  form: HTMLFormElement,
  participants: string[],
  options: { onChange?: (event: Event) => void; onInput?: (event: Event) => void } = {},
): ExpenseSplitController {
  const selectedDetail = form.querySelector<HTMLElement>("[data-selected-detail]");
  const individualDetail = form.querySelector<HTMLElement>("[data-individual-detail]");
  const totalNode = form.querySelector<HTMLElement>("[data-share-total]");
  const amountInput = form.elements.namedItem("amount") as HTMLInputElement | null;
  const currencyInput = form.elements.namedItem("currency") as HTMLSelectElement | null;
  if (!selectedDetail || !individualDetail || !totalNode || !amountInput || !currencyInput) {
    throw new Error("費用の割り勘フォームが不完全です");
  }

  const mode = (): string => form.querySelector<HTMLInputElement>("input[name='splitMode']:checked")?.value || "";
  const shareInputFor = (name: string): HTMLInputElement | undefined =>
    Array.from(form.querySelectorAll<HTMLInputElement>("[data-share-name]"))
      .find((input) => input.dataset.shareName === name);
  const individualAmounts = (): Record<string, number> => Object.fromEntries(
    participants.map((name) => [name, numericValue(shareInputFor(name)?.value)]).filter(([, value]) => Number(value) > 0),
  );
  const individualTotal = (): number =>
    Object.values(individualAmounts()).reduce((sum, value) => sum + value, 0);
  const amount = (): number => numericValue(amountInput.value);
  const selectedNames = (): string[] => Array.from(
    form.querySelectorAll<HTMLInputElement>("input[name='targets']:checked"),
  ).map((input) => input.value);
  const formatAmount = (value: number): string => {
    const currency = currencyInput.value || "JPY";
    return currency === "JPY"
      ? `¥${Math.round(value).toLocaleString("ja-JP")}`
      : `${currency} ${Math.round(value * 100) / 100}`;
  };
  const update = (): void => {
    const activeMode = mode();
    selectedDetail.classList.toggle("is-visible", /選んだ人だけ/.test(activeMode));
    individualDetail.classList.toggle("is-visible", /個別金額/.test(activeMode));
    const total = individualTotal();
    const paid = amount();
    totalNode.textContent = paid
      ? `合計 ${formatAmount(total)} / 支払額 ${formatAmount(paid)}`
      : `合計 ${formatAmount(total)}`;
    totalNode.style.color = /個別金額/.test(activeMode) && paid && Math.abs(total - paid) > 1
      ? "var(--red)"
      : "var(--muted)";
  };
  const validationMessage = (): string => {
    if (/選んだ人だけ/.test(mode()) && !selectedNames().length) return "割り勘する人を1人以上選んでください。";
    if (/個別金額/.test(mode())) {
      const total = individualTotal();
      if (!total) return "個別金額を入力してください。";
      if (Math.abs(total - amount()) > 1) return "個別金額の合計が支払額と一致していません。";
    }
    return "";
  };

  form.addEventListener("change", (event) => {
    update();
    options.onChange?.(event);
  });
  form.addEventListener("input", (event) => {
    update();
    options.onInput?.(event);
  });
  update();
  return { mode, amount, selectedNames, individualAmounts, individualTotal, validationMessage, refresh: update };
}
