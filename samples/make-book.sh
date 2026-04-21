#!/bin/bash
# 把 samples/<目录>/ 下的 book.json + cards.json 打包成 zip
# 用法: ./make-book.sh 心流Flow

set -e
cd "$(dirname "$0")"

if [ -z "$1" ]; then
  echo "用法: $0 <书目录名>"
  echo "当前可用:"
  ls -d */ 2>/dev/null | sed 's|/||'
  exit 1
fi

DIR="$1"
if [ ! -d "$DIR" ]; then
  echo "❌ 目录不存在: $DIR"
  exit 1
fi

if [ ! -f "$DIR/book.json" ] || [ ! -f "$DIR/cards.json" ]; then
  echo "❌ $DIR 必须包含 book.json 和 cards.json"
  exit 1
fi

OUT="$DIR.zip"
rm -f "$OUT"
cd "$DIR"
zip -q -r "../$OUT" book.json cards.json $(ls cover.* 2>/dev/null || true)
cd ..
echo "✅ 生成: $(pwd)/$OUT"
ls -lh "$OUT"
