#!/bin/bash
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd); OUT="${HANGAR_RECORD_OUT:-$D/out}"; L=${2:-en}
ffmpeg -v error -y -i "$OUT/$1-$L-raw.mp4" -vf "crop=iw-8:ih-8:4:4" -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart -an "$OUT/$1-$L.mp4"
# sem a capa velha, o ls abaixo não mostra uma capa antiga como se fosse nova
rm -f "$OUT/$1-$L.jpg"
ffmpeg -v error -y -ss 0.5 -i "$OUT/$1-$L.mp4" -frames:v 1 -q:v 4 "$OUT/$1-$L.jpg"
ls -la "$OUT/$1-$L.mp4" "$OUT/$1-$L.jpg"
