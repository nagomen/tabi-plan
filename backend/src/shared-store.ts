// 静的フロント用の共有ストア。
// localStorage と同じ key/value JSON を Apps Script 管理のスプレッドシートへ保存する。

const APP_STORE_SHEET = '_AppStore';

function appStoreSpreadsheet_(): Spreadsheet {
  const props = PropertiesService.getScriptProperties();
  const storeId = props.getProperty('TRIP_STORE_SPREADSHEET_ID') || props.getProperty('TRIP_SPREADSHEET_ID') || DEFAULT_CONFIG.spreadsheetId;
  if (storeId) return SpreadsheetApp.openById(storeId);
  const ss = SpreadsheetApp.create('旅行ダッシュボード共有ストア');
  props.setProperty('TRIP_STORE_SPREADSHEET_ID', ss.getId());
  return ss;
}

function appStoreSheet_(): Sheet {
  const ss = appStoreSpreadsheet_();
  const sheet = getOrCreateSheet_(ss, APP_STORE_SHEET);
  ensureHeaderRow_(sheet, 1, ['key', 'value', 'updatedAt']);
  try {
    sheet.hideSheet();
  } catch (error) {
    // 唯一の可視シートだと隠せない。表示されたままでも動作に支障はない。
    Logger.log(`appStoreSheet_ hideSheet failed: ${errorMessage_(error)}`);
  }
  return sheet;
}

function validStoreKey_(key: string): string {
  const value = String(key || '').trim();
  if (!/^trip-dashboard-[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('Invalid store key');
  }
  return value;
}

function readStoreRows_(): SheetRow[] {
  const sheet = appStoreSheet_();
  return readObjects_(sheet, 1, 1, 3);
}

function handleStoreDump_(params: Params) {
  requireAuth_(params);
  const out: Record<string, any> = {};
  readStoreRows_().forEach(row => {
    const key = String(row.key || '').trim();
    if (!key) return;
    try {
      out[key] = JSON.parse(String(row.value || 'null'));
    } catch (error) {
      Logger.log(`handleStoreDump_ could not parse stored value for key=${key}: ${errorMessage_(error)}`);
      out[key] = null;
    }
  });
  return { ok: true, store: out };
}

function handleStoreSet_(params: Params) {
  requireAuth_(params);
  const key = validStoreKey_(params.key || '');
  const raw = String(params.value || 'null');
  try {
    JSON.parse(raw);
  } catch (error) {
    throw new Error('Store value must be JSON');
  }

  const sheet = appStoreSheet_();
  const rows = readStoreRows_();
  const hit = rows.find(row => String(row.key || '') === key);
  const values = [key, raw, new Date().toISOString()];
  if (hit && hit.__rowNumber) {
    sheet.getRange(Number(hit.__rowNumber), 1, 1, values.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  return { ok: true, key };
}

function handleStoreRemove_(params: Params) {
  requireAuth_(params);
  const key = validStoreKey_(params.key || '');
  const sheet = appStoreSheet_();
  const rows = readStoreRows_();
  const hit = rows.find(row => String(row.key || '') === key);
  if (hit && hit.__rowNumber) {
    sheet.deleteRow(Number(hit.__rowNumber));
  }
  return { ok: true, key };
}
