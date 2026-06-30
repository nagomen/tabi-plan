// 共有する型・インターフェイスとグローバル定数。

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

// ダッシュボードのキャッシュキー。版を上げるときはここだけ変え、旧キーは LEGACY に移す。
const DASHBOARD_CACHE_KEY = 'dashboard_data_public_v11';
const LEGACY_DASHBOARD_CACHE_KEYS = [
  'dashboard_data_public_v10',
  'dashboard_data_public_v9',
  'dashboard_data_public_v8',
  'dashboard_data_public_v7',
  'dashboard_data_public_v6'
];
