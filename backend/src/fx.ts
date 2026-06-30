// 為替レートの索引・解決・履歴取得（外部APIフェッチを含む）と通貨フォーマット。


function buildExchangeRateIndex_(rows: SheetRow[]): Record<string, ExchangeRate[]> {
  const index: Record<string, ExchangeRate[]> = {};
  (rows || []).forEach(row => {
    const date = normalizeDate_(valueByKeys_(row, ['日付', 'date', 'rateDate']));
    const currency = normalizeCurrency_(valueByKeys_(row, ['通貨', 'currency']));
    const rate = parseRate_(valueByKeys_(row, ['円換算レート', 'JPYレート', 'rateToJpy', 'rate', 'レート']));
    if (!date || !currency || !rate) return;
    if (!index[currency]) index[currency] = [];
    index[currency].push({ date, value: rate });
  });
  Object.keys(index).forEach(currency => {
    index[currency].sort((a, b) => a.date.localeCompare(b.date));
  });
  return index;
}

// シートと既存キャッシュだけでレートを解決する（ネットワークアクセスを伴わない）。
function resolveExchangeRate_(index: Record<string, ExchangeRate[]>, currency: string, paidDate: string): ExchangeRate | null {
  const code = normalizeCurrency_(currency || 'JPY');
  if (code === 'JPY') return { date: paidDate || '', value: 1 };
  const rates = index[code] || [];
  const date = normalizeDate_(paidDate);
  if (!date && rates.length) return rates[rates.length - 1];
  let matched: ExchangeRate | null = null;
  rates.forEach(rate => {
    if (rate.date <= date) matched = rate;
  });
  return matched || cachedHistoricalExchangeRate_(code, date);
}

// 1回のダッシュボード構築で使い回すレート解決器を作る。
// 同じ(通貨,日付)はメモ化して重複参照を防ぎ、外部 API への取得は構築ごと
// FX_FETCH_LIMIT_PER_BUILD 件までに制限する。これにより、未設定レートが多い場合でも
// 逐次 UrlFetch が実行時間上限/クォータを超えて data 取得全体を失敗させることを防ぐ。
const FX_FETCH_LIMIT_PER_BUILD = 20;
function makeRateResolver_(index: Record<string, ExchangeRate[]>, runtimeOptions: RuntimeOptions): (currency: string, paidDate: string) => ExchangeRate | null {
  const memo: Record<string, ExchangeRate | null> = {};
  let fetchBudget = (runtimeOptions && runtimeOptions.allowFxFetch) ? FX_FETCH_LIMIT_PER_BUILD : 0;
  return function (currency: string, paidDate: string): ExchangeRate | null {
    const code = normalizeCurrency_(currency || 'JPY');
    const date = normalizeDate_(paidDate);
    if (code === 'JPY') return { date: date || '', value: 1 };
    const key = `${code}|${date}`;
    if (Object.prototype.hasOwnProperty.call(memo, key)) return memo[key];

    let rate = resolveExchangeRate_(index, code, date);
    if (!rate && fetchBudget > 0) {
      fetchBudget -= 1;
      rate = fetchHistoricalExchangeRate_(code, date);
    }
    memo[key] = rate;
    return rate;
  };
}

function fetchHistoricalExchangeRate_(currency: string, paidDate: string): ExchangeRate | null {
  const code = normalizeCurrency_(currency);
  const start = normalizeDate_(paidDate);
  if (!code || !start) return null;
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (start > today) return null;

  const cache = CacheService.getScriptCache();
  for (let offset = 0; offset <= 7; offset++) {
    const date = offsetDate_(start, -offset);
    const cacheKey = `fx_${code}_${date}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      const value = parseRate_(cached);
      if (value) return { date, value, source: 'currency-api' };
    }

    const url = `https://cdn.jsdelivr.net/gh/fawazahmed0/currency-api@1/${date}/currencies/${code.toLowerCase()}/jpy.json`;
    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) continue;
      const json = JSON.parse(response.getContentText());
      const value = parseRate_(json.jpy);
      if (!value) continue;
      cache.put(cacheKey, String(value), 21600);
      return { date: json.date || date, value, source: 'currency-api' };
    } catch (error) {
      continue;
    }
  }
  try {
    CacheService.getScriptCache().put(`fx_${code}_${start}`, 'MISS', 21600);
  } catch (error) {
    // Best-effort miss cache.
  }
  return null;
}

function cachedHistoricalExchangeRate_(currency: string, paidDate: string): ExchangeRate | null {
  const code = normalizeCurrency_(currency);
  const start = normalizeDate_(paidDate);
  if (!code || !start) return null;

  const cache = CacheService.getScriptCache();
  for (let offset = 0; offset <= 7; offset++) {
    const date = offsetDate_(start, -offset);
    const cached = cache.get(`fx_${code}_${date}`);
    if (!cached || cached === 'MISS') continue;
    const value = parseRate_(cached);
    if (value) return { date, value, source: 'cache' };
  }
  return null;
}

function offsetDate_(dateText: string, days: number): string {
  const parts = normalizeDate_(dateText).split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return '';
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  date.setUTCDate(date.getUTCDate() + days);
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

function recentRateDetails_(details: any[]): any[] {
  return (details || [])
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 10);
}

function normalizeCurrency_(value: any): string {
  return String(value || '').trim().toUpperCase();
}

function parseRate_(value: any): number {
  const n = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatCurrencyAmount_(amount: number, currency: string): string {
  const code = normalizeCurrency_(currency || 'JPY');
  const value = Math.round((Number(amount) || 0) * 100) / 100;
  if (code === 'JPY') return formatYen_(value);
  return `${code} ${value.toLocaleString('ja-JP')}`;
}
