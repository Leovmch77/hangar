#!/bin/bash
# usage: launch.sh [lang] -> pid da janela nova, flutuando no workspace visível do monitor
D=$(cd "$(dirname "$0")" && pwd)
L=${1:-en}
HANGAR_NATIVE_BIN="${HANGAR_NATIVE_BIN:-$(command -v hangar-native)}"
[ -x "$HANGAR_NATIVE_BIN" ] || { echo "hangar-native não encontrado (defina HANGAR_NATIVE_BIN)" >&2; exit 1; }
MONITOR="${HANGAR_RECORD_MONITOR:-$(hyprctl monitors -j | jq -r '.[] | select(.focused) | .name')}"
# tamanho da janela define o do vídeo (1600x960 menos a borda cortada no enc.sh)
SIZE="${HANGAR_RECORD_SIZE:-1600x960}"
POS="${HANGAR_RECORD_POS:-160 60}"

# janela fora do monitor faz o wf-recorder recusar a área; o tamanho útil é o lógico (com escala)
read -r WS MW MH < <(hyprctl monitors -j | jq -r --arg m "$MONITOR" '.[] | select(.name==$m) | "\(.activeWorkspace.id) \(.width/.scale|floor) \(.height/.scale|floor)"')
[ -n "$WS" ] || { echo "monitor '$MONITOR' não encontrado (defina HANGAR_RECORD_MONITOR)" >&2; exit 1; }
read -r X Y <<< "$POS"
if (( X + ${SIZE%x*} > MW || Y + ${SIZE#*x} > MH )); then
  echo "janela $SIZE em $X,$Y não cabe no monitor $MONITOR (${MW}x${MH} lógicos); defina HANGAR_RECORD_MONITOR, HANGAR_RECORD_SIZE ou HANGAR_RECORD_POS" >&2
  exit 1
fi

# configuração isolada: a do app de quem grava nunca é lida nem alterada
mkdir -p "$D/cfg/hangar-native"
jq --arg l "$L" '.language = $l' "$D/appearance.json" > "$D/cfg/hangar-native/appearance.json"
printf '{"address":"http://127.0.0.1:47123/","token":"sintetica-fixture-sessao-0000"}\n' > "$D/cfg/hangar-native/connection.json"

before=$(pgrep -f "^$HANGAR_NATIVE_BIN\$" | sort)
hyprctl dispatch "hl.dsp.exec_cmd('env XDG_CONFIG_HOME=$D/cfg HANGAR_NATIVE_LANG=$L HANGAR_NATIVE_UPDATE_URL=http://127.0.0.1:9 HANGAR_NATIVE_WINDOW=$SIZE $HANGAR_NATIVE_BIN', { workspace = '$WS silent', float = true, size = '${SIZE/x/ }', move = '$POS' })" >/dev/null
sleep 5
comm -13 <(echo "$before") <(pgrep -f "^$HANGAR_NATIVE_BIN\$" | sort)
