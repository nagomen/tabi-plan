// 計画のカバー（サムネ）画像を、行き先の地名キーワードから決める共有ロジック。
// 計画一覧（plans）と計画詳細（dashboard ヒーロー）の両方で使う。
// 初日の目的地 → 国・地域別の cover_*.webp（public/images）にマッピングする。

import * as TripPlans from "./plans-store";
import type { PlanMeta } from "./plans-store";

type CoverMeta = Pick<PlanMeta, "slug" | "route" | "title" | "cover">;

/** 旅行計画の初日の目的地を取得する（行程の先頭 → route → title の順）。 */
export function firstDayLocation(meta: CoverMeta): string {
  const data = TripPlans.getData(meta.slug);
  if (data && Array.isArray(data.cities) && data.cities.length > 0) {
    const firstCity = data.cities.find((city) => (city.name || "").trim());
    if (firstCity) return firstCity.name.trim();
  }
  if (data && Array.isArray(data.itinerary) && data.itinerary.length > 0) {
    const first = data.itinerary[0];
    const loc = (first.area || first.place || first.title || "").trim();
    if (loc) return loc;
  }
  return (meta.route || meta.title || "").trim();
}

/** 行き先の地名キーワードから、国・地域別のカバー画像パスを返す。 */
export function coverImageForLocation(location: string): string {
  const loc = location.toLowerCase();
  // イギリス
  // ※ uk などの短い略称は \b を付けないと fukuoka 等の単語内に誤一致する
  if (/イギリス|英国|ロンドン|london|\buk\b|united.*kingdom|イングランド|コッツウォルズ|エディンバラ/.test(loc)) {
    return "./images/cover_uk.webp";
  }
  // フランス
  if (/フランス|仏国|パリ|paris|france|ニース|リヨン|モンサンミッシェル/.test(loc)) {
    return "./images/cover_france.webp";
  }
  // ドイツ
  if (/ドイツ|独国|ベルリン|berlin|germany|ミュンヘン|フランクフルト|ノイシュヴァンシュタイン/.test(loc)) {
    return "./images/cover_germany.webp";
  }
  // イタリア
  if (/イタリア|伊国|ローマ|\brome\b|italy|ミラノ|ヴェネツィア|フィレンツェ|ナポリ/.test(loc)) {
    return "./images/cover_italia.webp";
  }
  // スペイン
  if (/スペイン|西国|マドリード|madrid|spain|バルセロナ|サグラダファミリア|セビリア/.test(loc)) {
    return "./images/cover_spain.webp";
  }
  // その他ヨーロッパ
  if (/ヨーロッパ|欧州|スイス|オーストリア|ベルギー|オランダ|ポルトガル|ギリシャ|北欧|フィンランド|スウェーデン|ノルウェー|デンマーク|チェコ|ハンガリー|ポーランド|クロアチア|チューリッヒ|ウィーン|ブリュッセル|アムステルダム|リスボン|アテネ|ヘルシンキ|ストックホルム|オスロ|コペンハーゲン|プラハ|ブダペスト|ワルシャワ|ドゥブロヴニク/.test(loc)) {
    return "./images/cover_europe.webp";
  }

  // インド
  if (/インド|デリー|ニューデリー|ムンバイ|タージマハル|india|delhi|mumbai/.test(loc)) {
    return "./images/cover_india.webp";
  }
  // 台湾
  if (/台湾|台北|九份|高雄|九分|taiwan|taipei|jiufen/.test(loc)) {
    return "./images/cover_taiwan.webp";
  }
  // 香港（日別ヘッダーはエリア名で判定することが多いので、九龍・尖沙咀なども拾う）
  if (/香港|hong.*kong|九龍|kowloon|尖沙咀|tsim.*sha.*tsui|旺角|中環|ビクトリアピーク|victoria.*peak/.test(loc)) {
    return "./images/cover_hongkong.webp";
  }
  // 中国（マカオ含む）。「コタイ」を「タイ」に誤判定しないよう、タイより先に置くこと。
  if (/中国|北京|beijing|上海|shanghai|マカオ|macau|コタイ|cotai|タイパ|広州|深セン|深圳|shenzhen|西安|成都|ハルビン|哈爾浜|哈尔滨|harbin|延吉|yanji|長春|changchun|瀋陽|沈阳|shenyang|大連|大连|dalian/.test(loc)) {
    return "./images/cover_china.webp";
  }
  // 韓国
  if (/韓国|ソウル|seoul|釜山|busan|プサン|済州島|チェジュ/.test(loc)) {
    return "./images/cover_korea.webp";
  }
  // タイ（「タイムズスクエア」の「タイ」を拾わないよう除外付き）
  if (/タイ(?!ムズ)|バンコク|プーケット|チェンマイ|アユタヤ|thailand|bangkok|phuket|chiang.*mai/.test(loc)) {
    return "./images/cover_thailand.webp";
  }
  // ベトナム
  if (/ベトナム|ハノイ|ホーチミン|ダナン|ハロン湾|ホイアン|vietnam|hanoi|ho.*chi.*minh|da.*nang|halong.*bay/.test(loc)) {
    return "./images/cover_vietnam.webp";
  }
  // その他アジア
  if (/アジア|シンガポール|マレーシア|クアラルンプール|フィリピン|マニラ|インドネシア|ジャカルタ|バリ|スリランカ|ネパール|モンゴル|カンボジア|アンコールワット|asia/.test(loc)) {
    return "./images/cover_asia.webp";
  }

  // アフリカ
  if (/アフリカ|エジプト|カイロ|ケニア|ナイロビ|南アフリカ|ヨハネスブルグ|モロッコ|カサブランカ|チュニジア|タンザニア|マダガスカル|africa|egypt/.test(loc)) {
    return "./images/cover_africa.webp";
  }

  // カナダ
  if (/カナダ|トロント|バンクーバー|モントリオール|オタワ|ケベック|カルガリー|ナイアガラ|canada|toronto|vancouver|montreal|ottawa|quebec|calgary/.test(loc)) {
    return "./images/cover_canada.webp";
  }
  // 中南米
  if (/中南米|南米|中央アメリカ|ラテンアメリカ|メキシコ|ブラジル|リオデジャネイロ|サンパウロ|ペルー|リマ|マチュピチュ|アルゼンチン|ブエノスアイレス|チリ|サンティアゴ|ボリビア|ウユニ|コロンビア|ボゴタ|キューバ|ハバナ|south.*america|latin.*america|central.*america|mexico|brazil|rio.*de.*janeiro|sao.*paulo|\bperu\b|\blima\b|machu.*picchu|argentina|buenos.*aires|\bchile\b|santiago|bolivia|uyuni|colombia|bogota|\bcuba\b|havana/.test(loc)) {
    return "./images/cover_middle_south_america.webp";
  }

  // アメリカ各州
  // カリフォルニア州
  if (/カリフォルニア|ロサンゼルス|サンフランシスコ|ヨセミテ|シリコンバレー|ディズニーランド|サンディエゴ|\bca\b|california|los.*angeles|san.*francisco/.test(loc)) {
    return "./images/cover_california.webp";
  }
  // ネバダ州
  if (/ネバダ|ラスベガス|リノ|\bnv\b|nevada|las.*vegas/.test(loc)) {
    return "./images/cover_nevada.webp";
  }
  // ハワイ州
  if (/ハワイ|ホノルル|ワイキキ|マウイ|カウアイ|オアフ|\bhi\b|hawaii|honolulu|waikiki/.test(loc)) {
    return "./images/cover_hawaii.webp";
  }
  // ニューヨーク州
  if (/ニューヨーク|マンハッタン|自由の女神|タイムズスクエア|バッファロー|ナイアガラ|\bny\b|new.*york|manhattan/.test(loc)) {
    return "./images/cover_newyork.webp";
  }
  // イリノイ州
  if (/イリノイ|シカゴ|\bil\b|illinois|chicago/.test(loc)) {
    return "./images/cover_illinois.webp";
  }
  // アリゾナ州
  if (/アリゾナ|セドナ|グランドキャニオン|フェニックス|\baz\b|arizona|sedona|grand.*canyon/.test(loc)) {
    return "./images/cover_arizona.webp";
  }
  // それ以外のアメリカ
  if (/アメリカ|米国|ワシントン|シアトル|ボストン|マイアミ|テキサス|フロリダ|グアム|サイパン|\busa\b|united.*states|america|seattle|boston/.test(loc)) {
    return "./images/cover_usa.webp";
  }

  // オーストラリア
  if (/オーストラリア|シドニー|メルボルン|ケアンズ|ウルル|パース|ゴールドコースト|australia|sydney|melbourne|cairns/.test(loc)) {
    return "./images/cover_australia.webp";
  }
  // それ以外のオセアニア
  if (/オセアニア|ニュージーランド|フィジー|タヒチ|オークランド|クライストチャーチ|ポリネシア|メラネシア|ミクロネシア|oceania|new.*zealand|fiji/.test(loc)) {
    return "./images/cover_oceania.webp";
  }

  // 沖縄
  if (/沖縄|那覇|石垣|宮古|首里城|okinawa|naha|ishigaki|miyako/.test(loc)) {
    return "./images/cover_okinawa.webp";
  }

  // 東北地方の既存アセット判定
  if (loc.includes("青森") || loc.includes("aomori") || loc.includes("ねぶた")) {
    return "./images/cover_aomori.webp";
  }
  if (loc.includes("仙台") || loc.includes("sendai") || loc.includes("宮城") || loc.includes("牛タン") || loc.includes("ずんだ")) {
    return "./images/cover_tohoku.webp";
  }
  if (loc.includes("松島") || loc.includes("matsushima")) {
    return "./images/cover_matsushima.webp";
  }
  if (loc.includes("蔵王") || loc.includes("zao") || loc.includes("樹氷") || loc.includes("スキー")) {
    return "./images/cover_zao.webp";
  }
  // 東北（一般）— 個別スポット（青森/仙台/松島/蔵王）に当たらない場合
  if (/東北|岩手|盛岡|秋田|山形|福島|角館|十和田|奥入瀬|銀山温泉|山寺|tohoku/.test(loc)) {
    return "./images/cover_tohoku.webp";
  }

  // 北海道
  if (/北海道|札幌|函館|小樽|旭川|富良野|美瑛|ニセコ|知床|hokkaido|sapporo/.test(loc)) {
    return "./images/cover_hokkaido.webp";
  }
  // 東京（※「東京都」も拾う。京都より先に置くこと）
  if (/東京|渋谷|新宿|浅草|上野|銀座|秋葉原|お台場|スカイツリー|tokyo|shibuya|shinjuku/.test(loc)) {
    return "./images/cover_tokyo.webp";
  }
  // 名古屋（愛知）
  if (/名古屋|愛知|nagoya/.test(loc)) {
    return "./images/cover_nagoya.webp";
  }
  // 京都
  if (/京都|嵐山|祇園|清水寺|金閣寺|伏見稲荷|kyoto/.test(loc)) {
    return "./images/cover_kyoto.webp";
  }
  // 大阪
  if (/大阪|梅田|難波|なんば|道頓堀|通天閣|usj|ユニバ|osaka/.test(loc)) {
    return "./images/cover_osaka.webp";
  }
  // 福岡
  if (/福岡|博多|天神|太宰府|hakata|fukuoka/.test(loc)) {
    return "./images/cover_fukuoka.webp";
  }

  // それ以外の日本
  if (/日本|国内|japan|\bjp\b|富士山|fuji|箱根|伊勢|金沢|広島|四国|九州|山陰|山陽|北陸|信州|甲信越|中部|中国地方|近畿|関西/.test(loc)) {
    return "./images/cover_japan.webp";
  }

  // デフォルト
  return DEFAULT_COVER;
}

const DEFAULT_COVER = "./images/cover_default.webp";

/** 計画全体の代表地からカバー画像を返す。手動設定画像があれば最優先。 */
export function planCoverImage(meta: CoverMeta): string {
  if (meta.cover) return meta.cover;
  return coverImageForLocation(firstDayLocation(meta));
}

/**
 * 特定の日・都市用のカバー画像を返す。手動設定画像があれば最優先。
 * 候補地名を順に試し、地域を特定できた最初の画像を使う。
 * どの候補でも特定できないとき（「尖沙咀〜佐敦エリア」のような辞書に無い地名だけの日）は、
 * 汎用デフォルトに落とさず計画全体の代表地（初日の目的地）で決める。
 */
export function planCoverImageForLocation(meta: CoverMeta, locations: string | readonly string[]): string {
  if (meta.cover) return meta.cover;
  const candidates = Array.isArray(locations) ? locations : [locations];
  for (const candidate of candidates) {
    const loc = String(candidate || "").trim();
    if (!loc) continue;
    const src = coverImageForLocation(loc);
    if (src !== DEFAULT_COVER) return src;
  }
  return coverImageForLocation(firstDayLocation(meta));
}

/** 一覧カードなど小さく表示する場所では、軽量サムネイル版を使う。 */
export function planCoverThumbnail(meta: CoverMeta): string {
  const src = planCoverImage(meta);
  if (!src.startsWith("./images/cover_") || !src.endsWith(".webp")) return src;
  return src.replace("./images/", "./images/thumbs/");
}
