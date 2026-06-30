// 参加者・通貨候補の取得とデフォルト。


function readParticipants_(ss: Spreadsheet): Participant[] {
  return buildParticipants_(readObjects_(ss.getSheetByName(DEFAULT_CONFIG.sheets.participants), 1, 1, 8));
}

function activeParticipantNames_(ss: Spreadsheet): string[] {
  return readParticipants_(ss).map(member => member.name);
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
