#!/bin/bash
# usage: record.sh <scene> <seconds> <downs> [lang]  (precisa do live.py rodando)
D=$(cd "$(dirname "$0")" && pwd); OUT="${HANGAR_RECORD_OUT:-$D/out}"; SC=$1; SECS=$2; DOWNS=${3:-1}; L=${4:-en}
mkdir -p "$OUT"
curl -sf --retry 5 --retry-connrefused "http://127.0.0.1:47123/control/setup?scene=$SC&lang=$L" >/dev/null || { echo "fixture fora do ar em 127.0.0.1:47123" >&2; exit 1; }
P=$($D/launch.sh $L) || exit 1
# sem pid ou com mais de um, o vídeo sairia sem a janela certa
[ "$(printf '%s\n' "$P" | grep -c .)" = 1 ] || { echo "launch.sh devolveu '$P'; esperado um pid" >&2; exit 1; }
echo $P > "$OUT/mypid"
for i in $(seq $DOWNS); do $D/key.sh $P CTRL Down; sleep 0.4; done
sleep 2.5
G=$($D/geom.sh $P)
grim -g "$G" "$OUT/$SC-$L-pre.png"
RAW="$OUT/$SC-$L-raw.mp4"; LOG="$OUT/$SC-$L-wf.log"
# sem o arquivo velho, "raw existe" prova que esta gravação aconteceu
rm -f "$RAW"
fail() { echo "wf-recorder falhou ($LOG):" >&2; tail -n 20 "$LOG" >&2; kill $P 2>/dev/null; exit 1; }
wf-recorder -g "$G" -r 30 -c libx264 -p crf=18 -p preset=veryfast -f "$RAW" >"$LOG" 2>&1 &
R=$!
sleep 1.2
kill -0 $R 2>/dev/null || fail
curl -s http://127.0.0.1:47123/control/go >/dev/null
sleep $SECS
kill -INT $R; wait $R 2>/dev/null
kill $P
[ -s "$RAW" ] || fail
echo done $SC
