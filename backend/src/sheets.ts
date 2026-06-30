// 汎用的なシート読み取りと各シートのヘッダー整備。


function readObjects_(sheet: Sheet | null, headerRow: number, startColumn: number, columnCount: number): SheetRow[] {
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < headerRow) return [];

  const values = sheet.getRange(headerRow, startColumn, lastRow - headerRow + 1, columnCount).getDisplayValues();
  const headers = values.shift() as string[];
  return values
    .map((row, index) => ({ row, rowNumber: headerRow + 1 + index }))
    .filter(item => item.row.some(cell => cell !== ''))
    .map(item => {
      const obj: SheetRow = {};
      headers.forEach((header, index) => {
        obj[header] = item.row[index] || '';
      });
      obj.__rowNumber = item.rowNumber;
      return obj;
    });
}

function readKeyValue_(sheet: Sheet | null): Record<string, string> {
  if (!sheet) return {};
  const rows = readObjects_(sheet, 1, 1, 4);
  return rows.reduce((acc: Record<string, string>, row) => {
    const key = row['key'] || row['キー'] || '';
    if (key) acc[key] = row['value'] || row['値'] || '';
    return acc;
  }, {});
}

// 名前のシートを取得、無ければ作成する。
function getOrCreateSheet_(ss: Spreadsheet, name: string): Sheet {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// 既存ヘッダー行に不足している列を末尾に追加する（既存データは保持）。
function ensureHeaderColumns_(sheet: Sheet, required: string[]): void {
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  let nextColumn = headers.length;
  const missingCount = required.filter(header => headers.indexOf(header) === -1).length;
  if (missingCount && sheet.getMaxColumns() < headers.length + missingCount) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length + missingCount - sheet.getMaxColumns());
  }
  required.forEach(header => {
    if (headers.indexOf(header) !== -1) return;
    nextColumn += 1;
    sheet.getRange(1, nextColumn).setValue(header);
    headers.push(header);
  });
  sheet.setFrozenRows(1);
}

function ensureExchangeRatesSheet_(ss: Spreadsheet): void {
  const headers = ['日付', '通貨', '円換算レート', '取得元/メモ', '更新日時'];
  const sheet = getOrCreateSheet_(ss, DEFAULT_CONFIG.sheets.exchangeRates);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
    return;
  }
  ensureHeaderColumns_(sheet, headers);
}

function ensureLocalInfoSheet_(ss: Spreadsheet): void {
  const sheet = getOrCreateSheet_(ss, DEFAULT_CONFIG.sheets.localInfo);
  const values = defaultLocalInfoRows_();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, values[0].length);
    return;
  }
  ensureHeaderColumns_(sheet, values[0]);
}

function defaultLocalInfoRows_(): string[][] {
  return [
    ['国', '通貨コード', '通貨名', '概算円レート', 'レート更新日', '手数料無料ATM候補', 'ATMおすすめ', 'ATM手数料目安', '避けたい/注意', '配車おすすめ', '代替アプリ', '支払いメモ', '情報ソース', '表示順', '有効']
  ];
}

function ensureHeaderSheet_(ss: Spreadsheet, sheetName: string, headers: string[]): Sheet {
  const sheet = getOrCreateSheet_(ss, sheetName);
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0 || !sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getDisplayValues()[0].some(Boolean)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureSheetData_(ss: Spreadsheet, sheetName: string, values: any[][]): void {
  const sheet = getOrCreateSheet_(ss, sheetName);
  const width = values.reduce((max, row) => Math.max(max, row.length), 0);
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows() < values.length) {
    sheet.insertRowsAfter(sheet.getMaxRows(), values.length - sheet.getMaxRows());
  }
  sheet.getRange(1, 1, values.length, width).setValues(values.map(row => {
    const next = row.slice();
    while (next.length < width) next.push('');
    return next;
  }));
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, width);
}
