// 便（飛行機の移動）ごとの個人メモ。リンク・予約番号・座席・QR画像（data URL）。
// 行程は保存のたびに全行を作り直して id が変わるため、便名でひも付ける。
import { pool } from "./db.js";
import { BadRequest } from "./errors.js";

const FLIGHT_NO_RE = /^[A-Z]{2,3}\d{1,4}$/;
const MAX_QR_DATA_URL_LENGTH = 300_000;

export interface FlightNoteInput {
  link_url: string;
  booking_ref: string;
  seat: string;
  qr_image: string;
}

/** 本人の便メモを保存する。全フィールド空なら行を消す。 */
export async function setFlightNote(
  planId: string,
  userId: string,
  flightNo: string,
  input: FlightNoteInput,
): Promise<void> {
  if (!FLIGHT_NO_RE.test(flightNo)) throw new BadRequest("便名の形式が不正です");
  const linkUrl = String(input.link_url || "").trim().slice(0, 500);
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) throw new BadRequest("リンクは http(s):// で始まるURLにしてください");
  const bookingRef = String(input.booking_ref || "").trim().slice(0, 100);
  const seat = String(input.seat || "").trim().slice(0, 50);
  const qrImage = String(input.qr_image || "").trim();
  if (qrImage && !/^data:image\//.test(qrImage)) throw new BadRequest("QRコードは画像を選択してください");
  if (qrImage.length > MAX_QR_DATA_URL_LENGTH) throw new BadRequest("QR画像が大きすぎます。別の画像を選んでください");

  if (!linkUrl && !bookingRef && !seat && !qrImage) {
    await pool.query(
      "DELETE FROM plan_flight_notes WHERE plan_id = ? AND user_id = ? AND flight_no = ?",
      [planId, userId, flightNo],
    );
    return;
  }
  await pool.query(
    `INSERT INTO plan_flight_notes (plan_id, user_id, flight_no, link_url, booking_ref, seat, qr_image)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE link_url = VALUES(link_url), booking_ref = VALUES(booking_ref),
       seat = VALUES(seat), qr_image = VALUES(qr_image)`,
    [planId, userId, flightNo, linkUrl || null, bookingRef || null, seat || null, qrImage || null],
  );
}
