// ローカル作成プランを新規スプレッドシートへ公開する。


/**
 * 旅行計画(ローカル作成プラン)を新しいスプレッドシートへ公開する。
 * ダッシュボードが googleSheets モードで読める形（行程表/基本情報/予約管理/予算/チェックリスト）で書き出し、
 * リンクを知っている人が閲覧できるよう共有設定する。認証が有効ならトークン必須。
 */
function handleCreateTrip_(params: Params) {
  requireAuth_(params);

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
  const sheet = getOrCreateSheet_(ss, name);
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
