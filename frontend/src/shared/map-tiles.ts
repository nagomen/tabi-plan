// 地図の下地（タイル）の指定を1か所にまとめる。
//
// もともとは OpenStreetMap の標準タイルを4画面それぞれで直に書いていた。
// 標準タイルは彩度が高く、道路の階層や地名の優先度が分かりにくい。
// CARTO の Voyager は、地の色を落として道路と POI ラベルだけを立たせる絵柄で、
// Google マップに近い読みやすさになる。中身は同じ OpenStreetMap のデータ。
//
// API キーは不要。非商用利用は無料で、表示元の表記（attribution）が条件。
// https://carto.com/basemaps/ / https://carto.com/attributions
//
// URL の {r} はレティナ用で、高解像度の端末では @2x のタイルが読まれる。
export const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

export const TILE_OPTIONS: {
  subdomains: string;
  maxZoom: number;
  attribution: string;
} = {
  subdomains: "abcd",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
    ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
};
