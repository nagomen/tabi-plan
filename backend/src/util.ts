// 値のパース/正規化/フォーマットなどの小さなユーティリティ。


function errorMessage_(error: unknown): string {
  return (error instanceof Error && error.message) || String(error);
}

/** シートのread-modify-writeを直列化する共通境界。 */
function withScriptLock_<T>(work: () => T, timeoutMs = 10000): T {
  const lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs);
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

function valueByKeys_(row: SheetRow, keys: string[]): any {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

function parsePeople_(value: any): string[] {
  return String(value || '')
    .split(/[,、\n]/)
    .map(name => name.trim())
    .filter(Boolean);
}

function parseJsonArray_(value: any): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(item => String(item).trim()).filter(Boolean) : [];
  } catch (error) {
    return parsePeople_(value);
  }
}

function parseJsonObject_(value: any): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function normalizeDate_(value: any): string {
  const text = String(value || '').trim().replace(/\//g, '-');
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function parseYen_(value: any): number {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseCoordinate_(value: any): number | '' {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : '';
}

function formatYen_(value: number): string {
  return value ? '¥' + Math.round(value).toLocaleString('ja-JP') : '未入力';
}

function formatYenZero_(value: any): string {
  return '¥' + Math.round(Number(value) || 0).toLocaleString('ja-JP');
}

function sheetUrl_(spreadsheetId: string, sheetName: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0&range=${encodeURIComponent(sheetName + '!A1')}`;
}

function scriptProp_(key: string, fallback?: string): string {
  return PropertiesService.getScriptProperties().getProperty(key) || fallback || '';
}

function getSpreadsheetId_(props?: ScriptProps): string {
  const store = props || PropertiesService.getScriptProperties();
  const spreadsheetId = String(store.getProperty('TRIP_SPREADSHEET_ID') || DEFAULT_CONFIG.spreadsheetId || '').trim();
  if (!spreadsheetId) {
    throw new Error('TRIP_SPREADSHEET_ID is not configured. Run setupTripDashboard({ password, spreadsheetId, tripSlug, tripTitle }) first.');
  }
  return spreadsheetId;
}

function sanitizeTripSlug_(value: any): string {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'trip-dashboard';
}
