import { buildExpensePrintHtml, buildExpenseShareText } from "../shared/expense-summary";
import { flashLabel, root } from "./dom";
import { localSettlement } from "./settlement";
import { state } from "./state";

function setStatus(message: string, isError = false): void {
  const status = root.querySelector<HTMLElement>("[data-expense-share-status]");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function summaryInput() {
  return { trip: state.data.trip, settlement: localSettlement(), generatedAt: new Date() };
}

async function copyExpenseText(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flashLabel(button, "[data-expense-share-label]", "コピーしました");
    setStatus("明細をコピーしました。LINEやメールへ貼り付けて送れます。");
  } catch {
    window.prompt("費用明細をコピーしてください", text);
  }
}

async function shareExpenseText(button: HTMLButtonElement): Promise<void> {
  const text = buildExpenseShareText(summaryInput());
  if (navigator.share) {
    try {
      await navigator.share({ title: `${state.data.trip.title || "旅行"} 費用・精算明細`, text });
      setStatus("費用明細を共有しました。");
      return;
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return;
    }
  }
  await copyExpenseText(text, button);
}

function printExpensePdf(button: HTMLButtonElement): void {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setStatus("PDF画面を開けませんでした。ポップアップを許可してもう一度お試しください。", true);
    return;
  }
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(buildExpensePrintHtml(summaryInput()));
  printWindow.document.close();
  const openPrintDialog = (): void => {
    printWindow.focus();
    printWindow.print();
  };
  if (printWindow.document.readyState === "complete") {
    window.setTimeout(openPrintDialog, 100);
  } else {
    printWindow.addEventListener("load", () => window.setTimeout(openPrintDialog, 100), { once: true });
  }
  flashLabel(button, "[data-expense-pdf-label]", "PDF画面を開きました");
  setStatus("印刷画面で「PDFとして保存」を選ぶと、友人へ送れるPDFになります。");
}

export function setupExpenseSharing(): void {
  const shareButton = root.querySelector<HTMLButtonElement>("[data-expense-share]");
  const pdfButton = root.querySelector<HTMLButtonElement>("[data-expense-pdf]");
  shareButton?.addEventListener("click", () => void shareExpenseText(shareButton));
  pdfButton?.addEventListener("click", () => printExpensePdf(pdfButton));
}
