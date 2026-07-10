// 行程表の更新とシート整形、地名→座標フォールバック。


function updateItineraryRow_(ss: Spreadsheet, params: Params): void {
  const sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.itinerary);
  if (!sheet) throw new Error('行程表シートが見つかりません');

  const rowNumber = Number(params.rowNumber || 0);
  const fieldToHeader: Record<string, string> = {
    displayTime: '表示時刻',
    displayTitle: '表示タイトル',
    displayPlace: '表示場所',
    displayNote: '表示メモ',
    needed: '必要情報',
    mapQuery: '地図検索',
    lat: '緯度',
    lng: '経度',
    weather: '天気',
    visible: '公開ページに表示'
  };

  // 列整備・行範囲の検証・ヘッダー読取・書込までを一括でロックする。
  // 検証（getLastRow など）と書込の間に他の更新が割り込むと TOCTOU になるため。
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureItineraryDisplayColumns_(ss);
    if (!Number.isInteger(rowNumber) || rowNumber < 3 || rowNumber > sheet.getLastRow()) {
      throw new Error('更新対象の行が不正です');
    }

    const headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const updates: { column: number; value: string }[] = [];
    Object.keys(fieldToHeader).forEach(field => {
      if (params[field] === undefined) return;
      const column = headers.indexOf(fieldToHeader[field]) + 1;
      if (!column) return;
      let value = String(params[field] || '').trim();
      if (field === 'visible') value = String(params[field]).toUpperCase() === 'FALSE' ? 'FALSE' : 'TRUE';
      updates.push({ column, value });
    });
    if (!updates.length) throw new Error('更新する項目がありません');

    updates.forEach(update => {
      sheet.getRange(rowNumber, update.column).setValue(update.value);
    });
  } finally {
    lock.releaseLock();
  }
}

function ensureItinerarySheet_(ss: Spreadsheet): Sheet {
  const sheet = getOrCreateSheet_(ss, DEFAULT_CONFIG.sheets.itinerary);
  const headers = [
    '日付',
    'Day',
    '表示時刻',
    '表示タイトル',
    '表示場所',
    '表示メモ',
    '必要情報',
    '種別',
    '表示ラベル',
    '国',
    '都市',
    '移動元',
    '移動先',
    '移動手段',
    '所要時間',
    '主目的',
    '予約状況',
    '確定度',
    '優先度',
    'メモ',
    '宿泊地',
    '地図検索',
    '緯度',
    '経度',
    '天気',
    '公開ページに表示'
  ];
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows() < 2) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 2 - sheet.getMaxRows());
  }
  const current = sheet.getRange(2, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getDisplayValues()[0];
  if (current.some(Boolean)) return sheet;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers.map(() => '')]);
  sheet.getRange(2, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(2);
  return sheet;
}

function ensureItineraryDisplayColumns_(ss: Spreadsheet): void {
  const sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.itinerary);
  if (!sheet || sheet.getMaxRows() < 2) return;

  const headerRow = 2;
  const primaryHeaders = [
    '表示時刻',
    '表示タイトル',
    '表示場所',
    '表示メモ',
    '必要情報',
    '種別',
    '表示ラベル'
  ];
  const auxiliaryHeaders = [
    '地図検索',
    '緯度',
    '経度',
    '天気',
    '公開ページに表示'
  ];
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(headerRow, 1, 1, lastColumn).getDisplayValues()[0];
  let insertAfter = Math.max(headers.indexOf('Day') + 1, 2);

  primaryHeaders.forEach(header => {
    if (headers.indexOf(header) !== -1) return;
    sheet.insertColumnAfter(insertAfter);
    insertAfter += 1;
    sheet.getRange(headerRow, insertAfter).setValue(header);
    headers.splice(insertAfter - 1, 0, header);
  });

  auxiliaryHeaders.forEach(header => {
    if (headers.indexOf(header) !== -1) return;
    sheet.insertColumnAfter(sheet.getLastColumn());
    const column = sheet.getLastColumn();
    sheet.getRange(headerRow, column).setValue(header);
    headers.push(header);
  });

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(Math.min(7, sheet.getLastColumn()));
  sheet.autoResizeColumns(1, Math.min(sheet.getLastColumn(), 24));
}

function applyItinerarySheetLayout_(ss: Spreadsheet): void {
  const sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.itinerary);
  if (!sheet || sheet.getMaxRows() < 2) return;

  const lastRow = Math.max(sheet.getLastRow(), 31);
  const lastColumn = Math.min(sheet.getLastColumn(), 24);
  const widths: Record<string, number> = {
    '日付': 96,
    'Day': 72,
    '表示時刻': 92,
    '表示タイトル': 260,
    '表示場所': 160,
    '表示メモ': 320,
    '必要情報': 220,
    '種別': 90,
    '表示ラベル': 100,
    '国': 96,
    '都市': 150,
    '移動元': 150,
    '移動先': 150,
    '移動手段': 110,
    '所要時間': 115,
    '主目的': 95,
    '予約状況': 105,
    '確定度': 95,
    '優先度': 82,
    'メモ': 420,
    '宿泊地': 130,
    '地図検索': 210,
    '緯度': 90,
    '経度': 90,
    '天気': 120,
    '公開ページに表示': 130
  };

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(Math.min(7, lastColumn));
  sheet.getRange(2, 1, lastRow - 1, lastColumn)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(2, 44);
  if (lastRow > 2) sheet.setRowHeights(3, lastRow - 2, 58);

  const headers = sheet.getRange(2, 1, 1, lastColumn).getDisplayValues()[0];
  headers.forEach((header, index) => {
    const width = widths[header];
    if (width) sheet.setColumnWidth(index + 1, width);
  });

  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.getRange(2, 1, lastRow - 1, lastColumn).createFilter();
}

// 成田/東京は国内発の旅行で共通して使う出発ハブなので既定値として持つ。
// それ以外の地名は行程表シートの緯度/経度列（表示中の座標）か、
// TRIP_PLACE_COORDS_JSON（{"地名":{"lat":0,"lng":0}, ...}）で旅行ごとに設定する。
// コード側に旅行固有の地名を書き足さない（旅行が変わるたびにデプロイが必要になるため）。
const DEFAULT_HUB_COORDS: Record<string, { lat: number; lng: number }> = {
  '成田': { lat: 35.7720, lng: 140.3929 },
  '成田空港': { lat: 35.7720, lng: 140.3929 },
  'NRT': { lat: 35.7720, lng: 140.3929 },
  '東京': { lat: 35.6812, lng: 139.7671 }
};

// 1回のダッシュボード構築で行程表の行数ぶん呼ばれるため、ScriptProperties の読み取り
// と JSON.parse をリクエストごとに一度だけに抑える。
let customPlaceCoordsCache_: Record<string, { lat: number; lng: number }> | null = null;

function customPlaceCoords_(): Record<string, { lat: number; lng: number }> {
  if (customPlaceCoordsCache_) return customPlaceCoordsCache_;
  const raw = PropertiesService.getScriptProperties().getProperty('TRIP_PLACE_COORDS_JSON');
  if (!raw) return (customPlaceCoordsCache_ = {});
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return (customPlaceCoordsCache_ = {});
    return (customPlaceCoordsCache_ = Object.keys(parsed).reduce((acc: Record<string, { lat: number; lng: number }>, key) => {
      const lat = parseCoordinate_(parsed[key] && parsed[key].lat);
      const lng = parseCoordinate_(parsed[key] && parsed[key].lng);
      if (lat !== '' && lng !== '') acc[normalizePlaceName_(key)] = { lat, lng };
      return acc;
    }, {}));
  } catch (error) {
    Logger.log(`customPlaceCoords_: TRIP_PLACE_COORDS_JSON is invalid JSON: ${errorMessage_(error)}`);
    return (customPlaceCoordsCache_ = {});
  }
}

function coordsFor_(name: any): { lat: number; lng: number } | null {
  const key = normalizePlaceName_(name);
  if (!key) return null;
  return customPlaceCoords_()[key] || DEFAULT_HUB_COORDS[key] || null;
}

function normalizePlaceName_(name: any): string {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/・/g, '')
    .replace(/方面$/, '方面')
    .replace(/^移動中$/, '');
}
