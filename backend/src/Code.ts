type Params = { [k: string]: string };
type SheetRow = Record<string, any>;
type ScriptProps = GoogleAppsScript.Properties.Properties;
type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet;
type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

interface DataOptions {
  includeHidden?: boolean;
}

interface RuntimeOptions {
  allowFxFetch?: boolean;
}

interface ExchangeRate {
  date: string;
  value: number;
  source?: string;
}

interface PersonShare {
  name: string;
  amount: number;
}

interface Transfer {
  from: string;
  to: string;
  amount: number;
  amountLabel: string;
  pairKey: string;
  originalAmount?: number;
  completedAmount?: number;
  completedLabel?: string;
}

interface TripDashboardData {
  trip: { title: string; dates: string; members: string; note: string };
  links: any[];
  settlement: { [k: string]: any };
  checklist: any[];
  localInfo: any[];
  participants: Participant[];
  itinerary: any[];
}

interface Participant {
  id: string;
  name: string;
  settlementWeight: number;
}

const DEFAULT_CONFIG = {
  spreadsheetId: '',
  sheets: {
    itinerary: '行程表',
    reservations: '予約管理',
    budget: '予算',
    basicInfo: '基本情報',
    links: 'リンク管理',
    checklist: 'チェックリスト',
    participants: '参加者',
    expenseLog: '立替ログ',
    settlementLog: '精算完了ログ',
    exchangeRates: '為替レート',
    localInfo: '現地実用情報',
    formDesign: 'フォーム設計',
    requirements: '必要なもの'
  },
  authEnabled: true,
  tokenTtlDays: 14
};

function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  const params: Params = e && e.parameter ? e.parameter : {};
  const callback = sanitizeCallback_(params.callback || '');

  try {
    const action = params.action || 'data';
    let result;

    if (action === 'auth') {
      result = handleAuth_(params);
    } else if (action === 'data') {
      result = handleData_(params);
    } else if (action === 'expense') {
      result = handleExpense_(params);
    } else if (action === 'settlementComplete') {
      result = handleSettlementComplete_(params);
    } else if (action === 'itineraryUpdate') {
      result = handleItineraryUpdate_(params);
    } else if (action === 'ping') {
      result = { ok: true, now: Date.now() };
    } else {
      throw new Error('Unknown action');
    }

    return respond_(result, callback);
  } catch (error) {
    return respond_({ ok: false, error: (error as Error).message || String(error) }, callback);
  }
}

function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.HTML.HtmlOutput {
  const params: Params = e && e.parameter ? e.parameter : {};
  const uploadId = String(params.uploadId || '');
  const action = params.action || '';
  const source = action === 'createTrip' ? 'trip-plan-publish' : 'trip-expense-receipt-upload';

  try {
    let result;

    if (action === 'receiptUpload') {
      result = handleReceiptUpload_(params);
    } else if (action === 'createTrip') {
      result = handleCreateTrip_(params);
    } else {
      throw new Error('Unknown action');
    }

    return respondPostMessage_(result, uploadId, source);
  } catch (error) {
    return respondPostMessage_({ ok: false, error: (error as Error).message || String(error) }, uploadId, source);
  }
}

function handleAuth_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const expectedHash = props.getProperty('TRIP_PASSWORD_HASH');
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');

  if (!expectedHash || !tokenSecret) {
    throw new Error('Apps Script secrets are not configured');
  }
  if (!params.passwordHash || params.passwordHash !== expectedHash) {
    throw new Error('Password is incorrect');
  }

  const ttlDays = Number(props.getProperty('TRIP_TOKEN_TTL_DAYS') || DEFAULT_CONFIG.tokenTtlDays);
  const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  const payload = {
    exp: expiresAt,
    iat: Date.now(),
    scope: 'trip-dashboard'
  };

  return {
    ok: true,
    token: signToken_(payload, tokenSecret),
    expiresAt
  };
}

function handleData_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');

  if (authEnabled) {
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }

  const options = { includeHidden: String(params.includeHidden || '').toLowerCase() === 'true' };
  const cached = getCachedDashboardData_(options);
  if (cached) {
    return {
      ok: true,
      cached: true,
      data: cached
    };
  }

  const data = buildDashboardData_(options);
  putCachedDashboardData_(data, options);
  return {
    ok: true,
    cached: false,
    data
  };
}

function handleExpense_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');

  if (authEnabled) {
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }

  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  appendExpense_(ss, params);
  clearDashboardCache_();
  const data = buildDashboardData_();
  putCachedDashboardData_(data, {});

  return {
    ok: true,
    data
  };
}

function handleSettlementComplete_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');

  if (authEnabled) {
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }

  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  appendSettlementCompletion_(ss, params);
  clearDashboardCache_();
  const data = buildDashboardData_();
  putCachedDashboardData_(data, {});

  return {
    ok: true,
    data
  };
}

function handleItineraryUpdate_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');

  if (authEnabled) {
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }

  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  updateItineraryRow_(ss, params);
  clearDashboardCache_();
  const options = { includeHidden: String(params.includeHidden || '').toLowerCase() === 'true' };
  const data = buildDashboardData_(options);
  putCachedDashboardData_(data, options);

  return {
    ok: true,
    data
  };
}

function handleReceiptUpload_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');

  if (authEnabled) {
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }

  const fileName = sanitizeDriveFileName_(params.fileName || 'receipt.jpg');
  const mimeType = String(params.mimeType || 'image/jpeg').trim();
  const data = String(params.data || '').replace(/^data:[^,]+,/, '');
  if (!data) throw new Error('写真データがありません');
  if (!/^image\//.test(mimeType)) throw new Error('画像ファイルを選択してください');
  if (data.length > 7000000) throw new Error('写真サイズが大きすぎます。小さめの画像で再試行してください');

  const bytes = Utilities.base64Decode(data);
  const folder = getReceiptFolder_(props);
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const blob = Utilities.newBlob(bytes, mimeType, `${timestamp}-${fileName}`);
  const file = folder.createFile(blob);

  if (String(props.getProperty('TRIP_RECEIPT_PUBLIC_LINKS') || '').toLowerCase() === 'true') {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }

  return {
    ok: true,
    fileId: file.getId(),
    name: file.getName(),
    url: file.getUrl()
  };
}

function getReceiptFolder_(props: ScriptProps): GoogleAppsScript.Drive.Folder {
  const folderId = props.getProperty('TRIP_RECEIPT_FOLDER_ID');
  if (folderId) return DriveApp.getFolderById(folderId);

  const folderName = props.getProperty('TRIP_RECEIPT_FOLDER_NAME') || `${props.getProperty('TRIP_TRIP_SLUG') || 'trip-dashboard'}-receipts`;
  const folder = DriveApp.createFolder(folderName);
  props.setProperty('TRIP_RECEIPT_FOLDER_ID', folder.getId());
  return folder;
}

function sanitizeDriveFileName_(value: string) {
  const name = String(value || 'receipt.jpg')
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return name.slice(0, 120) || 'receipt.jpg';
}

function dashboardCacheKey_(options: DataOptions) {
  return (options && options.includeHidden) ? '' : 'dashboard_data_public_v11';
}

function getCachedDashboardData_(options: DataOptions): TripDashboardData | null {
  const key = dashboardCacheKey_(options || {});
  if (!key) return null;
  try {
    const cached = CacheService.getScriptCache().get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    return null;
  }
}

function putCachedDashboardData_(data: TripDashboardData, options: DataOptions) {
  const key = dashboardCacheKey_(options || {});
  if (!key || !data) return;
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(data), 90);
  } catch (error) {
    // CacheService has a small value limit. Oversized trips should still load uncached.
  }
}

function clearDashboardCache_() {
  try {
    CacheService.getScriptCache().remove('dashboard_data_public_v11');
    CacheService.getScriptCache().remove('dashboard_data_public_v10');
    CacheService.getScriptCache().remove('dashboard_data_public_v9');
    CacheService.getScriptCache().remove('dashboard_data_public_v8');
    CacheService.getScriptCache().remove('dashboard_data_public_v7');
    CacheService.getScriptCache().remove('dashboard_data_public_v6');
  } catch (error) {
    // Best-effort cache invalidation.
  }
}

function buildDashboardData_(options?: DataOptions): TripDashboardData {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);

  if (String(props.getProperty('TRIP_SELF_HEAL_SHEETS') || '').toLowerCase() === 'true') {
    ensureItineraryDisplayColumns_(ss);
    ensureExchangeRatesSheet_(ss);
    ensureLocalInfoSheet_(ss);
  }
  const itineraryRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.itinerary), 2, 1, 24);
  const budgetRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.budget), 1, 1, 6);
  const basicInfo = readKeyValue_(ss.getSheetByName(DEFAULT_CONFIG.sheets.basicInfo));
  const linkRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.links), 1, 1, 7);
  const checklistRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.checklist), 1, 1, 6);
  const participantRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.participants), 1, 1, 8);
  const exchangeRateRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.exchangeRates), 1, 1, 5);
  const localInfoRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.localInfo), 1, 1, 15);
  const expenseRows = readExpenseRows_(ss, basicInfo, props);
  const settlementCompletionRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.settlementLog), 1, 1, 8);
  const allowFxFetch = String(props.getProperty('TRIP_FX_FETCH_ON_LOAD') || '').toLowerCase() === 'true';

  return buildTripData_(itineraryRows, budgetRows, spreadsheetId, basicInfo, linkRows, checklistRows, participantRows, expenseRows, exchangeRateRows, settlementCompletionRows, localInfoRows, options || {}, { allowFxFetch });
}

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

function buildTripData_(itineraryRows: SheetRow[], budgetRows: SheetRow[], spreadsheetId: string, basicInfo: Record<string, string>, linkRows: SheetRow[], checklistRows: SheetRow[], participantRows: SheetRow[], expenseRows: SheetRow[], exchangeRateRows: SheetRow[], settlementCompletionRows: SheetRow[], localInfoRows: SheetRow[], options: DataOptions, runtimeOptions: RuntimeOptions): TripDashboardData {
  const itinerary = itineraryRows
    .filter(row => row['日付'] && row['Day'])
    .filter(row => options.includeHidden || String(valueByKeys_(row, ['公開ページに表示', '表示', 'enabled']) || 'TRUE').toUpperCase() !== 'FALSE')
    .map(row => {
      const origin = valueByKeys_(row, ['移動元', '出発地']);
      const destination = valueByKeys_(row, ['移動先', '到着地']);
      const city = valueByKeys_(row, ['都市', '宿泊地', 'エリア']) || destination || origin || '';
      const purpose = valueByKeys_(row, ['主目的', '目的']) || '予定';
      const displayTime = valueByKeys_(row, ['表示時刻', '時刻', '開始時刻', '出発時刻', '集合時刻']);
      const displayPlace = valueByKeys_(row, ['表示場所', '場所', '集合場所']) || destination || city || origin;
      const displayTitle = valueByKeys_(row, ['表示タイトル', 'タイトル', '予定名']);
      const displayNote = valueByKeys_(row, ['表示メモ', '当日メモ', 'メモ']);
      const needed = valueByKeys_(row, ['必要情報', '当日必要情報', '持ち物/注意', '確認事項']);
      const weather = valueByKeys_(row, ['天気', '気温', 'weather']);
      const moving = Boolean(origin && destination);
      const type = valueByKeys_(row, ['type', '種別']) || (moving ? 'move' : (purpose === '宿泊' ? 'stay' : (purpose === '休養' ? 'todo' : 'sight')));
      const title = displayTitle || (moving ? `${origin} → ${destination}` : `${city} / ${purpose}`);
      const noteParts = displayNote ? [displayNote] : [row['移動手段'], row['所要時間'], row['予約状況'], row['確定度'], row['メモ']];
      const rowLat = parseCoordinate_(valueByKeys_(row, ['lat', '緯度']));
      const rowLng = parseCoordinate_(valueByKeys_(row, ['lng', '経度']));
      const coords = rowLat !== '' && rowLng !== '' ? { lat: rowLat, lng: rowLng } : coordsFor_(displayPlace);
      const originCoords = coordsFor_(origin);
      const destinationCoords = coordsFor_(destination || city);

      return {
        date: normalizeDate_(row['日付']),
        rowNumber: row.__rowNumber || '',
        day: row['Day'] || row['day'],
        area: city,
        time: displayTime,
        type,
        typeLabel: valueByKeys_(row, ['表示ラベル', 'ラベル']) || (moving ? '移動' : purpose),
        title,
        place: displayPlace,
        note: noteParts.filter(Boolean).join(' / '),
        needed,
        origin,
        destination,
        originLat: originCoords ? originCoords.lat : '',
        originLng: originCoords ? originCoords.lng : '',
        destinationLat: destinationCoords ? destinationCoords.lat : '',
        destinationLng: destinationCoords ? destinationCoords.lng : '',
        lat: coords ? coords.lat : '',
        lng: coords ? coords.lng : '',
        mapQuery: valueByKeys_(row, ['地図検索', 'mapQuery']) || displayPlace,
        weather,
        edit: {
          displayTime,
          displayTitle,
          displayPlace,
          displayNote,
          needed,
          mapQuery: valueByKeys_(row, ['地図検索', 'mapQuery']) || '',
          weather,
          visible: String(valueByKeys_(row, ['公開ページに表示', '表示', 'enabled']) || 'TRUE').toUpperCase() !== 'FALSE',
          rawMemo: row['メモ'] || '',
          country: row['国'] || '',
          origin,
          destination,
          transport: row['移動手段'] || '',
          duration: row['所要時間'] || '',
          purpose,
          status: row['予約状況'] || '',
          certainty: row['確定度'] || ''
        }
      };
    });

  const startDate = basicInfo.dateStart || (itinerary.length ? itinerary[0].date : '');
  const endDate = basicInfo.dateEnd || (itinerary.length ? itinerary[itinerary.length - 1].date : '');
  const participants = buildParticipants_(participantRows);
  const planned = budgetRows.reduce((sum: number, row) => sum + parseYen_(row['予定額']), 0);
  const settlement = buildSettlement_(expenseRows, participants, planned, exchangeRateRows, settlementCompletionRows, runtimeOptions || {});

  return {
    trip: {
      title: basicInfo.tripTitle || '旅行ダッシュボード',
      dates: startDate && endDate ? `${startDate} - ${endDate}` : '',
      members: basicInfo.members || (participants.length ? participants.map(member => member.name).join(' / ') : '共有メンバー'),
      note: basicInfo.dashboardNote || '共有メモ: 詳細な予約番号や宿泊先住所は公開ページに載せず、スプレッドシート側で管理してください。'
    },
    links: buildLinks_(spreadsheetId, basicInfo, linkRows),
    settlement: {
      paid: settlement.paid,
      paidLabel: settlement.paidLabel,
      expenseTotal: settlement.expenseTotal,
      expenseByPerson: settlement.expenseByPerson || {},
      progress: settlement.progress,
      yourPaid: settlement.topPayer,
      yourDue: settlement.transferSummary,
      transfers: settlement.transfers || [],
      rateDetails: settlement.rateDetails || [],
      rateWarnings: settlement.rateWarnings || [],
      baseCurrency: 'JPY',
      photoTitle: basicInfo.photoTitle || '旅行アルバム',
      photoMeta: 'Google Photos'
    },
    checklist: buildChecklist_(checklistRows),
    localInfo: buildLocalInfo_(localInfoRows),
    participants,
    itinerary
  };
}

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

function buildSettlement_(expenseRows: SheetRow[], participants: Participant[], planned: number, exchangeRateRows: SheetRow[], settlementCompletionRows: SheetRow[], runtimeOptions: RuntimeOptions): Record<string, any> {
  const participantNames = participants.map(member => member.name);
  const names = participantNames.length ? participantNames : inferParticipantNames_(expenseRows);
  const rateIndex = buildExchangeRateIndex_(exchangeRateRows);
  const paidBy: Record<string, number> = {};
  const owedBy: Record<string, number> = {};
  const expenseByPerson: Record<string, number> = {};
  const rateDetails: any[] = [];
  const rateWarnings: string[] = [];
  const expenseDetails: any[] = [];
  let expenseTotal = 0;
  names.forEach(name => {
    paidBy[name] = 0;
    owedBy[name] = 0;
    expenseByPerson[name] = 0;
  });

  (expenseRows || []).forEach(row => {
    const payer = valueByKeys_(row, ['支払者']);
    const mode = valueByKeys_(row, ['精算範囲', '精算方法']);
    const paidDate = normalizeDate_(valueByKeys_(row, ['支払日', '日付']));
    const currency = normalizeCurrency_(valueByKeys_(row, ['通貨', 'currency']) || 'JPY');
    const rate = findExchangeRate_(rateIndex, currency, paidDate, runtimeOptions || {});
    const title = valueByKeys_(row, ['内容', 'title', '品目']) || '立替';
    const category = valueByKeys_(row, ['カテゴリ', 'category']);
    const amountOriginal = parseYen_(valueByKeys_(row, ['金額']));
    if (!amountOriginal) return;
    const individualOriginalShares = names.map(name => ({
      name,
      amount: parseYen_(valueByKeys_(row, [`個別金額_${name}`, `${name}の分として支払った金額`, `${name}の分`, name]))
    })).filter(share => share.amount > 0);
    const selected = parsePeople_(valueByKeys_(row, ['対象者（全員以外）', '対象者（全員以外の場合）']))
      .filter(name => names.includes(name));
    const targetNames = /精算不要/.test(mode)
      ? (payer ? [payer] : [])
      : (/個別金額/.test(mode) && individualOriginalShares.length
        ? individualOriginalShares.map(share => share.name)
        : (/選んだ人だけ/.test(mode) && selected.length ? selected : names));
    if (!rate) {
      rateWarnings.push(`${paidDate || '日付未入力'} ${currency} ${title}: 為替レート未設定`);
      rateDetails.push({
        date: paidDate,
        payer,
        title,
        currency,
        amount: formatCurrencyAmount_(amountOriginal, currency),
        rateDate: '',
        rate: '',
        converted: 'レート未設定',
        warning: true
      });
      expenseDetails.push({
        rowNumber: row.__rowNumber || '',
        date: paidDate,
        payer,
        category,
        title,
        mode,
        currency,
        amountOriginal,
        amountLabel: formatCurrencyAmount_(amountOriginal, currency),
        convertedAmount: 0,
        convertedLabel: 'レート未設定',
        rateDate: '',
        rate: '',
        targetNames,
        shares: []
      });
      return;
    }
    const amount = amountOriginal * rate.value;
    expenseTotal += amount;

    rateDetails.push({
      date: paidDate,
      payer,
      title,
      currency,
      amount: formatCurrencyAmount_(amountOriginal, currency),
      rateDate: rate.date,
      rate: rate.value,
      converted: formatYen_(amount),
      warning: false
    });

    const individualShares = individualOriginalShares.map(share => ({
      name: share.name,
      amount: share.amount * rate.value
    })).filter(share => share.amount > 0);

    const usesIndividual = /個別金額/.test(mode) && individualShares.length;
    const settlementAmount = usesIndividual
      ? individualShares.reduce((sum, share) => sum + share.amount, 0)
      : amount;
    if (!settlementAmount) return;

    const targets = /選んだ人だけ/.test(mode) && selected.length ? selected : names;
    const detailShares = /精算不要/.test(mode)
      ? (payer ? [{ name: payer, amount, amountLabel: formatYenZero_(amount) }] : [])
      : (usesIndividual
        ? individualShares.map(share => ({
          name: share.name,
          amount: Math.round(share.amount),
          amountLabel: formatYenZero_(share.amount)
        }))
        : targets.map(name => ({
          name,
          amount: Math.round(settlementAmount / targets.length),
          amountLabel: formatYenZero_(settlementAmount / targets.length)
        })));
    expenseDetails.push({
      rowNumber: row.__rowNumber || '',
      date: paidDate,
      payer,
      category,
      title,
      mode,
      currency,
      amountOriginal,
      amountLabel: formatCurrencyAmount_(amountOriginal, currency),
      convertedAmount: Math.round(amount),
      convertedLabel: formatYen_(amount),
      rateDate: rate.date,
      rate: rate.value,
      targetNames: detailShares.map(share => share.name),
      shares: detailShares
    });

    if (/精算不要/.test(mode)) {
      if (payer) expenseByPerson[payer] = (expenseByPerson[payer] || 0) + amount;
      return;
    }
    if (usesIndividual) {
      individualShares.forEach(share => {
        expenseByPerson[share.name] = (expenseByPerson[share.name] || 0) + share.amount;
      });
    } else {
      const perPerson = settlementAmount / targets.length;
      targets.forEach(name => {
        expenseByPerson[name] = (expenseByPerson[name] || 0) + perPerson;
      });
    }

    if (isSettledExpense_(row)) return;
    if (!payer) return;

    if (!paidBy[payer]) paidBy[payer] = 0;
    if (!owedBy[payer]) owedBy[payer] = 0;
    paidBy[payer] += settlementAmount;

    if (usesIndividual) {
      individualShares.forEach(share => {
        owedBy[share.name] = (owedBy[share.name] || 0) + share.amount;
      });
      return;
    }

    const perPerson = settlementAmount / targets.length;
    targets.forEach(name => {
      owedBy[name] = (owedBy[name] || 0) + perPerson;
    });
  });

  const totalPaid = Object.values(paidBy).reduce((sum, amount) => sum + amount, 0);
  if (!totalPaid) {
    return {
      paid: formatYen_(0),
      paidLabel: '精算額',
      expenseTotal: formatYenZero_(expenseTotal),
      expenseByPerson: formatPersonAmounts_(expenseByPerson),
      progress: planned ? Math.min(100, Math.round((expenseTotal / planned) * 100)) : 0,
      topPayer: '-',
      transferSummary: '精算不要',
      transfers: [],
      expenseDetails,
      rateDetails: recentRateDetails_(rateDetails),
      rateWarnings
    };
  }

  const topPayer = Object.keys(paidBy)
    .map(name => ({ name, amount: paidBy[name] }))
    .sort((a, b) => b.amount - a.amount)[0];
  const transfers = applySettlementCompletions_(buildTransfers_(paidBy, owedBy), settlementCompletionRows);
  const transferTotal = transfers.reduce((sum, transfer) => sum + transfer.amount, 0);
  return {
    paid: formatYen_(transferTotal),
    paidLabel: '精算額',
    expenseTotal: formatYenZero_(expenseTotal),
    expenseByPerson: formatPersonAmounts_(expenseByPerson),
    progress: planned ? Math.min(100, Math.round((expenseTotal / planned) * 100)) : 100,
    topPayer: topPayer && topPayer.amount ? `${topPayer.name} ${formatYen_(topPayer.amount)}` : '-',
    transferSummary: transfers.length ? formatYen_(transferTotal) : '精算不要',
    transfers,
    expenseDetails,
    rateDetails: recentRateDetails_(rateDetails),
    rateWarnings
  };
}

function inferParticipantNames_(expenseRows: SheetRow[]): string[] {
  const names: string[] = [];
  (expenseRows || []).forEach(row => {
    names.push(valueByKeys_(row, ['支払者']));
    parsePeople_(valueByKeys_(row, ['対象者（全員以外）', '対象者（全員以外の場合）']))
      .forEach(name => names.push(name));
    Object.keys(row || {}).forEach(key => {
      const match = key.match(/^個別金額_(.+)$/);
      if (match && parseYen_(row[key])) names.push(match[1]);
    });
  });
  return uniqueNames_(names);
}

function isSettledExpense_(row: SheetRow): boolean {
  const value = String(valueByKeys_(row, ['精算済', '確認済', 'settled', 'paid']) || '').trim().toUpperCase();
  return value === 'TRUE' || value === '済' || value === 'YES' || value === 'Y';
}

function buildTransfers_(paidBy: Record<string, number>, owedBy: Record<string, number>): Transfer[] {
  const balances = Object.keys(Object.assign({}, paidBy, owedBy)).map(name => ({
    name,
    balance: Math.round((paidBy[name] || 0) - (owedBy[name] || 0))
  }));
  const debtors = balances.filter(item => item.balance < 0).sort((a, b) => a.balance - b.balance);
  const creditors = balances.filter(item => item.balance > 0).sort((a, b) => b.balance - a.balance);
  const transfers: Transfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(-debtors[d].balance, creditors[c].balance);
    if (amount > 0) {
      transfers.push({
        from: debtors[d].name,
        to: creditors[c].name,
        amount: Math.round(amount),
        amountLabel: formatYen_(amount),
        pairKey: settlementPairKey_(debtors[d].name, creditors[c].name)
      });
    }
    debtors[d].balance += amount;
    creditors[c].balance -= amount;
    if (Math.abs(debtors[d].balance) < 1) d++;
    if (Math.abs(creditors[c].balance) < 1) c++;
  }
  return transfers;
}

function applySettlementCompletions_(transfers: Transfer[], completionRows: SheetRow[]): Transfer[] {
  const completedByPair: Record<string, number> = {};
  (completionRows || []).forEach(row => {
    const status = String(valueByKeys_(row, ['状態', 'status']) || '').trim();
    if (/取消|キャンセル|FALSE/i.test(status)) return;
    const from = valueByKeys_(row, ['支払者', 'from', '精算する人']);
    const to = valueByKeys_(row, ['受取者', 'to', '精算先']);
    const amount = parseYen_(valueByKeys_(row, ['精算額', '金額', 'amount']));
    if (!from || !to || !amount) return;
    const key = settlementPairKey_(from, to);
    completedByPair[key] = (completedByPair[key] || 0) + amount;
  });

  return (transfers || []).map(transfer => {
    const key = transfer.pairKey || settlementPairKey_(transfer.from, transfer.to);
    const completed = Math.min(completedByPair[key] || 0, transfer.amount);
    const remaining = Math.max(0, Math.round(transfer.amount - completed));
    return Object.assign({}, transfer, {
      originalAmount: transfer.amount,
      completedAmount: Math.round(completed),
      completedLabel: completed ? formatYen_(completed) : '',
      amount: remaining,
      amountLabel: formatYen_(remaining),
      pairKey: key
    });
  }).filter(transfer => transfer.amount > 0);
}

function settlementPairKey_(from: string, to: string): string {
  return `${String(from || '').trim()}→${String(to || '').trim()}`;
}

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

function findExchangeRate_(index: Record<string, ExchangeRate[]>, currency: string, paidDate: string, runtimeOptions: RuntimeOptions): ExchangeRate | null {
  const code = normalizeCurrency_(currency || 'JPY');
  if (code === 'JPY') return { date: paidDate || '', value: 1 };
  const rates = index[code] || [];
  const date = normalizeDate_(paidDate);
  if (!date && rates.length) return rates[rates.length - 1];
  let matched: ExchangeRate | null = null;
  rates.forEach(rate => {
    if (rate.date <= date) matched = rate;
  });
  return matched || cachedHistoricalExchangeRate_(code, date) || ((runtimeOptions && runtimeOptions.allowFxFetch) ? fetchHistoricalExchangeRate_(code, date) : null);
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

function formatPersonAmounts_(amounts: Record<string, number>): Record<string, { amount: number; amountLabel: string }> {
  return Object.keys(amounts || {}).reduce((acc: Record<string, { amount: number; amountLabel: string }>, name) => {
    const amount = Math.round(Number(amounts[name]) || 0);
    acc[name] = {
      amount,
      amountLabel: formatYenZero_(amount)
    };
    return acc;
  }, {});
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

  const ensured = ensureExpenseLogSheet_(ss, participantNames);
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
  const row = ensured.headers.map(header => valuesByHeader[header] !== undefined ? valuesByHeader[header] : '');

  LockService.getScriptLock().waitLock(10000);
  try {
    ensured.sheet.appendRow(row);
  } finally {
    LockService.getScriptLock().releaseLock();
  }
}

function activeParticipantNames_(ss: Spreadsheet): string[] {
  return buildParticipants_(readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.participants), 1, 1, 8))
    .map(member => member.name);
}

function defaultParticipantNames_(props: ScriptProps): string[] {
  const names = parsePeople_(props.getProperty('TRIP_DEFAULT_PARTICIPANTS'));
  return names.length ? uniqueNames_(names) : ['参加者A', '参加者B'];
}

function defaultParticipantRows_(participantNames: string[]): (string | number)[][] {
  const rows: (string | number)[][] = [['参加者ID', '表示名', '有効', '精算比率', '既定通貨', '連絡先', 'メモ', 'フォーム選択肢']];
  uniqueNames_(participantNames).forEach((name, index) => {
    rows.push([`member${index + 1}`, name, 'TRUE', 1, 'JPY', '', '', 'TRUE']);
  });
  return rows;
}

function defaultCurrencyChoices_(ss: Spreadsheet): string[] {
  const localInfoRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.localInfo), 1, 1, 15);
  const localCodes = localInfoRows
    .map(row => valueByKeys_(row, ['通貨コード', 'currencyCode', 'currency']))
    .filter(Boolean);
  return uniqueNames_(['JPY', 'USD', 'EUR', 'KRW', 'TWD', 'CNY', 'THB', 'SGD', 'AUD', 'GBP'].concat(localCodes, ['その他']))
    .map(code => code.toUpperCase ? code.toUpperCase() : code);
}

function uniqueNames_(names: any[]): string[] {
  const seen: Record<string, boolean> = {};
  return (names || [])
    .map(name => String(name || '').trim())
    .filter(Boolean)
    .filter(name => {
      if (seen[name]) return false;
      seen[name] = true;
      return true;
    });
}

function ensureExpenseLogSheet_(ss: Spreadsheet, participantNames: string[]): { sheet: Sheet; headers: string[] } {
  const baseHeaders = ['タイムスタンプ', '支払日', '支払者', 'カテゴリ', '内容', '金額', '通貨', '精算範囲', '対象者（全員以外）'];
  const individualHeaders = uniqueNames_(participantNames).map(name => `個別金額_${name}`);
  const tailHeaders = ['支払方法', 'レシート写真URL', 'メモ', '入力元', '確認済'];
  const requiredHeaders = baseHeaders.concat(individualHeaders, tailHeaders);
  const sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.expenseLog) || ss.insertSheet(DEFAULT_CONFIG.sheets.expenseLog);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, requiredHeaders.length);
    return { sheet, headers: requiredHeaders };
  }

  let headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  if (!headers.some(Boolean)) {
    headers = requiredHeaders.slice();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return { sheet, headers };
  }

  requiredHeaders.forEach(header => {
    if (headers.indexOf(header) !== -1) return;
    headers.push(header);
  });
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return { sheet, headers };
}

function appendSettlementCompletion_(ss: Spreadsheet, params: Params): void {
  const from = String(params.from || '').trim();
  const to = String(params.to || '').trim();
  const amount = parseYen_(params.amount);
  const note = String(params.note || '').trim();

  if (!from) throw new Error('精算する人が未入力です');
  if (!to) throw new Error('精算先が未入力です');
  if (from === to) throw new Error('精算する人と精算先が同じです');
  if (!amount) throw new Error('精算額が未入力です');

  const sheet = ensureSettlementCompletionsSheet_(ss);
  const row = [
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    from,
    to,
    Math.round(amount),
    'JPY',
    settlementPairKey_(from, to),
    'Dashboard',
    note
  ];

  LockService.getScriptLock().waitLock(10000);
  try {
    sheet.appendRow(row);
  } finally {
    LockService.getScriptLock().releaseLock();
  }
}

function ensureSettlementCompletionsSheet_(ss: Spreadsheet): Sheet {
  const headers = ['タイムスタンプ', '支払者', '受取者', '精算額', '通貨', '対象ペア', '入力元', 'メモ'];
  const sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.settlementLog) || ss.insertSheet(DEFAULT_CONFIG.sheets.settlementLog);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    if (!current.some(Boolean)) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sheet;
}

function updateItineraryRow_(ss: Spreadsheet, params: Params): void {
  const sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.itinerary);
  if (!sheet) throw new Error('行程表シートが見つかりません');
  ensureItineraryDisplayColumns_(ss);

  const rowNumber = Number(params.rowNumber || 0);
  if (!Number.isInteger(rowNumber) || rowNumber < 3 || rowNumber > sheet.getLastRow()) {
    throw new Error('更新対象の行が不正です');
  }

  const headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
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

  LockService.getScriptLock().waitLock(10000);
  try {
    updates.forEach(update => {
      sheet.getRange(rowNumber, update.column).setValue(update.value);
    });
  } finally {
    LockService.getScriptLock().releaseLock();
  }
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

function buildParticipants_(participantRows: SheetRow[]): Participant[] {
  return (participantRows || [])
    .filter(row => String(row['有効'] || row['active'] || 'TRUE').toUpperCase() !== 'FALSE')
    .map(row => ({
      id: row['参加者ID'] || row['id'] || row['表示名'] || row['name'] || '',
      name: row['表示名'] || row['name'] || row['参加者ID'] || row['id'] || '',
      settlementWeight: Number(row['精算比率'] || row['weight'] || 1) || 1
    }))
    .filter(member => member.name);
}

function buildLinks_(spreadsheetId: string, basicInfo: Record<string, string>, linkRows: SheetRow[]): any[] {
  const defaults = [
    { key: 'itinerary', label: '旅程', icon: '旅', url: sheetUrl_(spreadsheetId, '行程表'), caption: 'Google Sheets' },
    { key: 'maps', label: 'My Maps', icon: '地', url: basicInfo.myMapsUrl || scriptProp_('TRIP_MY_MAPS_URL', 'https://www.google.com/maps/d/'), caption: 'Google My Maps' },
    { key: 'expenseSheet', label: '費用', icon: '￥', url: sheetUrl_(spreadsheetId, '予算'), caption: 'Google Sheets' },
    { key: 'photos', label: '写真', icon: '写', url: basicInfo.photosUrl || scriptProp_('TRIP_PHOTOS_URL', 'https://photos.google.com/'), caption: 'Google Photos' },
    { key: 'reservations', label: '予約管理', icon: '予', url: sheetUrl_(spreadsheetId, '予約管理'), caption: 'Google Sheets' },
    { key: 'budget', label: '予算', icon: '￥', url: sheetUrl_(spreadsheetId, '予算'), caption: 'Google Sheets' }
  ];
  if (!linkRows || !linkRows.length) return defaults;

  const fallbackByKey = defaults.reduce((acc: Record<string, any>, link) => {
    acc[link.key] = link;
    return acc;
  }, {});

  const links = linkRows
    .filter(row => String(row['enabled'] || row['有効'] || 'TRUE').toUpperCase() !== 'FALSE')
    .filter(row => (row['key'] || row['キー'] || '') !== 'expenseForm')
    .map(row => {
      const key = row['key'] || row['キー'] || '';
      const fallback = fallbackByKey[key] || {};
      return {
        key,
        label: row['label'] || row['表示名'] || fallback.label || key,
        icon: row['icon'] || row['アイコン'] || fallback.icon || '↗',
        url: row['url'] || row['URL'] || fallback.url || '',
        caption: row['caption'] || row['種別'] || fallback.caption || ''
      };
    })
    .filter(link => link.key && link.url);

  return links.length ? links : defaults;
}

function buildChecklist_(checklistRows: SheetRow[]): { label: any; done: boolean }[] {
  const fallback = [
    { label: '航空券・宿の予約状況確認', done: false },
    { label: '海外旅行保険の確認', done: false },
    { label: 'ビザ・入国条件の確認', done: false },
    { label: '現地通信手段の確認', done: false }
  ];
  if (!checklistRows || !checklistRows.length) return fallback;
  const checks = checklistRows
    .filter(row => row['項目'] || row['label'])
    .map(row => ({
      label: row['項目'] || row['label'],
      done: String(row['完了'] || row['done'] || '').toUpperCase() === 'TRUE'
    }));
  return checks.length ? checks : fallback;
}

function buildLocalInfo_(rows: SheetRow[]): any[] {
  return (rows || [])
    .filter(row => String(valueByKeys_(row, ['有効', 'enabled']) || 'TRUE').toUpperCase() !== 'FALSE')
    .filter(row => valueByKeys_(row, ['国', 'country']))
    .map(row => ({
      country: valueByKeys_(row, ['国', 'country']),
      currencyCode: valueByKeys_(row, ['通貨コード', 'currencyCode', 'currency']),
      currencyName: valueByKeys_(row, ['通貨名', 'currencyName']),
      approxRate: valueByKeys_(row, ['概算円レート', 'rateToJpy', '円換算レート']),
      rateUpdatedAt: valueByKeys_(row, ['レート更新日', 'rateUpdatedAt', '更新日']),
      feeFreeAtm: valueByKeys_(row, ['手数料無料ATM候補', '無料ATM候補', 'feeFreeAtm']),
      atmBest: valueByKeys_(row, ['ATMおすすめ', 'atmBest']),
      atmFee: valueByKeys_(row, ['ATM手数料目安', 'atmFee']),
      atmNote: valueByKeys_(row, ['避けたい/注意', '注意', 'atmNote']),
      rideBest: valueByKeys_(row, ['配車おすすめ', 'rideBest']),
      rideAlt: valueByKeys_(row, ['代替アプリ', 'rideAlt']),
      paymentNote: valueByKeys_(row, ['支払いメモ', 'paymentNote']),
      source: valueByKeys_(row, ['情報ソース', 'source']),
      order: Number(valueByKeys_(row, ['表示順', 'order']) || 999)
    }))
    .sort((a, b) => a.order - b.order || String(a.country).localeCompare(String(b.country), 'ja'));
}

function setupTripDashboard(password: any, spreadsheetId?: string, options?: Record<string, any>): void {
  let config: Record<string, any> = options || {};
  if (password && typeof password === 'object') {
    config = password;
    password = config.password;
    spreadsheetId = config.spreadsheetId;
  }
  if (!password) throw new Error('Password is required');
  const targetSpreadsheetId = String(spreadsheetId || DEFAULT_CONFIG.spreadsheetId || '').trim();
  if (!targetSpreadsheetId) throw new Error('Spreadsheet ID is required');
  const tripSlug = sanitizeTripSlug_(config.tripSlug || config.slug || config.tripTitle || 'trip-dashboard');
  const defaultParticipants = Array.isArray(config.defaultParticipants)
    ? config.defaultParticipants.join(', ')
    : String(config.defaultParticipants || '');
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    TRIP_SPREADSHEET_ID: targetSpreadsheetId,
    TRIP_PASSWORD_HASH: sha256Hex_(password),
    TRIP_TOKEN_SECRET: Utilities.getUuid() + Utilities.getUuid(),
    TRIP_TOKEN_TTL_DAYS: String(DEFAULT_CONFIG.tokenTtlDays),
    TRIP_AUTH_ENABLED: 'true',
    TRIP_TRIP_SLUG: tripSlug,
    TRIP_TITLE: config.tripTitle || '',
    TRIP_DATE_START: config.dateStart || '',
    TRIP_DATE_END: config.dateEnd || '',
    TRIP_DEFAULT_PARTICIPANTS: defaultParticipants,
    TRIP_RECEIPT_FOLDER_NAME: config.receiptFolderName || `${tripSlug}-receipts`
  }, true);

  // Force the spreadsheet OAuth scope to be requested during manual setup.
  buildDashboardData_();
}

function initialSetup() {
  const spreadsheetId = 'CHANGE_ME_SPREADSHEET_ID';
  const password = 'CHANGE_ME_SHARED_PASSWORD';
  if (/CHANGE_ME/.test(spreadsheetId) || /CHANGE_ME/.test(password)) {
    throw new Error('Edit initialSetup() or call setupTripDashboard({ password, spreadsheetId, tripSlug, tripTitle }) first.');
  }
  setupTripDashboard({
    password,
    spreadsheetId,
    tripSlug: 'my-trip',
    tripTitle: '旅行',
    defaultParticipants: ['参加者A', '参加者B']
  });
}

function authorizeSpreadsheetAccess() {
  const data = buildDashboardData_();
  Logger.log(`Authorized spreadsheet access. itinerary rows: ${data.itinerary.length}`);
}

function authorizeDriveAccess() {
  const folder = getReceiptFolder_(PropertiesService.getScriptProperties());
  Logger.log(`Authorized Drive receipt folder: ${folder.getName()} ${folder.getUrl()}`);
}

function setupPlanningSheets() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const tripTitle = props.getProperty('TRIP_TITLE') || '旅行ダッシュボード';
  const dateStart = props.getProperty('TRIP_DATE_START') || '';
  const dateEnd = props.getProperty('TRIP_DATE_END') || '';
  const participantNames = defaultParticipantNames_(props);

  ensureItinerarySheet_(ss);
  ensureHeaderSheet_(ss, DEFAULT_CONFIG.sheets.reservations, ['種別', '日付', '名称', '場所', '予約状況', '金額', '通貨', '公開ページに表示', 'メモ']);
  ensureHeaderSheet_(ss, DEFAULT_CONFIG.sheets.budget, ['カテゴリ', '項目', '予定額', '実績額', '通貨', 'メモ']);
  ensureItineraryDisplayColumns_(ss);
  applyItinerarySheetLayout_(ss);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.basicInfo, [
    ['key', 'value', '説明', '公開ページに表示'],
    ['tripTitle', tripTitle, '旅行名。ダッシュボードのタイトルに表示', 'TRUE'],
    ['dateStart', dateStart, '旅行開始日。未定なら空欄', 'TRUE'],
    ['dateEnd', dateEnd, '旅行終了日。未定なら空欄', 'TRUE'],
    ['members', participantNames.join(' / '), '参加者名。公開してよい範囲で記載', 'TRUE'],
    ['dashboardNote', '詳細な予約番号や宿泊先住所は公開ページに載せず、スプレッドシート側で管理してください。', '共有メモ', 'TRUE'],
    ['myMapsUrl', 'https://www.google.com/maps/d/', 'Google My Mapsの共有URL', 'TRUE'],
    ['expenseFormUrl', '', 'バックアップ用GoogleフォームURL。公開ページには表示しない', 'FALSE'],
    ['expenseFormId', '', 'バックアップ用GoogleフォームのID。参加者同期に使用', 'FALSE'],
    ['photosUrl', 'https://photos.google.com/', 'Googleフォト共有アルバムURL', 'TRUE'],
    ['photoTitle', `${tripTitle}アルバム`, '写真アルバム表示名', 'TRUE'],
    ['emergencyContact', '', '緊急連絡先。公開ページに出さない', 'FALSE'],
    ['insurancePolicy', '', '保険証券番号。公開ページに出さない', 'FALSE']
  ]);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.participants, defaultParticipantRows_(participantNames));

  ensureExpenseLogSheet_(ss, participantNames);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.settlementLog, [
    ['タイムスタンプ', '支払者', '受取者', '精算額', '通貨', '対象ペア', '入力元', 'メモ'],
    ['', '', '', '', 'JPY', '', 'Dashboard', '']
  ]);

  ensureExchangeRatesSheet_(ss);
  ensureLocalInfoSheet_(ss);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.links, [
    ['key', 'label', 'icon', 'url', 'caption', 'enabled', 'メモ'],
    ['itinerary', '旅程', '旅', sheetUrl_(spreadsheetId, '行程表'), 'Google Sheets', 'TRUE', '既存の行程表'],
    ['maps', 'My Maps', '地', '', 'Google My Maps', 'TRUE', '基本情報 myMapsUrl があれば優先'],
    ['expenseSheet', '費用', '￥', sheetUrl_(spreadsheetId, '予算'), 'Google Sheets', 'TRUE', '費用と精算額の確認'],
    ['photos', '写真', '写', '', 'Google Photos', 'TRUE', '基本情報 photosUrl があれば優先'],
    ['reservations', '予約管理', '予', sheetUrl_(spreadsheetId, '予約管理'), 'Google Sheets', 'TRUE', '予約状況の確認'],
    ['budget', '予算', '￥', sheetUrl_(spreadsheetId, '予算'), 'Google Sheets', 'TRUE', '費用管理']
  ]);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.checklist, [
    ['カテゴリ', '項目', '期限', '担当', '完了', 'メモ'],
    ['予約', '航空券・宿の予約状況確認', '', '', 'FALSE', ''],
    ['安全', '保険と緊急連絡先の確認', '', '', 'FALSE', ''],
    ['入国', 'パスポート・ビザ・入国条件の確認（海外のみ）', '', '', 'FALSE', ''],
    ['通信', '現地通信手段の確認', '', '', 'FALSE', ''],
    ['お金', '現金・カード・ATM手数料の確認', '', '', 'FALSE', ''],
    ['健康', '常備薬・ワクチン・体調管理の確認', '', '', 'FALSE', '']
  ]);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.formDesign, [
    ['フォーム名', '目的', '回答先シート', '必須項目', '任意項目', '作成優先度', '備考'],
    ['立替入力フォーム', '旅行中の支払いをスマホから登録する', '立替ログ', '支払日, 支払者, 内容, 金額, 通貨, 精算範囲', '対象者（全員以外）, 個別金額_各参加者, レシート写真URL, メモ', '高', '選んだ人だけで等分/個別金額を入力の時は、それぞれ専用ページへ分岐する'],
    ['希望・候補入力フォーム', '行きたい場所や店の候補を集める', '候補リスト', '提案者, 種別, 名称, 場所/URL, 優先度', '予算感, メモ', '中', '計画段階で便利'],
    ['持ち物確認フォーム', '各自の準備状況を集める', '持ち物', '名前, 項目, 状態', 'メモ', '低', 'チェックリストで足りなければ作成'],
    ['旅行後写真提出フォーム', 'Googleフォトに入れる写真リンクを集める', '写真提出', '名前, 写真リンク', '撮影日, 場所, メモ', '低', 'Googleフォト共有で足りるなら不要']
  ]);

  ensureSheetData_(ss, DEFAULT_CONFIG.sheets.requirements, [
    ['カテゴリ', '必要なもの', '理由', '状態', '担当', 'リンク/保存場所'],
    ['Google', 'Google My Maps', 'ルートと候補地を視覚化する', '未設定', '', ''],
    ['Google', 'Google Photos共有アルバム', '旅行後の写真集約', '未設定', '', ''],
    ['運用', 'ページ内立替入力', '旅行中の精算入力をGitHub Pages内で完結する', '設定済み', '', 'Apps Script action=expense で立替ログに保存'],
    ['運用', '為替レート表', '外貨立替を支払日以前の最新レートで円換算する', '設定済み', '', '為替レートシートに日付/通貨/円換算レートを入力'],
    ['Google', '共有Googleドライブフォルダ', 'PDF/予約票/保険などを保管', '未設定', '', ''],
    ['安全', '緊急連絡先リスト', '紛失/事故時に参照', '未設定', '', '基本情報には非公開で記載'],
    ['安全', 'パスポート/保険/入国条件の確認欄', '出発前の漏れ防止', '未設定', '', ''],
    ['運用', '公開してよい情報/非公開情報の線引き', 'GitHub Pagesに機密を出さない', '未設定', '', '']
  ]);

  SpreadsheetApp.flush();
  Logger.log('Planning sheets are ready.');
}

function ensureExchangeRatesSheet_(ss: Spreadsheet): void {
  let sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.exchangeRates);
  if (!sheet) {
    sheet = ss.insertSheet(DEFAULT_CONFIG.sheets.exchangeRates);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 5).setValues([['日付', '通貨', '円換算レート', '取得元/メモ', '更新日時']]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 5);
    return;
  }

  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  const required = ['日付', '通貨', '円換算レート', '取得元/メモ', '更新日時'];
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

function ensureLocalInfoSheet_(ss: Spreadsheet): void {
  let sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.localInfo);
  if (!sheet) {
    sheet = ss.insertSheet(DEFAULT_CONFIG.sheets.localInfo);
  }
  const values = defaultLocalInfoRows_();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, values[0].length);
    return;
  }

  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  const required = values[0];
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

function defaultLocalInfoRows_(): string[][] {
  return [
    ['国', '通貨コード', '通貨名', '概算円レート', 'レート更新日', '手数料無料ATM候補', 'ATMおすすめ', 'ATM手数料目安', '避けたい/注意', '配車おすすめ', '代替アプリ', '支払いメモ', '情報ソース', '表示順', '有効']
  ];
}

function ensureItinerarySheet_(ss: Spreadsheet): Sheet {
  let sheet = ss.getSheetByName(DEFAULT_CONFIG.sheets.itinerary);
  if (!sheet) {
    sheet = ss.insertSheet(DEFAULT_CONFIG.sheets.itinerary);
  }
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

function ensureHeaderSheet_(ss: Spreadsheet, sheetName: string, headers: string[]): Sheet {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  if (sheet.getLastRow() === 0 || !sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getDisplayValues()[0].some(Boolean)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
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

function syncExpenseFormParticipants() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const basicInfo = readKeyValue_(ss.getSheetByName(DEFAULT_CONFIG.sheets.basicInfo));
  const formId = basicInfo.expenseFormId || props.getProperty('TRIP_EXPENSE_FORM_ID');
  if (!formId) throw new Error('expenseFormId is not configured in 基本情報 or Script Properties');

  const participantRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.participants), 1, 1, 8);
  const participants = buildParticipants_(participantRows).map(member => member.name);
  if (!participants.length) throw new Error('No active participants found');
  const currencyChoices = defaultCurrencyChoices_(ss);

  const form = FormApp.openById(formId);
  form.getItems().forEach(item => {
    const title = item.getTitle();
    if (title === '支払者') {
      item.asListItem().setChoiceValues(participants);
    }
    if (title === '対象者（全員以外の場合）' || title === '対象者（全員以外）') {
      item.asCheckboxItem().setChoiceValues(participants);
    }
    if (title === '通貨') {
      item.asListItem().setChoiceValues(currencyChoices);
    }
  });
  Logger.log(`Synced participants to expense form: ${participants.join(', ')}`);
}

function setupExpenseForm() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const basicInfo = readKeyValue_(ss.getSheetByName(DEFAULT_CONFIG.sheets.basicInfo));
  const formId = basicInfo.expenseFormId || props.getProperty('TRIP_EXPENSE_FORM_ID');
  if (!formId) throw new Error('expenseFormId is not configured in 基本情報 or Script Properties');

  const participantRows = readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.participants), 1, 1, 8);
  const participants = buildParticipants_(participantRows).map(member => member.name);
  if (!participants.length) throw new Error('No active participants found');
  const currencyChoices = defaultCurrencyChoices_(ss);

  const form = FormApp.openById(formId);
  form.setTitle(`${basicInfo.tripTitle || props.getProperty('TRIP_TITLE') || '旅行'} 立替入力フォーム`);
  form.setDescription('旅行中の立替を記録するフォームです。通常は「全員で等分」を選ぶだけで済みます。個別金額を選ぶと、参加者ごとの負担額を入力できます。');
  form.setCollectEmail(false);

  const items = form.getItems();
  for (let index = items.length - 1; index >= 0; index--) {
    form.deleteItem(items[index]);
  }

  const amountValidation = FormApp.createTextValidation()
    .requireNumberGreaterThanOrEqualTo(0)
    .setHelpText('0以上の数値で入力してください。')
    .build();

  form.addDateItem()
    .setTitle('支払日')
    .setRequired(true);
  form.addListItem()
    .setTitle('支払者')
    .setChoiceValues(participants)
    .setRequired(true);
  form.addListItem()
    .setTitle('カテゴリ')
    .setChoiceValues(['交通', '宿泊', '食費', 'ツアー', '入場料', '通信', '雑費', 'その他'])
    .setRequired(true);
  form.addTextItem()
    .setTitle('内容')
    .setRequired(true);
  form.addTextItem()
    .setTitle('金額')
    .setHelpText('個別金額を入力する場合は、下の参加者別金額の合計と一致させてください。')
    .setValidation(amountValidation)
    .setRequired(true);
  form.addListItem()
    .setTitle('通貨')
    .setChoiceValues(currencyChoices)
    .setRequired(true);

  const splitItem = form.addMultipleChoiceItem()
    .setTitle('精算範囲')
    .setRequired(true);

  const selectedPage = form.addPageBreakItem()
    .setTitle('対象者を選択')
    .setHelpText('この支払いを割り勘する人だけを選びます。');
  form.addCheckboxItem()
    .setTitle('対象者（全員以外）')
    .setHelpText('選んだ人だけで等分する対象者を選択してください。')
    .setChoiceValues(participants)
    .setRequired(true);

  const individualPage = form.addPageBreakItem()
    .setTitle('個別金額')
    .setHelpText('誰の分としていくら払ったかを入力します。該当しない人は空欄で構いません。');
  participants.forEach(name => {
    form.addTextItem()
      .setTitle(`個別金額_${name}`)
      .setHelpText(`${name}の分として支払った金額`)
      .setValidation(amountValidation);
  });

  const detailPage = form.addPageBreakItem()
    .setTitle('詳細')
    .setHelpText('支払方法、レシート、補足を入力します。');
  selectedPage.setGoToPage(detailPage);
  individualPage.setGoToPage(detailPage);
  splitItem.setChoices([
    splitItem.createChoice('全員で等分', detailPage),
    splitItem.createChoice('選んだ人だけで等分', selectedPage),
    splitItem.createChoice('個別金額を入力', individualPage),
    splitItem.createChoice('精算不要（記録だけ）', detailPage)
  ]);

  form.addListItem()
    .setTitle('支払方法')
    .setChoiceValues(['現金', 'クレジットカード', 'デビットカード', '電子決済', 'その他']);
  form.addTextItem()
    .setTitle('レシート写真URL')
    .setHelpText('GoogleフォトやDriveに置いたレシート写真のURLがあれば貼ってください。');
  form.addParagraphTextItem()
    .setTitle('メモ');

  Logger.log(`Expense form rebuilt: ${form.getPublishedUrl()}`);
  return form.getPublishedUrl();
}

function ensureSheetData_(ss: Spreadsheet, sheetName: string, values: any[][]): void {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
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

function setTripLinks(myMapsUrl: string, expenseFormUrl: string, photosUrl: string): void {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    TRIP_MY_MAPS_URL: myMapsUrl || '',
    TRIP_EXPENSE_FORM_URL: expenseFormUrl || '',
    TRIP_PHOTOS_URL: photosUrl || ''
  }, false);
}

function signToken_(payload: any, secret: string): string {
  const body = base64UrlEncode_(JSON.stringify(payload));
  const signature = base64UrlEncodeBytes_(Utilities.computeHmacSha256Signature(body, secret));
  return `${body}.${signature}`;
}

function verifyToken_(token: string, secret: string): any {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('Authentication is required');

  const expected = base64UrlEncodeBytes_(Utilities.computeHmacSha256Signature(parts[0], secret));
  if (!constantTimeEqual_(parts[1], expected)) throw new Error('Invalid token');

  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error('Token expired');
  return payload;
}

/**
 * 旅行計画(ローカル作成プラン)を新しいスプレッドシートへ公開する。
 * ダッシュボードが googleSheets モードで読める形（行程表/基本情報/予約管理/予算/チェックリスト）で書き出し、
 * リンクを知っている人が閲覧できるよう共有設定する。認証が有効ならトークン必須。
 */
function handleCreateTrip_(params: Params) {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');
  if (authEnabled) {
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }

  let plan;
  try {
    plan = JSON.parse(params.plan || '');
  } catch (parseError) {
    throw new Error('plan JSON is invalid');
  }
  if (!plan || typeof plan !== 'object') throw new Error('plan data is required');

  const trip = plan.trip || {};
  const tripTitle = String(trip.title || plan.title || '旅行').slice(0, 120);
  const ss = SpreadsheetApp.create('旅行ダッシュボード: ' + tripTitle);
  const spreadsheetId = ss.getId();

  provisionPlanSpreadsheet_(ss, plan);
  SpreadsheetApp.flush();

  let shared = false;
  try {
    DriveApp.getFileById(spreadsheetId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    shared = true;
  } catch (shareError) {
    shared = false;
  }

  return {
    ok: true,
    spreadsheetId: spreadsheetId,
    spreadsheetUrl: ss.getUrl(),
    tripTitle: tripTitle,
    shared: shared
  };
}

function provisionPlanSpreadsheet_(ss: Spreadsheet, plan: any): void {
  const trip = plan.trip || {};
  const itinerary: any[] = Array.isArray(plan.itinerary) ? plan.itinerary : [];

  const itinHeader = ['日付', 'Day', '都市', '表示時刻', '種別', '表示ラベル', '表示タイトル', '表示場所', '地図検索', '緯度', '経度', '表示メモ', '公開ページに表示'];
  const itinRows = itinerary.map(function (item) {
    return [
      normalizeDate_(item.date || ''),
      item.day || '',
      item.area || item.place || '',
      item.time || '',
      item.type || 'sight',
      item.typeLabel || '',
      item.title || '',
      item.place || '',
      item.mapQuery || item.place || '',
      parseCoordinate_(item.lat),
      parseCoordinate_(item.lng),
      item.note || '',
      'TRUE'
    ];
  });
  writePlanSheet_(ss, '行程表', itinHeader, itinRows);

  const dateParts = String(trip.dates || '').split(/\s*-\s*/);
  writePlanSheet_(ss, '基本情報', ['key', 'value', '説明', '公開ページに表示'], [
    ['tripTitle', trip.title || '旅行', '旅行名', 'TRUE'],
    ['dateStart', normalizeDate_(dateParts[0] || ''), '開始日', 'TRUE'],
    ['dateEnd', normalizeDate_(dateParts[1] || dateParts[0] || ''), '終了日', 'TRUE'],
    ['members', trip.members || '', 'メンバー', 'TRUE'],
    ['dashboardNote', trip.note || '', '共有メモ', 'TRUE'],
    ['myMapsUrl', '', 'Google My Maps URL', 'TRUE'],
    ['photosUrl', '', 'Google Photos URL', 'TRUE']
  ]);

  // ダッシュボードが googleSheets モードで必ず読むシート（無いと読み込みが失敗する）
  writePlanSheet_(ss, '予約管理', ['種別', '日付', '名称', '場所', '予約状況', '金額', '通貨', '公開ページに表示', 'メモ'], []);
  writePlanSheet_(ss, '予算', ['カテゴリ', '項目', '予定額', '実績額', '通貨', 'メモ'], []);

  const checklist: any[] = Array.isArray(plan.checklist) ? plan.checklist : [];
  const checkRows = checklist.map(function (c) {
    const done = c.done === true || String(c.done).toUpperCase() === 'TRUE';
    return ['', c.label || '', '', '', done ? 'TRUE' : 'FALSE', ''];
  });
  writePlanSheet_(ss, 'チェックリスト', ['カテゴリ', '項目', '期限', '担当', '完了', 'メモ'], checkRows);

  removeDefaultSheet_(ss);
}

function writePlanSheet_(ss: Spreadsheet, name: string, header: string[], rows: any[][]): Sheet {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();
  const body = (rows && rows.length) ? rows : [];
  const values = [header].concat(body).map(function (row) {
    const copy = row.slice(0, header.length);
    while (copy.length < header.length) copy.push('');
    return copy;
  });
  sheet.getRange(1, 1, values.length, header.length).setValues(values);
  sheet.setFrozenRows(1);
  return sheet;
}

function removeDefaultSheet_(ss: Spreadsheet): void {
  ['シート1', 'Sheet1'].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (sheet && ss.getSheets().length > 1) {
      try { ss.deleteSheet(sheet); } catch (deleteError) {}
    }
  });
}

function respond_(payload: any, callback: string): GoogleAppsScript.Content.TextOutput {
  const json = JSON.stringify(payload);
  if (callback) {
    return ContentService
      .createTextOutput(`${callback}(${json});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function respondPostMessage_(payload: any, uploadId: string, source: string): GoogleAppsScript.HTML.HtmlOutput {
  const message = JSON.stringify({
    source: source || 'trip-expense-receipt-upload',
    uploadId: uploadId || '',
    response: payload
  }).replace(/</g, '\\u003c');
  return HtmlService
    .createHtmlOutput(`<!doctype html><html><body><script>window.parent.postMessage(${message}, '*');</script></body></html>`)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sanitizeCallback_(callback: string): string {
  const value = String(callback || '');
  return /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(value) ? value : '';
}

function sha256Hex_(text: string): string {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlEncode_(text: string): string {
  return Utilities.base64EncodeWebSafe(text).replace(/=+$/, '');
}

function base64UrlEncodeBytes_(bytes: number[]): string {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function constantTimeEqual_(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
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
