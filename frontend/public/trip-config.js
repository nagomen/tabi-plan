window.TRIP_CONFIG = {
  // 複数旅行を扱うアプリ全体の設定。旅行本体はMySQLだけを正本にする。
  tripSlug: "tabi-plan",
  tripTitle: "Tabi Plan",
  mode: "local",
  defaultParticipants: [],
  currencies: ["JPY", "HKD", "MOP", "CNY", "TWD", "USD", "EUR", "KRW", "THB", "SGD", "AUD", "GBP"],
  auth: {
    enabled: false
  },
  // 公開ページは閲覧のみ。編集は plan_members で許可された参加者に限定する。
  openEditing: false,
  mapDefaults: {
    center: [30, 120],
    zoom: 4,
    overviewRadiusKm: 1600
  },
  // 共有ストア（MySQL）。非公開データと書き込みはLINE等のログインセッションで認可する。
  sharedBackend: {
    enabled: true,
    mode: "api",
    apiBaseUrl: "https://travel-api.vote-jt.com"
  },
  geocoding: {
    // 計画エディタの場所検索。Mapbox 公開トークン（pk.…）を入れると
    // 多言語POI検索になり「プラザホテル ニューヨーク」等も引ける。
    // AI生成行程の施設住所と地図座標は設定なしでも登録し、設定時はMapboxで照合する。
    // 空なら明示的に検索ボタンを押した時だけ OpenStreetMap(Nominatim) を使う。
    // 公開Nominatimの規約に従い、入力中の自動候補には利用しない。
    // 取得: https://account.mapbox.com/ → Access tokens（無料枠あり）
    mapboxToken: ""
  }
};
