// エントリポイント（doGet/doPost）とアクションのディスパッチ、認証ゲート付ハンドラ、
// レスポンス整形、レシート画像アップロードを担当する。


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

// 認証が有効ならトークンを検証し、ScriptProperties を返す共通処理。
function requireAuth_(params: Params): ScriptProps {
  const props = PropertiesService.getScriptProperties();
  const authEnabled = String(props.getProperty('TRIP_AUTH_ENABLED') || DEFAULT_CONFIG.authEnabled) !== 'false';
  if (authEnabled) {
    const tokenSecret = props.getProperty('TRIP_TOKEN_SECRET');
    if (!tokenSecret) throw new Error('Token secret is not configured');
    verifyToken_(params.token || '', tokenSecret);
  }
  return props;
}

// シートを変更し、キャッシュを更新して最新データを返す共通処理。
function mutateAndRespond_(params: Params, mutate: (ss: Spreadsheet) => void, options?: DataOptions) {
  const props = requireAuth_(params);
  const ss = SpreadsheetApp.openById(getSpreadsheetId_(props));
  mutate(ss);
  clearDashboardCache_();
  const data = buildDashboardData_(options || {});
  putCachedDashboardData_(data, options || {});
  return { ok: true, data };
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
  requireAuth_(params);

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
  return mutateAndRespond_(params, ss => appendExpense_(ss, params));
}

function handleSettlementComplete_(params: Params) {
  return mutateAndRespond_(params, ss => appendSettlementCompletion_(ss, params));
}

function handleItineraryUpdate_(params: Params) {
  const options = { includeHidden: String(params.includeHidden || '').toLowerCase() === 'true' };
  return mutateAndRespond_(params, ss => updateItineraryRow_(ss, params), options);
}

function handleReceiptUpload_(params: Params) {
  const props = requireAuth_(params);

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
