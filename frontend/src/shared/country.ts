// 緯度経度から国を判定する共有レジストリ。
// 人物ページの訪問国集計、エディタの検索コンテキスト、費用入力の通貨候補で同じ定義を使う。
//
// 矩形は重なる（香港は中国の中、シンガポールはマレーシアの矩形の中）。
// 並び順で解決すると国を足すたびに順番を間違えるので、面積の小さい矩形を優先する。
// 1つの矩形で表せない国は、複数の矩形を登録してよい（ハワイ、イスラエル南部など）。

export type CountryCode =
  // 東・東南・南アジア、中央アジア、コーカサス
  | "HK" | "MO" | "SG" | "TW" | "KR" | "JP" | "CN" | "MN"
  | "IN" | "NP" | "BT" | "BD" | "LK" | "MV" | "PK"
  | "TH" | "VN" | "LA" | "KH" | "MM" | "MY" | "BN" | "PH" | "ID"
  | "KZ" | "UZ" | "GE" | "AM" | "AZ"
  // 中東
  | "AE" | "SA" | "QA" | "KW" | "BH" | "OM" | "JO" | "IL" | "LB" | "TR"
  // ヨーロッパ
  | "IE" | "GB" | "PT" | "ES" | "FR" | "NL" | "BE" | "LU" | "DE" | "CH" | "AT" | "IT" | "MT"
  | "GR" | "CY" | "CZ" | "SK" | "PL" | "HU" | "SI" | "HR" | "BA" | "RS" | "ME" | "MK" | "AL"
  | "BG" | "RO" | "MD" | "UA" | "BY" | "RU"
  | "DK" | "SE" | "NO" | "FI" | "IS" | "EE" | "LV" | "LT"
  // アフリカ
  | "MA" | "TN" | "DZ" | "EG" | "SN" | "GH" | "NG" | "ET" | "KE" | "TZ" | "UG" | "RW"
  | "ZA" | "NA" | "BW" | "ZW" | "MU"
  // 南北アメリカ
  | "CA" | "US" | "MX" | "GT" | "CR" | "PA" | "CU" | "DO" | "JM" | "BS"
  | "CO" | "EC" | "VE" | "PE" | "BO" | "BR" | "PY" | "UY" | "CL" | "AR"
  // オセアニア
  | "AU" | "NZ" | "FJ" | "PG" | "NC" | "PF";

export interface Country {
  code: CountryCode;
  name: string;
  flag: string;
}

interface CountryBox extends Country {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

export const COUNTRY_BOXES: readonly CountryBox[] = [
  // 東アジア
  { code: "HK", name: "香港", flag: "🇭🇰", latMin: 22.1, latMax: 22.6, lngMin: 113.8, lngMax: 114.5 },
  { code: "MO", name: "マカオ", flag: "🇲🇴", latMin: 22.05, latMax: 22.25, lngMin: 113.5, lngMax: 113.65 },
  { code: "TW", name: "台湾", flag: "🇹🇼", latMin: 21, latMax: 27, lngMin: 118, lngMax: 123 },
  { code: "KR", name: "韓国", flag: "🇰🇷", latMin: 33, latMax: 39, lngMin: 124.5, lngMax: 131 },
  { code: "JP", name: "日本", flag: "🇯🇵", latMin: 24, latMax: 46, lngMin: 122.5, lngMax: 154 },
  { code: "MN", name: "モンゴル", flag: "🇲🇳", latMin: 41, latMax: 53, lngMin: 87, lngMax: 120 },
  { code: "CN", name: "中国", flag: "🇨🇳", latMin: 18, latMax: 54, lngMin: 73, lngMax: 135 },

  // 東南アジア
  { code: "SG", name: "シンガポール", flag: "🇸🇬", latMin: 1.1, latMax: 1.6, lngMin: 103.5, lngMax: 104.1 },
  { code: "BN", name: "ブルネイ", flag: "🇧🇳", latMin: 4, latMax: 5.1, lngMin: 114, lngMax: 115.4 },
  // 南側の矩形を東へ伸ばすとホーチミンが入るため、北部だけベトナム国境まで取る。
  { code: "KH", name: "カンボジア", flag: "🇰🇭", latMin: 10, latMax: 13, lngMin: 102.3, lngMax: 106.3 },
  { code: "KH", name: "カンボジア", flag: "🇰🇭", latMin: 13, latMax: 14.7, lngMin: 102.3, lngMax: 107.7 },
  // ラオスとタイはメコン川で接し、矩形では分けきれない。タイ東北部が
  // ラオス判定になることがあるが、通貨候補は両方出るため実害は小さい。
  // 南北で分けるのは、北部の矩形を東へ伸ばすとハノイまで入ってしまうため。
  { code: "LA", name: "ラオス", flag: "🇱🇦", latMin: 17.5, latMax: 22.5, lngMin: 100.1, lngMax: 105.3 },
  { code: "LA", name: "ラオス", flag: "🇱🇦", latMin: 13.9, latMax: 17.5, lngMin: 103.5, lngMax: 107.7 },
  { code: "TH", name: "タイ", flag: "🇹🇭", latMin: 5.5, latMax: 20.6, lngMin: 97, lngMax: 106 },
  { code: "MM", name: "ミャンマー", flag: "🇲🇲", latMin: 9.5, latMax: 28.6, lngMin: 92, lngMax: 101.2 },
  { code: "VN", name: "ベトナム", flag: "🇻🇳", latMin: 8, latMax: 24, lngMin: 102, lngMax: 110 },
  { code: "MY", name: "マレーシア", flag: "🇲🇾", latMin: 0, latMax: 8, lngMin: 99, lngMax: 120 },
  { code: "PH", name: "フィリピン", flag: "🇵🇭", latMin: 4, latMax: 22, lngMin: 116, lngMax: 127 },
  { code: "ID", name: "インドネシア", flag: "🇮🇩", latMin: -11, latMax: 6, lngMin: 95, lngMax: 142 },

  // 南アジア
  { code: "MV", name: "モルディブ", flag: "🇲🇻", latMin: -0.7, latMax: 7.1, lngMin: 72.6, lngMax: 73.8 },
  { code: "LK", name: "スリランカ", flag: "🇱🇰", latMin: 5.8, latMax: 10, lngMin: 79.5, lngMax: 82 },
  { code: "BT", name: "ブータン", flag: "🇧🇹", latMin: 26.7, latMax: 28.4, lngMin: 88.7, lngMax: 92.2 },
  { code: "NP", name: "ネパール", flag: "🇳🇵", latMin: 27, latMax: 30.5, lngMin: 80.5, lngMax: 88.2 },
  { code: "BD", name: "バングラデシュ", flag: "🇧🇩", latMin: 20.5, latMax: 26.7, lngMin: 88.7, lngMax: 92.7 },
  { code: "PK", name: "パキスタン", flag: "🇵🇰", latMin: 23.6, latMax: 37.1, lngMin: 60.8, lngMax: 75.5 },
  { code: "IN", name: "インド", flag: "🇮🇳", latMin: 6, latMax: 36, lngMin: 68, lngMax: 98 },

  // 中央アジア・コーカサス
  { code: "AM", name: "アルメニア", flag: "🇦🇲", latMin: 38.8, latMax: 41.3, lngMin: 43.4, lngMax: 46.6 },
  { code: "GE", name: "ジョージア", flag: "🇬🇪", latMin: 41, latMax: 43.6, lngMin: 40, lngMax: 46.7 },
  { code: "AZ", name: "アゼルバイジャン", flag: "🇦🇿", latMin: 38.3, latMax: 41.9, lngMin: 44.7, lngMax: 50.6 },
  { code: "UZ", name: "ウズベキスタン", flag: "🇺🇿", latMin: 37.1, latMax: 45.6, lngMin: 55.9, lngMax: 73.2 },
  { code: "KZ", name: "カザフスタン", flag: "🇰🇿", latMin: 40.5, latMax: 55.5, lngMin: 46.5, lngMax: 87.4 },

  // 中東
  { code: "BH", name: "バーレーン", flag: "🇧🇭", latMin: 25.7, latMax: 26.4, lngMin: 50.3, lngMax: 50.8 },
  { code: "QA", name: "カタール", flag: "🇶🇦", latMin: 24.4, latMax: 26.2, lngMin: 50.7, lngMax: 51.7 },
  { code: "KW", name: "クウェート", flag: "🇰🇼", latMin: 28.5, latMax: 30.1, lngMin: 46.5, lngMax: 48.5 },
  { code: "LB", name: "レバノン", flag: "🇱🇧", latMin: 33, latMax: 34.7, lngMin: 35, lngMax: 36.6 },
  // イスラエルは南へ行くほど細くなる。1つの矩形だとヨルダン側（ペトラ等）を飲み込む。
  { code: "IL", name: "イスラエル", flag: "🇮🇱", latMin: 31, latMax: 33.4, lngMin: 34.2, lngMax: 35.6 },
  { code: "IL", name: "イスラエル", flag: "🇮🇱", latMin: 29.4, latMax: 31, lngMin: 34.2, lngMax: 35.2 },
  { code: "AE", name: "アラブ首長国連邦", flag: "🇦🇪", latMin: 22.5, latMax: 26.5, lngMin: 51.4, lngMax: 56.5 },
  { code: "JO", name: "ヨルダン", flag: "🇯🇴", latMin: 29.1, latMax: 33.4, lngMin: 34.95, lngMax: 39.3 },
  { code: "OM", name: "オマーン", flag: "🇴🇲", latMin: 16.6, latMax: 26.4, lngMin: 52, lngMax: 59.9 },
  { code: "SA", name: "サウジアラビア", flag: "🇸🇦", latMin: 16, latMax: 32.2, lngMin: 34.5, lngMax: 55.7 },
  { code: "TR", name: "トルコ", flag: "🇹🇷", latMin: 35.8, latMax: 42.2, lngMin: 25.5, lngMax: 45 },

  // ヨーロッパ（西・南）
  { code: "MT", name: "マルタ", flag: "🇲🇹", latMin: 35.8, latMax: 36.1, lngMin: 14.1, lngMax: 14.6 },
  { code: "LU", name: "ルクセンブルク", flag: "🇱🇺", latMin: 49.4, latMax: 50.2, lngMin: 5.7, lngMax: 6.6 },
  { code: "CY", name: "キプロス", flag: "🇨🇾", latMin: 34.5, latMax: 35.7, lngMin: 32.2, lngMax: 34.6 },
  { code: "BE", name: "ベルギー", flag: "🇧🇪", latMin: 49.4, latMax: 51.6, lngMin: 2.4, lngMax: 6.5 },
  { code: "CH", name: "スイス", flag: "🇨🇭", latMin: 45.7, latMax: 47.9, lngMin: 5.8, lngMax: 10.6 },
  { code: "NL", name: "オランダ", flag: "🇳🇱", latMin: 50.7, latMax: 53.7, lngMin: 3.2, lngMax: 7.3 },
  { code: "IE", name: "アイルランド", flag: "🇮🇪", latMin: 51.4, latMax: 55.4, lngMin: -10.6, lngMax: -5.9 },
  // 西部（チロル）は南に細く、1つの矩形にするとミュンヘンまで覆う。
  { code: "AT", name: "オーストリア", flag: "🇦🇹", latMin: 46.3, latMax: 47.7, lngMin: 9.4, lngMax: 13 },
  { code: "AT", name: "オーストリア", flag: "🇦🇹", latMin: 46.4, latMax: 49.1, lngMin: 13, lngMax: 17.2 },
  { code: "PT", name: "ポルトガル", flag: "🇵🇹", latMin: 36.8, latMax: 42.2, lngMin: -9.6, lngMax: -6.1 },
  { code: "GB", name: "イギリス", flag: "🇬🇧", latMin: 49.8, latMax: 59.5, lngMin: -8.7, lngMax: 1.9 },
  { code: "ES", name: "スペイン", flag: "🇪🇸", latMin: 35.9, latMax: 43.9, lngMin: -9.5, lngMax: 4.5 },
  { code: "FR", name: "フランス", flag: "🇫🇷", latMin: 42, latMax: 51.2, lngMin: -5.2, lngMax: 8.3 },
  { code: "DE", name: "ドイツ", flag: "🇩🇪", latMin: 47, latMax: 55.1, lngMin: 5.5, lngMax: 15.5 },
  { code: "IT", name: "イタリア", flag: "🇮🇹", latMin: 36.6, latMax: 47.1, lngMin: 6.6, lngMax: 18.6 },
  { code: "GR", name: "ギリシャ", flag: "🇬🇷", latMin: 34.7, latMax: 41.8, lngMin: 19.3, lngMax: 28.3 },

  // ヨーロッパ（中・東・バルカン）
  { code: "ME", name: "モンテネグロ", flag: "🇲🇪", latMin: 41.8, latMax: 43.6, lngMin: 18.4, lngMax: 20.4 },
  // 南半分を東へ伸ばすとザグレブが入るので、北半分だけ東端まで取る。
  { code: "SI", name: "スロベニア", flag: "🇸🇮", latMin: 45.4, latMax: 46.3, lngMin: 13.3, lngMax: 15.4 },
  { code: "SI", name: "スロベニア", flag: "🇸🇮", latMin: 46.3, latMax: 46.9, lngMin: 13.3, lngMax: 16.6 },
  { code: "MK", name: "北マケドニア", flag: "🇲🇰", latMin: 40.8, latMax: 42.4, lngMin: 20.4, lngMax: 23 },
  { code: "AL", name: "アルバニア", flag: "🇦🇱", latMin: 39.6, latMax: 42.7, lngMin: 19.2, lngMax: 21.1 },
  { code: "BA", name: "ボスニア・ヘルツェゴビナ", flag: "🇧🇦", latMin: 42.5, latMax: 45.3, lngMin: 15.7, lngMax: 19.6 },
  { code: "SK", name: "スロバキア", flag: "🇸🇰", latMin: 47.7, latMax: 49.6, lngMin: 16.8, lngMax: 22.6 },
  { code: "MD", name: "モルドバ", flag: "🇲🇩", latMin: 45.4, latMax: 48.5, lngMin: 26.6, lngMax: 30.2 },
  { code: "HR", name: "クロアチア", flag: "🇭🇷", latMin: 42.4, latMax: 46.6, lngMin: 13.5, lngMax: 19.5 },
  { code: "RS", name: "セルビア", flag: "🇷🇸", latMin: 42.2, latMax: 46.2, lngMin: 18.8, lngMax: 23 },
  { code: "CZ", name: "チェコ", flag: "🇨🇿", latMin: 48.5, latMax: 51.1, lngMin: 12, lngMax: 18.9 },
  { code: "BG", name: "ブルガリア", flag: "🇧🇬", latMin: 41.2, latMax: 44.2, lngMin: 22.3, lngMax: 28.6 },
  { code: "HU", name: "ハンガリー", flag: "🇭🇺", latMin: 45.75, latMax: 48.55, lngMin: 16.45, lngMax: 22.9 },
  { code: "RO", name: "ルーマニア", flag: "🇷🇴", latMin: 43.6, latMax: 48.3, lngMin: 20.2, lngMax: 29.7 },
  { code: "PL", name: "ポーランド", flag: "🇵🇱", latMin: 49, latMax: 54.9, lngMin: 14.1, lngMax: 24.2 },
  { code: "BY", name: "ベラルーシ", flag: "🇧🇾", latMin: 51.2, latMax: 56.2, lngMin: 23.1, lngMax: 32.8 },
  { code: "UA", name: "ウクライナ", flag: "🇺🇦", latMin: 44.3, latMax: 52.4, lngMin: 22.1, lngMax: 40.2 },

  // 北欧・バルト三国
  { code: "LT", name: "リトアニア", flag: "🇱🇹", latMin: 53.9, latMax: 56.5, lngMin: 20.9, lngMax: 26.9 },
  { code: "EE", name: "エストニア", flag: "🇪🇪", latMin: 57.5, latMax: 59.7, lngMin: 21.8, lngMax: 28.2 },
  { code: "LV", name: "ラトビア", flag: "🇱🇻", latMin: 55.6, latMax: 58.1, lngMin: 20.9, lngMax: 28.2 },
  { code: "DK", name: "デンマーク", flag: "🇩🇰", latMin: 54.5, latMax: 57.8, lngMin: 8, lngMax: 15.2 },
  { code: "IS", name: "アイスランド", flag: "🇮🇸", latMin: 63.3, latMax: 66.6, lngMin: -24.6, lngMax: -13.5 },
  // フィンランド湾の南岸（サンクトペテルブルク）を拾わないよう南端を60度で切る。
  { code: "FI", name: "フィンランド", flag: "🇫🇮", latMin: 60, latMax: 70.1, lngMin: 20.5, lngMax: 31.6 },
  { code: "SE", name: "スウェーデン", flag: "🇸🇪", latMin: 55.3, latMax: 69.1, lngMin: 11, lngMax: 24.2 },
  // 東経31度まで届くのは北部だけ。1つの矩形だとサンクトペテルブルクを覆う。
  { code: "NO", name: "ノルウェー", flag: "🇳🇴", latMin: 57.9, latMax: 65, lngMin: 4.5, lngMax: 14.5 },
  { code: "NO", name: "ノルウェー", flag: "🇳🇴", latMin: 65, latMax: 71.2, lngMin: 11, lngMax: 31.1 },
  { code: "RU", name: "ロシア", flag: "🇷🇺", latMin: 41.1, latMax: 77, lngMin: 19.6, lngMax: 180 },

  // アフリカ
  { code: "MU", name: "モーリシャス", flag: "🇲🇺", latMin: -20.6, latMax: -19.9, lngMin: 57.2, lngMax: 57.9 },
  { code: "RW", name: "ルワンダ", flag: "🇷🇼", latMin: -2.9, latMax: -1, lngMin: 28.8, lngMax: 30.9 },
  { code: "SN", name: "セネガル", flag: "🇸🇳", latMin: 12.3, latMax: 16.7, lngMin: -17.6, lngMax: -11.3 },
  { code: "GH", name: "ガーナ", flag: "🇬🇭", latMin: 4.7, latMax: 11.2, lngMin: -3.3, lngMax: 1.2 },
  { code: "UG", name: "ウガンダ", flag: "🇺🇬", latMin: -1.5, latMax: 4.3, lngMin: 29.5, lngMax: 35.1 },
  { code: "TN", name: "チュニジア", flag: "🇹🇳", latMin: 30.2, latMax: 37.6, lngMin: 7.5, lngMax: 11.6 },
  { code: "ZW", name: "ジンバブエ", flag: "🇿🇼", latMin: -22.5, latMax: -15.6, lngMin: 25.2, lngMax: 33.1 },
  { code: "KE", name: "ケニア", flag: "🇰🇪", latMin: -4.8, latMax: 5.1, lngMin: 33.9, lngMax: 41.9 },
  // 東側は南へ伸びていない。1つの矩形だとヨハネスブルグを覆う。
  { code: "BW", name: "ボツワナ", flag: "🇧🇼", latMin: -27, latMax: -17.7, lngMin: 19.9, lngMax: 26 },
  { code: "BW", name: "ボツワナ", flag: "🇧🇼", latMin: -25, latMax: -17.7, lngMin: 26, lngMax: 29.4 },
  { code: "MA", name: "モロッコ", flag: "🇲🇦", latMin: 27.6, latMax: 36, lngMin: -13.3, lngMax: -1 },
  { code: "NG", name: "ナイジェリア", flag: "🇳🇬", latMin: 4.2, latMax: 13.9, lngMin: 2.6, lngMax: 14.7 },
  { code: "TZ", name: "タンザニア", flag: "🇹🇿", latMin: -11.8, latMax: -0.9, lngMin: 29.3, lngMax: 40.5 },
  { code: "EG", name: "エジプト", flag: "🇪🇬", latMin: 21.7, latMax: 31.8, lngMin: 24.5, lngMax: 36.9 },
  { code: "NA", name: "ナミビア", flag: "🇳🇦", latMin: -29, latMax: -16.9, lngMin: 11.7, lngMax: 25.3 },
  { code: "ET", name: "エチオピア", flag: "🇪🇹", latMin: 3.4, latMax: 15, lngMin: 33, lngMax: 48 },
  { code: "ZA", name: "南アフリカ", flag: "🇿🇦", latMin: -35, latMax: -22, lngMin: 16, lngMax: 33 },
  // 地中海沿岸はスペインの矩形の内側に入る。人の行く北部を小さく登録して優先させる。
  { code: "DZ", name: "アルジェリア", flag: "🇩🇿", latMin: 33, latMax: 37.1, lngMin: -1, lngMax: 9 },
  { code: "DZ", name: "アルジェリア", flag: "🇩🇿", latMin: 18.9, latMax: 37.1, lngMin: -8.7, lngMax: 12 },

  // オセアニア
  { code: "NC", name: "ニューカレドニア", flag: "🇳🇨", latMin: -22.8, latMax: -19.5, lngMin: 163.5, lngMax: 168.2 },
  { code: "PF", name: "タヒチ", flag: "🇵🇫", latMin: -18, latMax: -16, lngMin: -152, lngMax: -148 },
  { code: "FJ", name: "フィジー", flag: "🇫🇯", latMin: -19.2, latMax: -16.1, lngMin: 176.9, lngMax: 180 },
  { code: "PG", name: "パプアニューギニア", flag: "🇵🇬", latMin: -11.7, latMax: -1.3, lngMin: 140.8, lngMax: 155.9 },
  { code: "NZ", name: "ニュージーランド", flag: "🇳🇿", latMin: -48, latMax: -33, lngMin: 165, lngMax: 179.9 },
  { code: "AU", name: "オーストラリア", flag: "🇦🇺", latMin: -44, latMax: -10, lngMin: 112, lngMax: 154 },

  // 南北アメリカ。ハワイ・アラスカは本土と別矩形で登録する。
  { code: "US", name: "アメリカ", flag: "🇺🇸", latMin: 18, latMax: 23, lngMin: -161, lngMax: -154 },
  { code: "US", name: "アメリカ", flag: "🇺🇸", latMin: 51, latMax: 72, lngMin: -170, lngMax: -130 },
  // 国境近くの主要都市は、国土全体の矩形より小さく登録して優先させる。
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 48.8, latMax: 49.4, lngMin: -123.5, lngMax: -122.4 },
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 43.4, latMax: 44, lngMin: -80, lngMax: -78.9 },
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 45.3, latMax: 45.8, lngMin: -74.1, lngMax: -73.2 },
  { code: "MX", name: "メキシコ", flag: "🇲🇽", latMin: 18.8, latMax: 20, lngMin: -99.8, lngMax: -98.5 },
  { code: "JM", name: "ジャマイカ", flag: "🇯🇲", latMin: 17.7, latMax: 18.6, lngMin: -78.4, lngMax: -76.2 },
  { code: "DO", name: "ドミニカ共和国", flag: "🇩🇴", latMin: 17.5, latMax: 20, lngMin: -72, lngMax: -68.3 },
  { code: "PA", name: "パナマ", flag: "🇵🇦", latMin: 7.2, latMax: 9.7, lngMin: -83.1, lngMax: -77.2 },
  { code: "CR", name: "コスタリカ", flag: "🇨🇷", latMin: 8, latMax: 11.3, lngMin: -85.9, lngMax: -82.5 },
  { code: "GT", name: "グアテマラ", flag: "🇬🇹", latMin: 13.7, latMax: 17.8, lngMin: -92.3, lngMax: -88.2 },
  { code: "CU", name: "キューバ", flag: "🇨🇺", latMin: 19.8, latMax: 23.3, lngMin: -85, lngMax: -74.1 },
  { code: "BS", name: "バハマ", flag: "🇧🇸", latMin: 20.9, latMax: 27.3, lngMin: -79, lngMax: -72.7 },
  { code: "EC", name: "エクアドル", flag: "🇪🇨", latMin: -5.1, latMax: 1.7, lngMin: -81.1, lngMax: -75.2 },
  { code: "UY", name: "ウルグアイ", flag: "🇺🇾", latMin: -35, latMax: -30, lngMin: -58.2, lngMax: -53 },
  { code: "PY", name: "パラグアイ", flag: "🇵🇾", latMin: -27.6, latMax: -19.2, lngMin: -62.7, lngMax: -54.2 },
  { code: "VE", name: "ベネズエラ", flag: "🇻🇪", latMin: 0.6, latMax: 12.2, lngMin: -73.4, lngMax: -59.8 },
  { code: "BO", name: "ボリビア", flag: "🇧🇴", latMin: -22.9, latMax: -9.6, lngMin: -69.7, lngMax: -57.4 },
  { code: "PE", name: "ペルー", flag: "🇵🇪", latMin: -18.4, latMax: 0, lngMin: -81.4, lngMax: -68.6 },
  { code: "CL", name: "チリ", flag: "🇨🇱", latMin: -56, latMax: -17.5, lngMin: -75.7, lngMax: -66.4 },
  { code: "CO", name: "コロンビア", flag: "🇨🇴", latMin: -4.3, latMax: 13.5, lngMin: -79.1, lngMax: -66.8 },
  { code: "AR", name: "アルゼンチン", flag: "🇦🇷", latMin: -55.1, latMax: -21.7, lngMin: -73.6, lngMax: -53.6 },
  { code: "US", name: "アメリカ", flag: "🇺🇸", latMin: 24, latMax: 50, lngMin: -125, lngMax: -66.5 },
  { code: "MX", name: "メキシコ", flag: "🇲🇽", latMin: 14, latMax: 33, lngMin: -118, lngMax: -86 },
  { code: "BR", name: "ブラジル", flag: "🇧🇷", latMin: -33.8, latMax: 5.3, lngMin: -74, lngMax: -34.7 },
  { code: "CA", name: "カナダ", flag: "🇨🇦", latMin: 42, latMax: 84, lngMin: -141, lngMax: -52 },
];

function boxArea(box: CountryBox): number {
  return (box.latMax - box.latMin) * (box.lngMax - box.lngMin);
}

// 重なりは「狭いほうが正しい」で解く。香港の矩形は中国の矩形の中にあり、
// バンクーバーの矩形はアメリカ本土の矩形の中にある。
const BOXES_BY_AREA: readonly CountryBox[] = [...COUNTRY_BOXES].sort((a, b) => boxArea(a) - boxArea(b));

export function countryOf(lat: number, lng: number): Country | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const match = BOXES_BY_AREA.find((box) =>
    lat >= box.latMin && lat <= box.latMax && lng >= box.lngMin && lng <= box.lngMax,
  );
  return match ? { code: match.code, name: match.name, flag: match.flag } : null;
}

export function countryCodeOf(lat: number, lng: number): CountryCode | null {
  return countryOf(lat, lng)?.code || null;
}

/**
 * 国・地域ごとの法定通貨（ISO 4217）。費用入力の通貨候補を行き先から出すために使う。
 * 旅行ごとに通貨を設定へ書かずに済ませるため、対応はこの表だけに置く。
 * 自国通貨より米ドルが実際に使われる地域（パナマ、エクアドル）は USD にする。
 */
const COUNTRY_CURRENCY: Record<CountryCode, string> = {
  HK: "HKD", MO: "MOP", SG: "SGD", TW: "TWD", KR: "KRW", JP: "JPY", CN: "CNY", MN: "MNT",
  IN: "INR", NP: "NPR", BT: "BTN", BD: "BDT", LK: "LKR", MV: "MVR", PK: "PKR",
  TH: "THB", VN: "VND", LA: "LAK", KH: "KHR", MM: "MMK", MY: "MYR", BN: "BND", PH: "PHP", ID: "IDR",
  KZ: "KZT", UZ: "UZS", GE: "GEL", AM: "AMD", AZ: "AZN",

  AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR",
  JO: "JOD", IL: "ILS", LB: "LBP", TR: "TRY",

  IE: "EUR", GB: "GBP", PT: "EUR", ES: "EUR", FR: "EUR", NL: "EUR", BE: "EUR", LU: "EUR",
  DE: "EUR", CH: "CHF", AT: "EUR", IT: "EUR", MT: "EUR", GR: "EUR", CY: "EUR",
  CZ: "CZK", SK: "EUR", PL: "PLN", HU: "HUF", SI: "EUR", HR: "EUR", BA: "BAM", RS: "RSD",
  ME: "EUR", MK: "MKD", AL: "ALL", BG: "BGN", RO: "RON", MD: "MDL", UA: "UAH", BY: "BYN", RU: "RUB",
  DK: "DKK", SE: "SEK", NO: "NOK", FI: "EUR", IS: "ISK", EE: "EUR", LV: "EUR", LT: "EUR",

  MA: "MAD", TN: "TND", DZ: "DZD", EG: "EGP", SN: "XOF", GH: "GHS", NG: "NGN", ET: "ETB",
  KE: "KES", TZ: "TZS", UG: "UGX", RW: "RWF", ZA: "ZAR", NA: "NAD", BW: "BWP", ZW: "USD", MU: "MUR",

  CA: "CAD", US: "USD", MX: "MXN", GT: "GTQ", CR: "CRC", PA: "USD", CU: "CUP", DO: "DOP",
  JM: "JMD", BS: "BSD", CO: "COP", EC: "USD", VE: "VES", PE: "PEN", BO: "BOB", BR: "BRL",
  PY: "PYG", UY: "UYU", CL: "CLP", AR: "ARS",

  AU: "AUD", NZ: "NZD", FJ: "FJD", PG: "PGK", NC: "XPF", PF: "XPF",
};

export function currencyOfCountry(code: CountryCode | null): string {
  return code ? COUNTRY_CURRENCY[code] || "" : "";
}

const COUNTRY_TEXT_HINTS: ReadonlyArray<readonly [RegExp, CountryCode]> = [
  [/日本|japan|東京|大阪|京都|長野|札幌|福岡|沖縄|那覇|羽田|成田|関空|新千歳|新宿|品川|横浜|名古屋|仙台|盛岡|青森|八戸/i, "JP"],
  [/韓国|south korea|korea|seoul|ソウル|仁川|incheon|釜山|busan/i, "KR"],
  [/台湾|taiwan|taipei|台北|高雄|kaohsiung|桃園|taoyuan|金門|kinmen|馬祖|matsu/i, "TW"],
  [/香港|hong kong/i, "HK"], [/マカオ|macau|macao/i, "MO"],
  [/中国|china|shanghai|上海|beijing|北京|西安|成都/i, "CN"],
  [/モンゴル|mongolia|ulaanbaatar|ウランバートル/i, "MN"],
  [/タイ王国|タイ|thailand|bangkok|バンコク|チェンマイ|chiang mai|プーケット|phuket|suvarnabhumi|スワンナプーム/i, "TH"],
  [/シンガポール|singapore/i, "SG"], [/ベトナム|vietnam|hanoi|ハノイ|ho chi minh|ホーチミン|ダナン|da nang/i, "VN"],
  [/ラオス|laos|vientiane|ビエンチャン|ルアンパバーン|luang prabang/i, "LA"],
  [/カンボジア|cambodia|phnom penh|プノンペン|シェムリアップ|siem reap|アンコール/i, "KH"],
  [/ミャンマー|myanmar|burma|yangon|ヤンゴン|バガン|bagan/i, "MM"],
  [/マレーシア|malaysia|kuala lumpur|クアラルンプール|ペナン|penang/i, "MY"],
  [/ブルネイ|brunei/i, "BN"],
  [/インドネシア|indonesia|bali|バリ|jakarta|ジャカルタ/i, "ID"],
  [/フィリピン|philippines|manila|マニラ|セブ|cebu/i, "PH"],
  [/ネパール|nepal|kathmandu|カトマンズ/i, "NP"], [/ブータン|bhutan/i, "BT"],
  [/バングラデシュ|bangladesh|dhaka|ダッカ/i, "BD"],
  [/スリランカ|sri lanka|colombo|コロンボ/i, "LK"], [/モルディブ|maldives/i, "MV"],
  [/パキスタン|pakistan|islamabad|イスラマバード|lahore|ラホール/i, "PK"],
  [/インド|india|delhi|デリー|mumbai|ムンバイ|バラナシ|varanasi|ジャイプル/i, "IN"],
  [/カザフスタン|kazakhstan|almaty|アルマトイ|astana/i, "KZ"],
  [/ウズベキスタン|uzbekistan|tashkent|タシケント|サマルカンド|samarkand/i, "UZ"],
  [/ジョージア|georgia|tbilisi|トビリシ/i, "GE"], [/アルメニア|armenia|yerevan|エレバン/i, "AM"],
  [/アゼルバイジャン|azerbaijan|baku|バクー/i, "AZ"],

  [/ドバイ|dubai|アブダビ|abu dhabi|アラブ首長国|united arab emirates|\buae\b/i, "AE"],
  [/サウジ|saudi|riyadh|リヤド|jeddah|ジッダ/i, "SA"], [/カタール|qatar|doha|ドーハ/i, "QA"],
  [/クウェート|kuwait/i, "KW"], [/バーレーン|bahrain/i, "BH"], [/オマーン|oman|muscat|マスカット/i, "OM"],
  [/ヨルダン|jordan|amman|アンマン|ペトラ|petra/i, "JO"],
  [/イスラエル|israel|jerusalem|エルサレム|tel aviv|テルアビブ/i, "IL"],
  [/レバノン|lebanon|beirut|ベイルート/i, "LB"],
  [/トルコ|turkey|türkiye|istanbul|イスタンブール|カッパドキア|cappadocia/i, "TR"],

  [/アイルランド|ireland|dublin|ダブリン/i, "IE"],
  [/イギリス|英国|united kingdom|\buk\b|london|ロンドン|エディンバラ|edinburgh/i, "GB"],
  [/ポルトガル|portugal|lisbon|リスボン|porto|ポルト/i, "PT"],
  [/スペイン|spain|madrid|マドリード|barcelona|バルセロナ|セビリア|seville/i, "ES"],
  [/フランス|france|paris|パリ|ニース|nice|マルセイユ|モンサンミッシェル/i, "FR"],
  [/オランダ|netherlands|holland|amsterdam|アムステルダム/i, "NL"],
  [/ベルギー|belgium|brussels|ブリュッセル|ブルージュ|bruges/i, "BE"],
  [/ルクセンブルク|luxembourg/i, "LU"],
  [/ドイツ|germany|berlin|ベルリン|ミュンヘン|munich|フランクフルト|frankfurt/i, "DE"],
  [/スイス|switzerland|zurich|チューリッヒ|ジュネーブ|geneva|ツェルマット|zermatt/i, "CH"],
  [/オーストリア|austria|vienna|ウィーン|ザルツブルク|salzburg/i, "AT"],
  [/イタリア|italy|rome|ローマ|ミラノ|milan|ベネチア|venice|フィレンツェ|florence/i, "IT"],
  [/マルタ|malta/i, "MT"], [/キプロス|cyprus/i, "CY"],
  [/ギリシャ|greece|athens|アテネ|サントリーニ|santorini/i, "GR"],
  [/チェコ|czech|prague|プラハ/i, "CZ"], [/スロバキア|slovakia|bratislava|ブラチスラバ/i, "SK"],
  [/ポーランド|poland|warsaw|ワルシャワ|krakow|クラクフ/i, "PL"],
  [/ハンガリー|hungary|budapest|ブダペスト/i, "HU"],
  [/スロベニア|slovenia|ljubljana|リュブリャナ/i, "SI"],
  [/クロアチア|croatia|zagreb|ザグレブ|dubrovnik|ドブロブニク/i, "HR"],
  [/ボスニア|bosnia|sarajevo|サラエボ/i, "BA"], [/セルビア|serbia|belgrade|ベオグラード/i, "RS"],
  [/モンテネグロ|montenegro/i, "ME"], [/マケドニア|macedonia|skopje/i, "MK"],
  [/アルバニア|albania|tirana/i, "AL"], [/ブルガリア|bulgaria|sofia|ソフィア/i, "BG"],
  [/ルーマニア|romania|bucharest|ブカレスト/i, "RO"], [/モルドバ|moldova/i, "MD"],
  [/ウクライナ|ukraine|kyiv|kiev|キエフ|キーウ/i, "UA"], [/ベラルーシ|belarus|minsk/i, "BY"],
  [/ロシア|russia|moscow|モスクワ|サンクトペテルブルク|st\.? petersburg|ウラジオストク|vladivostok/i, "RU"],
  [/デンマーク|denmark|copenhagen|コペンハーゲン/i, "DK"],
  [/スウェーデン|sweden|stockholm|ストックホルム/i, "SE"],
  [/ノルウェー|norway|oslo|オスロ|ベルゲン|bergen/i, "NO"],
  [/フィンランド|finland|helsinki|ヘルシンキ|ロヴァニエミ|rovaniemi/i, "FI"],
  [/アイスランド|iceland|reykjavik|レイキャビク/i, "IS"],
  [/エストニア|estonia|tallinn|タリン/i, "EE"], [/ラトビア|latvia|riga|リガ/i, "LV"],
  [/リトアニア|lithuania|vilnius|ビリニュス/i, "LT"],

  [/モロッコ|morocco|marrakech|マラケシュ|カサブランカ|casablanca/i, "MA"],
  [/チュニジア|tunisia/i, "TN"], [/アルジェリア|algeria/i, "DZ"],
  [/エジプト|egypt|cairo|カイロ|ルクソール|luxor/i, "EG"],
  [/セネガル|senegal|dakar/i, "SN"], [/ガーナ|ghana|accra/i, "GH"],
  [/ナイジェリア|nigeria|lagos/i, "NG"], [/エチオピア|ethiopia|addis/i, "ET"],
  [/ケニア|kenya|nairobi|ナイロビ|マサイマラ/i, "KE"],
  [/タンザニア|tanzania|zanzibar|ザンジバル|キリマンジャロ|kilimanjaro/i, "TZ"],
  [/ウガンダ|uganda/i, "UG"], [/ルワンダ|rwanda|kigali/i, "RW"],
  [/南アフリカ|south africa|cape town|ケープタウン|johannesburg|ヨハネスブルグ/i, "ZA"],
  [/ナミビア|namibia/i, "NA"], [/ボツワナ|botswana/i, "BW"],
  [/ジンバブエ|zimbabwe|victoria falls|ビクトリアの滝/i, "ZW"],
  [/モーリシャス|mauritius/i, "MU"],

  [/アメリカ|米国|united states|usa|u\.s\.a|new york|ニューヨーク|manhattan|マンハッタン|los angeles|ロサンゼルス|san francisco|サンフランシスコ|hawaii|ハワイ|honolulu|ホノルル|las vegas|ラスベガス/i, "US"],
  [/カナダ|canada|toronto|トロント|vancouver|バンクーバー|モントリオール|montreal/i, "CA"],
  [/メキシコ|mexico|cancun|カンクン/i, "MX"], [/グアテマラ|guatemala/i, "GT"],
  [/コスタリカ|costa rica/i, "CR"], [/パナマ|panama/i, "PA"],
  [/キューバ|cuba|havana|ハバナ/i, "CU"], [/ドミニカ|dominican/i, "DO"],
  [/ジャマイカ|jamaica/i, "JM"], [/バハマ|bahamas/i, "BS"],
  [/コロンビア|colombia|bogota|ボゴタ/i, "CO"], [/エクアドル|ecuador|quito|ガラパゴス|galapagos/i, "EC"],
  [/ベネズエラ|venezuela/i, "VE"], [/ペルー|peru|lima|リマ|マチュピチュ|machu picchu|cusco|クスコ/i, "PE"],
  [/ボリビア|bolivia|ウユニ|uyuni|la paz/i, "BO"],
  [/ブラジル|brazil|rio de janeiro|リオデジャネイロ|sao paulo|サンパウロ/i, "BR"],
  [/パラグアイ|paraguay/i, "PY"], [/ウルグアイ|uruguay/i, "UY"],
  [/チリ|chile|santiago|サンティアゴ|パタゴニア|patagonia/i, "CL"],
  [/アルゼンチン|argentina|buenos aires|ブエノスアイレス/i, "AR"],

  [/オーストラリア|australia|sydney|シドニー|メルボルン|melbourne|ケアンズ|cairns|ゴールドコースト/i, "AU"],
  [/ニュージーランド|new zealand|auckland|オークランド|クイーンズタウン|queenstown/i, "NZ"],
  [/フィジー|fiji/i, "FJ"], [/パプアニューギニア|papua new guinea/i, "PG"],
  [/ニューカレドニア|new caledonia|ヌメア|noumea/i, "NC"],
  [/タヒチ|tahiti|ボラボラ|bora bora|フレンチポリネシア|french polynesia/i, "PF"],
];

export function countryCodeFromText(text: string | undefined): CountryCode | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  return COUNTRY_TEXT_HINTS.find(([pattern]) => pattern.test(raw))?.[1] || null;
}
