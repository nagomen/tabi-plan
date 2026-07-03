#!/usr/bin/env bash
# PNG → WebP 一括変換ツール。
# 各 foo.png を foo.webp に変換し、同名の既存 .webp があれば置き換える。
# 変換後、元の .png は削除する（-k で残せる）。
#
# 使い方:
#   scripts/png2webp.sh [ディレクトリ] [-q 品質] [-r] [-k]
#     ディレクトリ  省略時は frontend/public/images
#     -q 品質       WebP 品質 0-100（既定 82。アイコン等くっきりさせたい時は 90 など）
#     -r            サブディレクトリも再帰的に変換
#     -k            元の .png を削除せず残す（既定は削除）
#     -h            このヘルプ
#
# 例:
#   cd frontend
#   scripts/png2webp.sh                    # public/images を変換
#   scripts/png2webp.sh public -q 90       # public 直下（アイコン等）を高品質で
#   scripts/png2webp.sh ~/Downloads/imgs -r
#
# 依存: cwebp（未導入なら `brew install webp`）
set -euo pipefail

quality=82
recursive=0
keep=0
dir=""

while [ $# -gt 0 ]; do
  case "$1" in
    -q) quality="${2:-82}"; shift 2 ;;
    -r) recursive=1; shift ;;
    -k) keep=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不明なオプション: $1" >&2; exit 2 ;;
    *) dir="$1"; shift ;;
  esac
done

# 既定ディレクトリはこのスクリプトから見た frontend/public/images
script_dir="$(cd "$(dirname "$0")" && pwd)"
dir="${dir:-$script_dir/../public/images}"

if ! command -v cwebp >/dev/null 2>&1; then
  echo "cwebp が見つかりません。'brew install webp' を実行してください。" >&2
  exit 1
fi
if [ ! -d "$dir" ]; then
  echo "ディレクトリがありません: $dir" >&2
  exit 1
fi

# macOS 標準の bash 3.2 でも動くよう find -print0 + read で列挙
depth=""
[ "$recursive" -eq 0 ] && depth="-maxdepth 1"

count=0
replaced=0
# shellcheck disable=SC2086
while IFS= read -r -d '' png; do
  webp="${png%.*}.webp"
  tag=""
  if [ -f "$webp" ]; then tag=" (既存を置換)"; replaced=$((replaced + 1)); fi
  if cwebp -quiet -q "$quality" "$png" -o "$webp"; then
    [ "$keep" -eq 0 ] && rm -f "$png"
    count=$((count + 1))
    printf "  ✓ %s → %s%s\n" "$(basename "$png")" "$(basename "$webp")" "$tag"
  else
    printf "  ✗ 失敗: %s\n" "$png" >&2
  fi
done < <(find "$dir" $depth -type f -iname '*.png' -print0)

if [ "$count" -eq 0 ]; then
  echo "変換対象の .png はありませんでした: $dir"
else
  echo "完了: ${count} 件変換（うち ${replaced} 件は既存 .webp を置換 / 品質 q=${quality}）— ${dir}"
fi
