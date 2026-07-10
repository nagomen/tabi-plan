// 立替ログの読み取り（シート/フォーム）と追加。


function readExpenseRows_(ss: Spreadsheet, basicInfo: Record<string, string>, props: ScriptProps): SheetRow[] {
  const expenseSheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.expenseLog);
  const columnCount = expenseSheet ? Math.max(expenseSheet.getLastColumn(), 24) : 24;
  const sheetRows = readObjects_(expenseSheet, 1, 1, columnCount)
    .filter(isExpenseRow_);
  const formSyncEnabled = String(basicInfo.expenseFormSyncEnabled || props.getProperty('TRIP_EXPENSE_FORM_SYNC_ENABLED') || '').toLowerCase() === 'true';
  if (!formSyncEnabled) return sheetRows;

  const formId = basicInfo.expenseFormId || props.getProperty('TRIP_EXPENSE_FORM_ID');
  const formRows = readExpenseFormResponses_(formId);
  const dashboardRows = sheetRows.filter(row => String(valueByKeys_(row, ['入力元'])).toLowerCase() !== 'google forms');
  return formRows.length ? formRows.concat(dashboardRows) : sheetRows;
}

function readExpenseFormResponses_(formId: string | null): SheetRow[] {
  if (!formId) return [];
  try {
    return FormApp.openById(formId).getResponses().map(response => {
      const row: SheetRow = {
        'タイムスタンプ': Utilities.formatDate(response.getTimestamp(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
        '入力元': 'Google Forms'
      };
      response.getItemResponses().forEach(itemResponse => {
        row[itemResponse.getItem().getTitle()] = normalizeFormResponse_(itemResponse.getResponse());
      });
      return row;
    }).filter(isExpenseRow_);
  } catch (error) {
    Logger.log(`readExpenseFormResponses_ failed for formId=${formId}: ${errorMessage_(error)}`);
    return [];
  }
}

function normalizeFormResponse_(value: any): string {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function isExpenseRow_(row: SheetRow): boolean {
  if (!row) return false;
  return Boolean(valueByKeys_(row, ['支払者']) && (
    parseYen_(valueByKeys_(row, ['金額'])) ||
    Object.keys(row).some(key => /^個別金額_/.test(key) && parseYen_(row[key]))
  ));
}

function appendExpense_(ss: Spreadsheet, params: Params): void {
  const paidDate = normalizeDate_(params.paidDate || '');
  const payer = String(params.payer || '').trim();
  const category = String(params.category || '').trim();
  const title = String(params.title || '').trim();
  const amount = parseYen_(params.amount);
  const currency = String(params.currency || 'JPY').trim();
  const splitMode = String(params.splitMode || '').trim();
  const paymentMethod = String(params.paymentMethod || '').trim();
  const receiptUrl = String(params.receiptUrl || '').trim();
  const note = String(params.note || '').trim();
  const targets = parseJsonArray_(params.targets);
  const individual = parseJsonObject_(params.individual);
  const configuredNames = activeParticipantNames_(ss);
  const individualNames = Object.keys(individual || {}).filter(name => parseYen_(individual[name]));
  const participantNames = configuredNames.length
    ? configuredNames
    : uniqueNames_([payer].concat(targets, individualNames));

  if (!paidDate) throw new Error('支払日を入力してください');
  if (!payer) throw new Error('支払者を選択してください');
  if (!category) throw new Error('カテゴリを選択してください');
  if (!title) throw new Error('内容を入力してください');
  if (!amount) throw new Error('金額を入力してください');
  if (!currency) throw new Error('通貨を選択してください');
  if (!splitMode) throw new Error('精算範囲を選択してください');

  if (/選んだ人だけ/.test(splitMode) && !targets.length) {
    throw new Error('対象者を1人以上選択してください');
  }
  if (/個別金額/.test(splitMode)) {
    const shareTotal = participantNames.reduce((sum, name) => sum + parseYen_(individual[name]), 0);
    if (!shareTotal) throw new Error('個別金額を入力してください');
    if (Math.abs(shareTotal - amount) > 1) {
      throw new Error(`個別金額の合計が金額と一致しません: ${formatYen_(shareTotal)} / ${formatYen_(amount)}`);
    }
  }

  const valuesByHeader: Record<string, string | number> = {
    'タイムスタンプ': Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    '支払日': paidDate,
    '支払者': payer,
    'カテゴリ': category,
    '内容': title,
    '金額': amount,
    '通貨': currency,
    '精算範囲': splitMode,
    '対象者（全員以外）': targets.join(', '),
    '支払方法': paymentMethod,
    'レシート写真URL': receiptUrl,
    'メモ': note,
    '入力元': 'Dashboard',
    '確認済': 'FALSE'
  };
  participantNames.forEach(name => {
    valuesByHeader[`個別金額_${name}`] = parseYen_(individual[name]) || '';
  });

  // ヘッダー整備（列追加）から行追加までを一括でロックする。
  // ロック外でヘッダーを書き換えると、同時実行で同じ参加者列を二重追加し得る。
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ensured = ensureExpenseLogSheet_(ss, participantNames);
    const row = ensured.headers.map(header => valuesByHeader[header] !== undefined ? valuesByHeader[header] : '');
    ensured.sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

function ensureExpenseLogSheet_(ss: Spreadsheet, participantNames: string[]): { sheet: Sheet; headers: string[] } {
  const baseHeaders = ['タイムスタンプ', '支払日', '支払者', 'カテゴリ', '内容', '金額', '通貨', '精算範囲', '対象者（全員以外）'];
  const individualHeaders = uniqueNames_(participantNames).map(name => `個別金額_${name}`);
  const tailHeaders = ['支払方法', 'レシート写真URL', 'メモ', '入力元', '確認済'];
  const requiredHeaders = baseHeaders.concat(individualHeaders, tailHeaders);
  const sheet = getOrCreateSheet_(ss, DEFAULT_CONFIG.sheets.expenseLog);
  const headers = ensureHeaderRow_(sheet, 1, requiredHeaders);
  return { sheet, headers };
}
