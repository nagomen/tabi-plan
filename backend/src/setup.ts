// 初期セットアップ、計画シート生成、立替フォームの作成/同期。


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
  const tripTitle = props.getProperty('TRIP_TITLE') || 'Tabi Plan';
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

function syncExpenseFormParticipants() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = getSpreadsheetId_(props);
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const basicInfo = readKeyValue_(ss.getSheetByName(DEFAULT_CONFIG.sheets.basicInfo));
  const formId = basicInfo.expenseFormId || props.getProperty('TRIP_EXPENSE_FORM_ID');
  if (!formId) throw new Error('expenseFormId is not configured in 基本情報 or Script Properties');

  const participants = readParticipants_(ss).map(member => member.name);
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

  const participants = readParticipants_(ss).map(member => member.name);
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

function setTripLinks(myMapsUrl: string, expenseFormUrl: string, photosUrl: string): void {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    TRIP_MY_MAPS_URL: myMapsUrl || '',
    TRIP_EXPENSE_FORM_URL: expenseFormUrl || '',
    TRIP_PHOTOS_URL: photosUrl || ''
  }, false);
}
