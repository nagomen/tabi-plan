import { errorMessage } from "../shared/dom";
import { planCoverThumbnail } from "../shared/cover";
import { model } from "./editor-state";
import { statusEl, coverInput, coverClearBtn, coverPreview } from "./editor-dom";
import { markDirty } from "./persist";

// ---- サムネ画像（任意・未設定なら自動/デフォルト） ----------------------
// 選んだ画像は canvas で小容量 WebP に変換し、上限を超える画像は保存しない。

const MAX_COVER_DATA_URL_LENGTH = 300_000;

/** 画像ファイルを縮小し、API/DBの契約内に収まる WebP data URL に変換する。 */
function fileToWebpDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type || "")) {
      reject(new Error("画像ファイルを選択してください"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = (): void => reject(new Error("画像を読み込めませんでした"));
    reader.onload = (): void => {
      const img = new Image();
      img.onerror = (): void => reject(new Error("画像を処理できませんでした"));
      img.onload = (): void => {
        const nw = img.naturalWidth || img.width;
        const nh = img.naturalHeight || img.height;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas を初期化できませんでした"));
          return;
        }
        const attempts = [
          { maxSize: 720, quality: 0.78 },
          { maxSize: 560, quality: 0.70 },
          { maxSize: 420, quality: 0.64 },
        ];
        for (const attempt of attempts) {
          const scale = Math.min(1, attempt.maxSize / Math.max(nw, nh));
          canvas.width = Math.max(1, Math.round(nw * scale));
          canvas.height = Math.max(1, Math.round(nh * scale));
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/webp", attempt.quality);
          if (dataUrl.length <= MAX_COVER_DATA_URL_LENGTH) {
            resolve(dataUrl);
            return;
          }
        }
        reject(new Error("画像を十分に小さくできませんでした。別の画像を選んでください"));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/** プレビューに使う画像（手動設定があればそれ、無ければ目的地から自動/デフォルト）。 */
function previewCoverSrc(): string {
  return planCoverThumbnail({
    slug: model.slug,
    route: model.cities.map((c) => c.name).filter(Boolean).join("、"),
    title: model.title,
    cover: model.cover,
  });
}

export function updateCoverPreview(): void {
  coverPreview.style.backgroundImage = `url("${previewCoverSrc()}")`;
  coverPreview.classList.toggle("is-custom", Boolean(model.cover));
  coverClearBtn.hidden = !model.cover;
}

export function onCoverInputChange(): void {
  const file = coverInput.files && coverInput.files[0];
  coverInput.value = ""; // 同じファイルを再選択できるようにリセット
  if (!file) return;
  void fileToWebpDataUrl(file)
    .then((dataUrl) => {
      model.cover = dataUrl;
      updateCoverPreview();
      markDirty();
    })
    .catch((err) => {
      statusEl.textContent = errorMessage(err) || "画像を設定できませんでした";
      statusEl.className = "is-dirty";
    });
}

export function onCoverClearClick(): void {
  if (!model.cover) return;
  model.cover = "";
  updateCoverPreview();
  markDirty();
}
