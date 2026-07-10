// 公開ダッシュボード JSON の構築とキャッシュ。


function dashboardCacheKey_(options: DataOptions) {
  return (options && options.includeHidden) ? '' : DASHBOARD_CACHE_KEY;
}

function getCachedDashboardData_(options: DataOptions): TripDashboardData | null {
  const key = dashboardCacheKey_(options || {});
  if (!key) return null;
  try {
    const cached = CacheService.getScriptCache().get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    Logger.log(`getCachedDashboardData_ failed: ${errorMessage_(error)}`);
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
    Logger.log(`putCachedDashboardData_ failed (likely oversized trip): ${errorMessage_(error)}`);
  }
}

function clearDashboardCache_() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(DASHBOARD_CACHE_KEY);
    LEGACY_DASHBOARD_CACHE_KEYS.forEach(key => cache.remove(key));
  } catch (error) {
    // Best-effort cache invalidation.
    Logger.log(`clearDashboardCache_ failed: ${errorMessage_(error)}`);
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

  return buildTripData_({
    itineraryRows,
    budgetRows,
    spreadsheetId,
    basicInfo,
    linkRows,
    checklistRows,
    participantRows,
    expenseRows,
    exchangeRateRows,
    settlementCompletionRows,
    localInfoRows,
    options: options || {},
    runtimeOptions: { allowFxFetch }
  });
}

interface BuildTripDataInput {
  itineraryRows: SheetRow[];
  budgetRows: SheetRow[];
  spreadsheetId: string;
  basicInfo: Record<string, string>;
  linkRows: SheetRow[];
  checklistRows: SheetRow[];
  participantRows: SheetRow[];
  expenseRows: SheetRow[];
  exchangeRateRows: SheetRow[];
  settlementCompletionRows: SheetRow[];
  localInfoRows: SheetRow[];
  options: DataOptions;
  runtimeOptions: RuntimeOptions;
}

function buildTripData_(input: BuildTripDataInput): TripDashboardData {
  const {
    itineraryRows,
    budgetRows,
    spreadsheetId,
    basicInfo,
    linkRows,
    checklistRows,
    participantRows,
    expenseRows,
    exchangeRateRows,
    settlementCompletionRows,
    localInfoRows,
    options,
    runtimeOptions
  } = input;
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
      expenseDetails: settlement.expenseDetails || [],
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
