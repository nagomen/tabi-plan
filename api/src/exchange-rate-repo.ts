// 支払日別の為替レートを取得し、同じ日付・通貨の再利用に備えて永続化する。
import mysql from "mysql2/promise";
import { all, pool } from "./db.js";
import { BadRequest, ExchangeRateUnavailable, NotFound } from "./errors.js";

const SOURCE = "frankfurter-v2";
const PROVIDER_BASE = "https://api.frankfurter.dev/v2";
const FETCH_TIMEOUT_MS = 8_000;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

export interface ResolvedExchangeRate {
  paid_on: string;
  currency: string;
  base_currency: string;
  unit_rate: number;
  fx_rate: number;
  source: string;
  source_date: string;
  cached: boolean;
}

interface StoredRateRow {
  paid_on: string;
  currency: string;
  base_currency: string;
  unit_rate: string | number;
  fx_rate: string | number;
  source: string;
  source_date: string;
}

function currencyCode(value: unknown): string {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new BadRequest("通貨コードの形式が正しくありません");
  return code;
}

function exactDate(value: unknown): string {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest("支払日の形式が正しくありません");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new BadRequest("支払日が正しくありません");
  }
  return date;
}

function currencyDecimals(code: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** 1通貨単位あたりの基準通貨額を、最小通貨単位どうしの倍率へ変換する。 */
export function unitRateToFxRate(unitRate: number, currency: string, baseCurrency: string): number {
  const rate = Number(unitRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new ExchangeRateUnavailable("為替レートの値が正しくありません");
  return rate * 10 ** currencyDecimals(baseCurrency) / 10 ** currencyDecimals(currency);
}

/** Frankfurter v2から、指定した暦日の単一通貨ペアを取得する。 */
export async function fetchHistoricalUnitRate(
  paidOn: string,
  currency: string,
  baseCurrency: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ unitRate: number; sourceDate: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${PROVIDER_BASE}/rate/${encodeURIComponent(currency.toLowerCase())}/${encodeURIComponent(baseCurrency.toLowerCase())}?date=${encodeURIComponent(paidOn)}`;
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if ([400, 404, 422].includes(response.status)) {
      throw new BadRequest(`${currency}から${baseCurrency}への支払日レートを取得できません`);
    }
    if (!response.ok) throw new ExchangeRateUnavailable("為替レート配信元へ接続できませんでした");
    const body = await response.json() as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown };
    const sourceDate = String(body.date || "");
    const unitRate = Number(body.rate);
    // 近い営業日を黙って流用しない。要求した日付と応答日付が完全一致するときだけ保存する。
    if (sourceDate !== paidOn || String(body.base || "").toUpperCase() !== currency ||
        String(body.quote || "").toUpperCase() !== baseCurrency || !Number.isFinite(unitRate) || unitRate <= 0) {
      throw new ExchangeRateUnavailable("指定した支払日の為替レートを確認できませんでした");
    }
    return { unitRate, sourceDate };
  } catch (error) {
    if (error instanceof BadRequest || error instanceof ExchangeRateUnavailable) throw error;
    throw new ExchangeRateUnavailable("為替レート配信元へ接続できませんでした");
  } finally {
    clearTimeout(timeout);
  }
}

async function storedRate(
  paidOn: string,
  currency: string,
  baseCurrency: string,
): Promise<StoredRateRow | undefined> {
  return (await all<StoredRateRow>(
    `SELECT paid_on, currency, base_currency, unit_rate, fx_rate, source, source_date
       FROM exchange_rates
      WHERE paid_on = ? AND currency = ? AND base_currency = ?
      LIMIT 1`,
    [paidOn, currency, baseCurrency],
  ))[0];
}

function response(row: StoredRateRow, cached: boolean): ResolvedExchangeRate {
  return {
    paid_on: row.paid_on,
    currency: row.currency,
    base_currency: row.base_currency,
    unit_rate: Number(row.unit_rate),
    fx_rate: Number(row.fx_rate),
    source: row.source,
    source_date: row.source_date,
    cached,
  };
}

/** 保存済みなら再取得せず返し、未保存の場合だけ取得してINSERTする。 */
export async function resolveExchangeRateForPlan(
  planId: string,
  paidOnValue: unknown,
  currencyValue: unknown,
): Promise<ResolvedExchangeRate> {
  const paidOn = exactDate(paidOnValue);
  const currency = currencyCode(currencyValue);
  const plan = (await all<{ base_currency: string }>(
    "SELECT base_currency FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [planId],
  ))[0];
  if (!plan) throw new NotFound("旅行計画が見つかりません");
  const baseCurrency = currencyCode(plan.base_currency || "JPY");
  if (currency === baseCurrency) {
    return {
      paid_on: paidOn,
      currency,
      base_currency: baseCurrency,
      unit_rate: 1,
      fx_rate: 1,
      source: "identity",
      source_date: paidOn,
      cached: true,
    };
  }

  const existing = await storedRate(paidOn, currency, baseCurrency);
  if (existing) return response(existing, true);

  const fetched = await fetchHistoricalUnitRate(paidOn, currency, baseCurrency);
  const fxRate = unitRateToFxRate(fetched.unitRate, currency, baseCurrency);
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT IGNORE INTO exchange_rates
       (paid_on, currency, base_currency, unit_rate, fx_rate, source, source_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [paidOn, currency, baseCurrency, fetched.unitRate, fxRate, SOURCE, fetched.sourceDate],
  );
  const saved = await storedRate(paidOn, currency, baseCurrency);
  if (!saved) throw new ExchangeRateUnavailable("取得した為替レートを保存できませんでした");
  return response(saved, result.affectedRows === 0);
}
