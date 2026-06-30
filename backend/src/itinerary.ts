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
    '必要情報'
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

function coordsFor_(name: any): { lat: number; lng: number } | null {
  const key = normalizePlaceName_(name);
  if (!key) return null;
  const coords: Record<string, { lat: number; lng: number }> = {
    '成田': { lat: 35.7720, lng: 140.3929 },
    '成田空港': { lat: 35.7720, lng: 140.3929 },
    'NRT': { lat: 35.7720, lng: 140.3929 },
    '東京': { lat: 35.6812, lng: 139.7671 },
    'サンフランシスコ': { lat: 37.7749, lng: -122.4194 },
    'SFO': { lat: 37.6213, lng: -122.3790 },
    'リマ': { lat: -12.0464, lng: -77.0428 },
    'Lima': { lat: -12.0464, lng: -77.0428 },
    'クスコ': { lat: -13.5319, lng: -71.9675 },
    'Cusco': { lat: -13.5319, lng: -71.9675 },
    'マチュピチュ方面': { lat: -13.1631, lng: -72.5450 },
    'マチュピチュ村': { lat: -13.1547, lng: -72.5254 },
    'アグアスカリエンテス': { lat: -13.1547, lng: -72.5254 },
    'マチュピチュ': { lat: -13.1631, lng: -72.5450 },
    'プエルトマルドナド': { lat: -12.5933, lng: -69.1891 },
    'PMD': { lat: -12.5933, lng: -69.1891 },
    'プーノ': { lat: -15.8402, lng: -70.0219 },
    'ラパス': { lat: -16.4897, lng: -68.1193 },
    'ウユニ': { lat: -20.4597, lng: -66.8250 },
    'ビジャソン': { lat: -22.0866, lng: -65.5942 },
    'ラキアカ': { lat: -22.1024, lng: -65.5920 },
    'ビジャソン/ラキアカ': { lat: -22.0960, lng: -65.5930 },
    'サルタ': { lat: -24.7821, lng: -65.4232 },
    'イグアス': { lat: -25.5163, lng: -54.5854 },
    'プエルトイグアス': { lat: -25.5972, lng: -54.5786 },
    'FozdoIguacu/IGU': { lat: -25.6003, lng: -54.4850 },
    'FozdoIguacuIGU': { lat: -25.6003, lng: -54.4850 },
    'IGU': { lat: -25.6003, lng: -54.4850 },
    'Yguazu': { lat: -25.4610, lng: -55.0000 },
    'ColoniaYguazu': { lat: -25.4610, lng: -55.0000 },
    'サンパウロ': { lat: -23.5558, lng: -46.6396 },
    'サントス': { lat: -23.9608, lng: -46.3336 },
    'リオデジャネイロ': { lat: -22.9068, lng: -43.1729 },
    'モンテビデオ': { lat: -34.9011, lng: -56.1645 },
    'ブエノスアイレス': { lat: -34.6037, lng: -58.3816 }
  };
  return coords[key] || null;
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
