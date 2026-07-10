// レシート写真の圧縮とアップロード。dashboard / expense-entry で共通利用する。
// 大きい画像は 1600px 以内・JPEG 品質 0.78 程度まで縮小してからアップロードする。

import { postAppsScript, type AppsScriptResponse } from "./apps-script";

export interface PreparedPhoto {
  fileName: string;
  mimeType: string;
  data: string;
}

const MAX_JPEG_SIDE = 1600;
const JPEG_QUALITY = 0.78;
export const MAX_RECEIPT_BASE64_LENGTH = 7000000;
// backend/src/main.ts の ALLOWED_RECEIPT_MIME_TYPES と揃える。image/svg+xml 等の
// スクリプト実行可能な形式は、サーバー側で弾かれる前にここで早期に拒否する。
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result || ""));
    reader.onerror = (): void => reject(new Error("写真を読み込めませんでした"));
    reader.readAsDataURL(file);
  });
}

function imageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = (): void => resolve(image);
    image.onerror = (): void => reject(new Error("写真を処理できませんでした"));
    image.src = dataUrl;
  });
}

export async function prepareReceiptPhoto(file: File): Promise<PreparedPhoto> {
  const originalDataUrl = await fileAsDataUrl(file);
  if (!/^image\//.test(file.type || "")) {
    throw new Error("画像ファイルを選択してください");
  }

  try {
    const image = await imageFromDataUrl(originalDataUrl);
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, MAX_JPEG_SIDE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas context を取得できませんでした");
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    // canvas 経由で JPEG に再エンコード済みなので、元ファイルの形式によらず安全。
    return {
      fileName: String(file.name || "receipt.jpg").replace(/\.[^.]+$/, "") + ".jpg",
      mimeType: "image/jpeg",
      data: dataUrl.split(",")[1] || "",
    };
  } catch {
    // canvas 処理に失敗した場合は元データをそのまま送るため、ここでは
    // サーバーと同じ許可リストで検証する（image/svg+xml 等を弾く）。
    const mimeType = (file.type || "").toLowerCase();
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error("画像ファイル（JPEG/PNG/WebP/HEIC）を選択してください");
    }
    return {
      fileName: file.name || "receipt.jpg",
      mimeType,
      data: originalDataUrl.split(",")[1] || "",
    };
  }
}

/** レシート写真を圧縮して Apps Script にアップロードする。 */
export async function uploadReceiptPhoto(
  appsScriptUrl: string,
  token: string,
  file: File,
): Promise<AppsScriptResponse> {
  const prepared = await prepareReceiptPhoto(file);
  if (!prepared.data) throw new Error("写真データがありません");
  if (prepared.data.length > MAX_RECEIPT_BASE64_LENGTH) {
    throw new Error("写真サイズが大きすぎます。小さめの画像で再試行してください");
  }
  return postAppsScript(
    appsScriptUrl,
    {
      action: "receiptUpload",
      token,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      data: prepared.data,
    },
    {
      source: "trip-expense-receipt-upload",
      idPrefix: "receipt",
      timeoutMessage: "写真アップロードがタイムアウトしました",
      failMessage: "写真アップロードに失敗しました",
    },
  );
}
