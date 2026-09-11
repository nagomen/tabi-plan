# 公開設定(trip-config)

`frontend/public/trip-config.js` は旅行そのものではなく、API 接続先や通貨一覧などアプリ全体の公開設定です。
旅行本体は MySQL だけを正本にし、静的設定から自動作成しません。

## 公開範囲

GitHub Pages の静的ファイルは公開情報です。ページに出してよい設定だけを `trip-config.js` に入れ、非公開計画・参加者・費用・招待は API 側のセッション認可で制御します。
共有パスワード、予約番号、宿泊先住所、緊急連絡先、保険証券番号は入れないでください。

## 新しい旅行で使う手順

| 手順 | 作業場所 | やること | 補足 |
| --- | --- | --- | --- |
| 1 | 旅行 repo | `frontend/public/trip-config.example.js` を参考に `frontend/public/trip-config.js` を編集する | `tripSlug` は旅行ごとに必ず変える |
| 2 | ローカル | ルートで `npm run ci` を実行する | 型検査・テスト・ビルドを確認する |
| 3 | GitHub | PR を `main` にマージする | Actions が本番 Pages を更新し、配信内容を検証する |
| 4 | GitHub | API を変更した場合だけ `Deploy API` を手動実行する | API 更新・DB マイグレーション・バックアップタイマー更新 |

`tripSlug` は localStorage のキーに使います。旅行ごとに必ず変えてください。

```js
window.TRIP_CONFIG = {
  tripSlug: "2703-taiwan",
  tripTitle: "2027年3月台湾旅行",
  mode: "local",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY", "TWD", "USD"],
  sharedBackend: {
    enabled: true,
    mode: "api",
    apiBaseUrl: "https://travel-api.example.com"
  }
};
```

## 環境別に変える

環境別に変えたい場合は GitHub の `TRIP_CONFIG_JSON` 変数を使います。

| 変数 | 例 | 公開可否 |
| --- | --- | --- |
| `TRIP_CONFIG_JSON` | `{"tripSlug":"tabi-plan","tripTitle":"Tabi Plan","mode":"local","defaultParticipants":[],"currencies":["JPY","TWD"],"sharedBackend":{"enabled":true,"mode":"api","apiBaseUrl":"https://travel-api.example.com"}}` | Pages に含まれるため公開情報として扱う |

## 場所検索

エディタの「検索」は、既定では無料の OpenStreetMap(Nominatim)を使います。
公開 API の利用規約に従い、Nominatim は検索ボタンを押した明示操作に限り、入力中の自動候補には使いません。
検索結果はセッション内でキャッシュし、旅行の国・都市座標を検索範囲へ反映します。

多言語の施設検索と入力中の候補表示を使いたい場合は、`trip-config.js` に Mapbox の公開トークンを設定します。
設定すると Mapbox Search Box へ切り替わり、AI 生成行程が返した住所・地図座標も検索結果で照合します。
Mapbox 未設定でも AI 生成時に Web 検索で確認した住所・座標を保存します。Mapbox 障害時に施設名を Nominatim へ自動送信することはありません。

```js
window.TRIP_CONFIG = {
  // ...
  geocoding: { mapboxToken: "pk.xxxxx" } // https://account.mapbox.com/ の Access tokens(無料枠あり)
};
```

トークンはクライアントに露出する公開トークンです。Mapbox 側で URL 制限をかけて利用してください。
都市・場所とも検索結果は自動確定せず、候補を選んで登録します。座標が分かっている場合は、予定を開いて「地図で指定」から地図クリックでも登録できます。
