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

// シートの列定義は読み書き・セットアップで共有し、列数の食い違いによる
// 非公開列の読み落としを防ぐ。
const ITINERARY_HEADERS = [
  '日付', 'Day', '表示時刻', '表示タイトル', '表示場所', '表示メモ', '必要情報',
  '種別', '表示ラベル', '国', '都市', '移動元', '移動先', '移動手段', '所要時間',
  '主目的', '予約状況', '確定度', '優先度', 'メモ', '宿泊地', '地図検索', '緯度',
  '経度', '天気', '公開ページに表示'
];
const ITINERARY_PRIMARY_HEADERS = ITINERARY_HEADERS.slice(2, 9);
const ITINERARY_AUXILIARY_HEADERS = ITINERARY_HEADERS.slice(-5);

const SETTLEMENT_LOG_HEADERS = [
  'タイムスタンプ', '支払者', '受取者', '精算額', '通貨', '対象ペア', '入力元', 'メモ'
];

// セットアップと新規スプレッドシート公開の双方で使う列定義。
// 片方だけ更新して読み書きの契約がずれることを防ぐ。
const BASIC_INFO_HEADERS = ['key', 'value', '説明', '公開ページに表示'];
const RESERVATION_HEADERS = ['種別', '日付', '名称', '場所', '予約状況', '金額', '通貨', '公開ページに表示', 'メモ'];
const BUDGET_HEADERS = ['カテゴリ', '項目', '予定額', '実績額', '通貨', 'メモ'];
const CHECKLIST_HEADERS = ['カテゴリ', '項目', '期限', '担当', '完了', 'メモ'];

// ダッシュボードのキャッシュキー。版を上げるときはここだけ変え、旧キーは LEGACY に移す。
const DASHBOARD_CACHE_KEY = 'dashboard_data_public_v11';
const LEGACY_DASHBOARD_CACHE_KEYS = [
  'dashboard_data_public_v10',
  'dashboard_data_public_v9',
  'dashboard_data_public_v8',
  'dashboard_data_public_v7',
  'dashboard_data_public_v6'
];
