// 立替・割り勘の集計、送金最小化、精算完了の反映。


// 1件の支出の負担配分を決める純粋関数。精算範囲（精算不要/個別金額/選んだ人だけ/全員）の
// 分岐をここ一箇所に集約する。amount と individualShares は円換算後の値で渡す。
//   shares        … 精算（paid/owed）に使う負担割。精算不要は空。
//   expenseShares … 費用按分（expenseByPerson）。精算不要は支払者が全額を持つ。
function allocateExpense_(mode: string, payer: string, names: string[], selected: string[], individualShares: PersonShare[], amount: number): { kind: 'free' | 'individual' | 'split'; settlementAmount: number; shares: PersonShare[]; expenseShares: PersonShare[] } {
  if (/精算不要/.test(mode)) {
    const expenseShares = payer ? [{ name: payer, amount }] : [];
    return { kind: 'free', settlementAmount: 0, shares: [], expenseShares };
  }
  if (/個別金額/.test(mode) && individualShares.length) {
    const settlementAmount = individualShares.reduce((sum, share) => sum + share.amount, 0);
    return { kind: 'individual', settlementAmount, shares: individualShares, expenseShares: individualShares };
  }
  const targets = (/選んだ人だけ/.test(mode) && selected.length) ? selected : names;
  const perPerson = targets.length ? amount / targets.length : 0;
  const shares = targets.map(name => ({ name, amount: perPerson }));
  return { kind: 'split', settlementAmount: amount, shares, expenseShares: shares };
}

// 表示用の対象者名。精算不要は支払者、それ以外は負担割の対象者。
function allocationTargetNames_(allocation: { kind: string; shares: PersonShare[]; expenseShares: PersonShare[] }): string[] {
  return (allocation.kind === 'free' ? allocation.expenseShares : allocation.shares).map(share => share.name);
}

function buildSettlement_(expenseRows: SheetRow[], participants: Participant[], planned: number, exchangeRateRows: SheetRow[], settlementCompletionRows: SheetRow[], runtimeOptions: RuntimeOptions): Record<string, any> {
  const participantNames = participants.map(member => member.name);
  const names = participantNames.length ? participantNames : inferParticipantNames_(expenseRows);
  const rateIndex = buildExchangeRateIndex_(exchangeRateRows);
  const resolveRate = makeRateResolver_(rateIndex, runtimeOptions || {});
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
    const title = valueByKeys_(row, ['内容', 'title', '品目']) || '立替';
    const category = valueByKeys_(row, ['カテゴリ', 'category']);
    const amountOriginal = parseYen_(valueByKeys_(row, ['金額']));
    if (!amountOriginal) return;

    const selected = parsePeople_(valueByKeys_(row, ['対象者（全員以外）', '対象者（全員以外の場合）']))
      .filter(name => names.includes(name));
    const individualOriginalShares = names.map(name => ({
      name,
      amount: parseYen_(valueByKeys_(row, [`個別金額_${name}`, `${name}の分として支払った金額`, `${name}の分`, name]))
    })).filter(share => share.amount > 0);

    const rate = resolveRate(currency, paidDate);
    if (!rate) {
      const targetNames = allocationTargetNames_(allocateExpense_(mode, payer, names, selected, individualOriginalShares, amountOriginal));
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

    const individualShares = individualOriginalShares
      .map(share => ({ name: share.name, amount: share.amount * rate.value }))
      .filter(share => share.amount > 0);
    const allocation = allocateExpense_(mode, payer, names, selected, individualShares, amount);

    const detailShares = (allocation.kind === 'free' ? allocation.expenseShares : allocation.shares).map(share => ({
      name: share.name,
      amount: Math.round(share.amount),
      amountLabel: formatYenZero_(share.amount)
    }));
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

    allocation.expenseShares.forEach(share => {
      expenseByPerson[share.name] = (expenseByPerson[share.name] || 0) + share.amount;
    });

    if (allocation.kind === 'free') return;
    if (isSettledExpense_(row)) return;
    if (!payer) return;

    paidBy[payer] = (paidBy[payer] || 0) + allocation.settlementAmount;
    allocation.shares.forEach(share => {
      owedBy[share.name] = (owedBy[share.name] || 0) + share.amount;
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

function appendSettlementCompletion_(ss: Spreadsheet, params: Params): void {
  const from = String(params.from || '').trim();
  const to = String(params.to || '').trim();
  const amount = parseYen_(params.amount);
  const note = String(params.note || '').trim();

  if (!from) throw new Error('精算する人が未入力です');
  if (!to) throw new Error('精算先が未入力です');
  if (from === to) throw new Error('精算する人と精算先が同じです');
  if (!amount) throw new Error('精算額が未入力です');

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

  // ヘッダー整備から行追加までを一括でロックする。
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSettlementCompletionsSheet_(ss);
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

function ensureSettlementCompletionsSheet_(ss: Spreadsheet): Sheet {
  const headers = ['タイムスタンプ', '支払者', '受取者', '精算額', '通貨', '対象ペア', '入力元', 'メモ'];
  const sheet = getOrCreateSheet_(ss, DEFAULT_CONFIG.sheets.settlementLog);
  ensureHeaderRow_(sheet, 1, headers);
  return sheet;
}
