import { DebtViewerError } from "./api";
import type { DebtPdf } from "./normalize";

function base64Bytes(data: string): ArrayBuffer {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new DebtViewerError("原本PDFのデータが壊れているため保存できません。送信者へお知らせください。", "PDFを取得できませんでした");
  }
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

/** 受け取ったPDFを端末へ保存させる。 */
export function savePdf(pdf: DebtPdf): void {
  const blob = new Blob([base64Bytes(pdf.data_base64)], { type: pdf.mime_type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pdf.filename;
  link.rel = "noopener";
  // Firefox は文書に入っていないリンクの click を無視する。
  document.body.append(link);
  link.click();
  link.remove();
  // モバイルやアプリ内ブラウザは保存開始が遅いので、すぐに失効させない。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
