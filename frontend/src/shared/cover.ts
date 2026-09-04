// 計画のカバー（サムネ）画像を、行き先から決める共有ロジック。
// 計画一覧（plans）と計画詳細（dashboard ヒーロー）の両方で使う。
// 判定は 地名キーワード → 保存済み座標 の順。座標は計画データ（DB）に
// ジオコーディング済みで入っているため、辞書に無い地名の旅行でも
// 旅行固有のキーワードをコードへ足さずに追従できる。

import * as TripPlans from "./plans-store";
import type { PlanMeta } from "./plans-store";

type CoverMeta = Pick<PlanMeta, "slug" | "route" | "title" | "cover">;

/** 画像判定に使う場所。名前だけ・座標だけでもよい。 */
export interface CoverPlace {
  name?: string;
  lat?: number | string;
  lng?: number | string;
}

/** 計画の代表地（初日の目的地）。行程の先頭 → route → title の順で、座標も添える。 */
function firstDayPlace(meta: CoverMeta): CoverPlace {
  const data = TripPlans.getData(meta.slug);
  if (data && Array.isArray(data.cities) && data.cities.length > 0) {
    const firstCity = data.cities.find((city) => (city.name || "").trim());
    if (firstCity) return { name: firstCity.name.trim(), lat: firstCity.lat, lng: firstCity.lng };
  }
  if (data && Array.isArray(data.itinerary) && data.itinerary.length > 0) {
    const first = data.itinerary[0];
    const name = (first.area || first.place || first.title || "").trim();
    if (name || first.lat != null) return { name, lat: first.lat, lng: first.lng };
  }
  return { name: (meta.route || meta.title || "").trim() };
}

/** 旅行計画の初日の目的地の地名（行程の先頭 → route → title の順）。 */
export function firstDayLocation(meta: CoverMeta): string {
  return String(firstDayPlace(meta).name || "");
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

// ---- 座標→地域画像 -------------------------------------------------------
// 地名キーワードで判定できないときの補助。座標は計画データ（DB）に保存されている
// ものを使うので、リモートで旅行内容を変えても表示が追従する。
// 国境をボックスで厳密には表せないため概算。上から順に判定するので、
// 狭い地域（金門・マカオ等）を広い地域（中国等）より先に置くこと。
const COORD_REGIONS: { img: string; lat: [number, number]; lng: [number, number] }[] = [
  { img: "hongkong", lat: [22.15, 22.45], lng: [113.8, 114.45] }, // 北端は深圳と接するため狭めに
  { img: "china", lat: [22.0, 22.25], lng: [113.4, 113.7] },   // マカオ（専用アセットが無いので中国）
  { img: "taiwan", lat: [24.3, 24.6], lng: [118.1, 118.6] },   // 金門
  { img: "taiwan", lat: [25.9, 26.4], lng: [119.8, 120.1] },   // 馬祖
  { img: "taiwan", lat: [21.8, 25.4], lng: [119.3, 122.1] },
  { img: "korea", lat: [33.0, 38.7], lng: [124.5, 129.8] },
  { img: "okinawa", lat: [24.0, 27.5], lng: [122.5, 131.5] },
  { img: "hokkaido", lat: [41.3, 45.8], lng: [139.3, 146.0] },
  { img: "japan", lat: [30.0, 46.0], lng: [128.8, 147.0] },
  { img: "vietnam", lat: [8.0, 23.5], lng: [102.0, 110.0] },
  { img: "thailand", lat: [5.5, 20.5], lng: [97.3, 105.7] },
  { img: "india", lat: [6.5, 35.5], lng: [68.0, 97.5] },
  { img: "china", lat: [18.0, 54.0], lng: [73.0, 135.0] },
  { img: "asia", lat: [-11.0, 28.0], lng: [92.0, 141.0] },
  { img: "uk", lat: [49.9, 60.9], lng: [-8.7, 1.8] },
  { img: "france", lat: [41.3, 51.1], lng: [-5.2, 9.6] },
  { img: "germany", lat: [47.2, 55.1], lng: [5.9, 15.1] },
  { img: "italia", lat: [36.5, 47.1], lng: [6.6, 18.6] },
  { img: "spain", lat: [35.9, 43.8], lng: [-9.4, 4.4] },
  { img: "europe", lat: [34.5, 71.5], lng: [-25.0, 45.0] },
  { img: "africa", lat: [-35.0, 37.5], lng: [-18.0, 52.0] },
  { img: "hawaii", lat: [18.5, 22.5], lng: [-161.0, -154.5] },
  { img: "nevada", lat: [35.5, 40.0], lng: [-115.9, -114.0] }, // ラスベガス周辺。CAより先に
  { img: "california", lat: [32.5, 42.0], lng: [-124.5, -114.1] },
  { img: "arizona", lat: [31.3, 37.0], lng: [-114.9, -109.0] },
  { img: "illinois", lat: [36.9, 42.6], lng: [-91.6, -87.0] },
  { img: "newyork", lat: [40.4, 45.1], lng: [-79.5, -71.8] },
  { img: "canada", lat: [48.99, 83.5], lng: [-141.0, -52.5] },
  { img: "canada", lat: [43.0, 83.5], lng: [-80.0, -52.5] },   // トロント〜東部
  { img: "usa", lat: [24.5, 49.5], lng: [-125.0, -66.5] },
  { img: "middle_south_america", lat: [-56.0, 33.0], lng: [-118.0, -34.0] },
  { img: "australia", lat: [-44.0, -10.0], lng: [112.0, 154.0] },
  { img: "oceania", lat: [-50.0, -5.0], lng: [154.0, 180.0] },
  { img: "oceania", lat: [-30.0, 5.0], lng: [-180.0, -130.0] },
];

function numeric(value: number | string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 保存済み座標から地域画像を返す。どの地域にも当たらなければ null。 */
export function coverImageForCoord(
  lat: number | string | undefined,
  lng: number | string | undefined,
): string | null {
  const la = numeric(lat);
  const ln = numeric(lng);
  if (la == null || ln == null || (la === 0 && ln === 0)) return null;
  for (const region of COORD_REGIONS) {
    if (region.lat[0] <= la && la <= region.lat[1] && region.lng[0] <= ln && ln <= region.lng[1]) {
      return `./images/cover_${region.img}.webp`;
    }
  }
  return null;
}

/** 1つの場所を 地名キーワード → 座標 の順で画像に解決する。決められなければ null。 */
function coverImageForPlace(place: CoverPlace): string | null {
  const name = String(place.name || "").trim();
  if (name) {
    const byName = coverImageForLocation(name);
    if (byName !== DEFAULT_COVER) return byName;
  }
  return coverImageForCoord(place.lat, place.lng);
}

/** 計画全体の代表地からカバー画像を返す。手動設定画像があれば最優先。 */
export function planCoverImage(meta: CoverMeta): string {
  if (meta.cover) return meta.cover;
  return coverImageForPlace(firstDayPlace(meta)) || DEFAULT_COVER;
}

/**
 * 特定の日・都市用のカバー画像を返す。手動設定画像があれば最優先。
 * 候補（名前や座標）を順に試し、地域を特定できた最初の画像を使う。
 * どの候補でも特定できない日は、汎用デフォルトへ落とさず計画全体の代表画像
 * （＝一覧サムネと同じ）で決める。
 */
export function planCoverImageForLocation(
  meta: CoverMeta,
  places: string | CoverPlace | readonly (string | CoverPlace)[],
): string {
  if (meta.cover) return meta.cover;
  const list = (Array.isArray(places) ? places : [places]) as readonly (string | CoverPlace)[];
  for (const raw of list) {
    const place: CoverPlace = typeof raw === "string" ? { name: raw } : raw || {};
    const src = coverImageForPlace(place);
    if (src) return src;
  }
  return planCoverImage(meta);
}

/** 一覧カードなど小さく表示する場所では、軽量サムネイル版を使う。 */
export function planCoverThumbnail(meta: CoverMeta): string {
  const src = planCoverImage(meta);
  if (!src.startsWith("./images/cover_") || !src.endsWith(".webp")) return src;
  return src.replace("./images/", "./images/thumbs/");
}
