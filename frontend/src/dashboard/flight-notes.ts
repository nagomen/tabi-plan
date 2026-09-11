import { icon } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { isMemberOf } from "../shared/membership";
import type { FlightInfo, TrainInfo } from "../shared/flight-info";
import { currentUserId } from "../shared/identity";
import * as db from "../shared/db";
import { escapeHtml } from "../shared/dom";
import { CONFIG, hooks } from "./state";
import { root } from "./dom";
import { planId } from "./plan-access";

/** 自分のこの便のメモ（リンク・予約番号・座席・QR）。無ければ null。 */
function myFlightNote(flightNo: string): db.FlightNoteRow | null {
  const me = currentUserId();
  const id = planId();
  if (!me || !id) return null;
  return db.flightNotes().find(
    (note) => note.plan_id === id && note.user_id === me && note.flight_no === flightNo,
  ) || null;
}

/** 便メモを編集できるか（＝ログイン済みの参加者本人）。 */
function canEditFlightNote(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return Boolean(currentUserId() && meta && isMemberOf(meta));
}

/**
 * 飛行機の移動を、航空券（搭乗券）風のカードで見せる。
 * 発着（空港コード＋時刻）がパースできた便は 出発↔到着 を大きく、
 * できない便は出発地・到着地の名前で同じレイアウトに落とす。
 * 自分の便メモがあれば下段（半券の下）に座席・予約番号・QRを出し、
 * リンク設定時はカード全体を押すとそのページが開く。
 */
export function flightTicketHtml(
  flight: FlightInfo,
  duration: string | undefined,
  originName: string,
  destinationName: string,
): string {
  const hasTimes = Boolean(flight.dep && flight.arr);
  const end = (code: string, time: string, arr: boolean): string =>
    `<span class="tl-ticket-end${arr ? " is-arr" : ""}">` +
    `<b class="tl-ticket-code${hasTimes ? "" : " is-name"}">${escapeHtml(code)}</b>` +
    (time ? `<span class="tl-ticket-time">${escapeHtml(time)}</span>` : "") +
    `</span>`;
  const depEnd = hasTimes && flight.dep
    ? end(flight.dep.code, flight.dep.time, false)
    : originName ? end(originName, "", false) : "";
  const arrEnd = hasTimes && flight.arr
    ? end(flight.arr.code, flight.arr.time, true)
    : destinationName ? end(destinationName, "", true) : "";

  // 自分だけの搭乗情報（座席・予約番号・QR）。他人には自分のものしか見えない。
  const note = myFlightNote(flight.flightNo);
  const editable = canEditFlightNote();
  const chips: string[] = [];
  if (note?.seat) chips.push(`<span class="tl-ticket-chip">座席 ${escapeHtml(note.seat)}</span>`);
  if (note?.booking_ref) chips.push(`<span class="tl-ticket-chip">予約 ${escapeHtml(note.booking_ref)}</span>`);
  if (note?.qr_image) {
    chips.push(
      `<button type="button" class="tl-ticket-chip is-action" data-flight-qr="${escapeHtml(flight.flightNo)}">` +
      `${icon("photo")}QR</button>`,
    );
  }
  if (editable) {
    chips.push(note
      ? `<button type="button" class="tl-ticket-edit" data-flight-edit="${escapeHtml(flight.flightNo)}"` +
        ` aria-label="自分の便情報を編集" title="自分の便情報を編集">${icon("pencilSquare")}</button>`
      : `<button type="button" class="tl-ticket-chip is-action" data-flight-edit="${escapeHtml(flight.flightNo)}">` +
        `${icon("plus")}予約番号・座席・QR</button>`);
  }
  const footer = chips.length ? `<div class="tl-ticket-foot">${chips.join("")}</div>` : "";
  const linkUrl = note?.link_url && /^https?:\/\//i.test(note.link_url) ? note.link_url : "";
  const linkAttrs = linkUrl
    ? ` data-flight-open="${escapeHtml(linkUrl)}" role="link" tabindex="0" title="タップで予約ページを開く"`
    : "";
  return `<div class="tl-ticket${linkUrl ? " is-link" : ""}"${linkAttrs}>` +
    `<div class="tl-ticket-head">` +
    `<span class="tl-ticket-airline">${escapeHtml(flight.airline || "Flight")}</span>` +
    `<span class="tl-ticket-no">${icon("paperAirplane")}${escapeHtml(flight.flightNo)}${linkUrl ? icon("arrowTopRightOnSquare") : ""}</span>` +
    `</div>` +
    `<div class="tl-ticket-divider" aria-hidden="true"></div>` +
    `<div class="tl-ticket-route">` +
    depEnd +
    `<span class="tl-ticket-path">` +
    `<span class="tl-ticket-path-line">${icon("paperAirplane")}</span>` +
    (duration ? `<span class="tl-ticket-dur">${escapeHtml(duration)}</span>` : "") +
    `</span>` +
    arrEnd +
    `</div>` +
    footer +
    `</div>`;
}

/**
 * 特急・新幹線・台湾鉄路などの移動を、必要最低限の乗車券カードで見せる。
 * 座席は「指定席」「自由席」など入力がある場合だけ表示し、個人別の詳細入力は必須にしない。
 */
export function trainTicketHtml(
  train: TrainInfo,
  duration: string | undefined,
  originName: string,
  destinationName: string,
  fallbackTime: string | undefined,
): string {
  const depStation = train.dep?.station || originName || "出発駅";
  const arrStation = train.arr?.station || destinationName || "到着駅";
  const depTime = train.dep?.time || fallbackTime || "";
  const arrTime = train.arr?.time || "";
  const end = (station: string, time: string, arr = false): string =>
    `<span class="tl-train-end${arr ? " is-arr" : ""}">` +
    (time ? `<b class="tl-train-time">${escapeHtml(time)}</b>` : "") +
    `<span class="tl-train-station">${escapeHtml(station)}</span>` +
    `</span>`;

  return `<div class="tl-train-card">` +
    `<div class="tl-train-head">` +
    `<span class="tl-train-service">${icon("ticket")}${escapeHtml(train.serviceName || "Train")}</span>` +
    (train.seat ? `<span class="tl-train-seat">${escapeHtml(train.seat)}</span>` : "") +
    `</div>` +
    `<div class="tl-train-route">` +
    end(depStation, depTime) +
    `<span class="tl-train-mid">${icon("arrowLongRight")}${duration ? `<small>${escapeHtml(duration)}</small>` : ""}</span>` +
    end(arrStation, arrTime, true) +
    `</div>` +
    `</div>`;
}

/** 自分のQRコードを大きく表示する（搭乗ゲートでそのまま見せられるサイズ）。 */
export function openFlightQr(flightNo: string): void {
  const note = myFlightNote(flightNo);
  if (!note?.qr_image || !/^data:image\//.test(note.qr_image)) return;
  const modal = document.createElement("div");
  modal.className = "tl-confirm-modal tl-qr-modal";
  modal.innerHTML = `
    <div class="tl-confirm-scrim" data-qr-close></div>
    <section class="tl-confirm-card tl-qr-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(flightNo)} のQRコード">
      <p class="tl-qr-title">${icon("paperAirplane")}${escapeHtml(flightNo)}${note.seat ? ` ・ 座席 ${escapeHtml(note.seat)}` : ""}</p>
      <img class="tl-qr-image" src="${escapeHtml(note.qr_image)}" alt="搭乗用QRコード">
      <button type="button" class="tl-confirm-cancel" data-qr-close>閉じる</button>
    </section>`;
  // body 直下だと .trip-live のフォント・色トークンが当たらないため root 配下に置く
  root.appendChild(modal);
  modal.querySelectorAll<HTMLElement>("[data-qr-close]").forEach((el) => {
    el.addEventListener("click", () => modal.remove());
  });
}

const MAX_QR_DATA_URL_LENGTH = 300_000;

/**
 * QR画像を縮小して data URL にする。QRは輪郭が命なので PNG（可逆）を優先し、
 * 収まらないときだけ高品質 WebP に落とす。
 */
function fileToQrDataUrl(file: File): Promise<string> {
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
        const attempts: { maxSize: number; type: string; quality?: number }[] = [
          { maxSize: 640, type: "image/png" },
          { maxSize: 480, type: "image/png" },
          { maxSize: 360, type: "image/png" },
          { maxSize: 640, type: "image/webp", quality: 0.92 },
        ];
        for (const attempt of attempts) {
          const scale = Math.min(1, attempt.maxSize / Math.max(nw, nh));
          canvas.width = Math.max(1, Math.round(nw * scale));
          canvas.height = Math.max(1, Math.round(nh * scale));
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL(attempt.type, attempt.quality);
          if (dataUrl.length <= MAX_QR_DATA_URL_LENGTH) {
            resolve(dataUrl);
            return;
          }
        }
        reject(new Error("画像を十分に小さくできませんでした。QR部分を切り抜いた画像を選んでください"));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/** 自分の便メモ（リンク・予約番号・座席・QR）を編集するモーダル。 */
export function openFlightNoteEditor(flightNo: string): void {
  const me = currentUserId();
  const id = planId();
  if (!me || !id || !canEditFlightNote()) return;
  const note = myFlightNote(flightNo);
  let qrImage = note?.qr_image || "";
  const modal = document.createElement("div");
  modal.className = "tl-confirm-modal tl-fnote-modal";
  modal.innerHTML = `
    <div class="tl-confirm-scrim" data-fnote-cancel></div>
    <section class="tl-confirm-card tl-fnote-card" role="dialog" aria-modal="true" aria-labelledby="fnoteTitle">
      <div class="tl-fnote-head">
        <span class="tl-fnote-plane">${icon("paperAirplane")}</span>
        <span class="tl-fnote-headtext">
          <b id="fnoteTitle">${escapeHtml(flightNo)}</b>
          <span>自分用メモ ・ 自分にだけ表示されます</span>
        </span>
      </div>
      <div class="tl-fnote-divider" aria-hidden="true"></div>
      <div class="tl-fnote-body">
        <label class="tl-fnote-field">
          <span>リンク（カードを押すと開く）</span>
          <input type="url" data-fnote-link placeholder="https://…（予約確認ページなど）" value="${escapeHtml(note?.link_url || "")}">
        </label>
        <div class="tl-fnote-grid">
          <label class="tl-fnote-field">
            <span>予約番号</span>
            <input type="text" data-fnote-ref maxlength="100" placeholder="ABC123" value="${escapeHtml(note?.booking_ref || "")}">
          </label>
          <label class="tl-fnote-field">
            <span>座席</span>
            <input type="text" data-fnote-seat maxlength="50" placeholder="32A" value="${escapeHtml(note?.seat || "")}">
          </label>
        </div>
        <div class="tl-fnote-field">
          <span>QRコード画像</span>
          <div class="tl-fnote-qr">
            <img data-fnote-qr-preview alt="QRコードのプレビュー"${qrImage ? ` src="${escapeHtml(qrImage)}"` : " hidden"}>
            <label class="tl-fnote-qr-pick">${icon("photo")}画像を選ぶ<input type="file" accept="image/*" data-fnote-qr hidden></label>
            <button type="button" class="tl-fnote-qr-clear" data-fnote-qr-clear${qrImage ? "" : " hidden"}>削除</button>
          </div>
        </div>
        <p class="tl-fnote-status" data-fnote-status aria-live="polite"></p>
        <div class="tl-fnote-actions">
          <button type="button" class="tl-fnote-cancel" data-fnote-cancel>キャンセル</button>
          <button type="button" class="tl-fnote-save" data-fnote-save>${icon("check")}保存</button>
        </div>
      </div>
    </section>`;
  // body 直下だと .trip-live のフォント・色トークンが当たらないため root 配下に置く
  root.appendChild(modal);
  const field = <T extends HTMLElement>(selector: string): T => modal.querySelector<T>(selector) as T;
  const status = field<HTMLElement>("[data-fnote-status]");
  const preview = field<HTMLImageElement>("[data-fnote-qr-preview]");
  const clearButton = field<HTMLButtonElement>("[data-fnote-qr-clear]");
  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  };
  const syncQr = (): void => {
    preview.hidden = !qrImage;
    if (qrImage) preview.src = qrImage;
    else preview.removeAttribute("src");
    clearButton.hidden = !qrImage;
  };
  field<HTMLInputElement>("[data-fnote-qr]").addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    fileToQrDataUrl(file)
      .then((dataUrl) => { qrImage = dataUrl; syncQr(); setStatus(""); })
      .catch((error) => setStatus((error as Error).message, true));
  });
  clearButton.addEventListener("click", () => { qrImage = ""; syncQr(); });
  modal.querySelectorAll<HTMLElement>("[data-fnote-cancel]").forEach((el) => {
    el.addEventListener("click", () => modal.remove());
  });
  field<HTMLButtonElement>("[data-fnote-save]").addEventListener("click", () => {
    const linkUrl = field<HTMLInputElement>("[data-fnote-link]").value.trim();
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
      setStatus("リンクは http(s):// で始まるURLにしてください", true);
      return;
    }
    db.setFlightNote(id, me, flightNo, {
      link_url: linkUrl,
      booking_ref: field<HTMLInputElement>("[data-fnote-ref]").value.trim(),
      seat: field<HTMLInputElement>("[data-fnote-seat]").value.trim(),
      qr_image: qrImage,
    });
    modal.remove();
    hooks.renderActive();
  });
}
