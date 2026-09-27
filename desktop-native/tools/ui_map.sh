#!/usr/bin/env bash
# Funções para prova.sh acharem controles do hangar-native pelo mapa de elementos, sem OCR.
# Uso: source ui_map.sh, com UI_MAP=<arquivo que o app grava por HANGAR_NATIVE_UI_MAP>
# e UI_MAP_PID=<PID do app aberto pela prova>. Referência: ui_map.md ao lado.
# O id aceita `*` no fim como prefixo (`message-*`). Só elementos visíveis contam.

UI_MAP_WS=${UI_MAP_WS:-21}

_ui_map_matches() {
	[[ -s "${UI_MAP:?defina UI_MAP}" ]] || return 0
	jq -r --arg id "$1" '.elements[] | select(.visible)
		| select(if ($id | endswith("*")) then (.id | startswith($id[:-1])) else .id == $id end)
		| "\(.x) \(.y) \(.w) \(.h)"' "$UI_MAP"
}

# Imprime "x y w h" (pixels lógicos relativos à janela) do único elemento visível com o id.
ui_map_bounds() {
	local found count
	found=$(_ui_map_matches "${1:?ui_map_bounds <id>}")
	if [[ -z $found ]]; then echo "ui_map: $1 não está visível" >&2; return 1; fi
	count=$(wc -l <<<"$found")
	if ((count > 1)); then echo "ui_map: $1 é ambíguo ($count visíveis)" >&2; return 2; fi
	echo "$found"
}

# Espera o id ficar visível (pelo menos um). Timeout em segundos, padrão 20.
ui_map_wait() {
	local deadline=$((SECONDS + ${2:-20}))
	until [[ -n $(_ui_map_matches "${1:?ui_map_wait <id> [timeout]}") ]]; do
		((SECONDS < deadline)) || { echo "ui_map: $1 não apareceu em ${2:-20}s" >&2; return 1; }
		sleep 0.1
	done
}

# Espera o id sumir da tela.
ui_map_wait_gone() {
	local deadline=$((SECONDS + ${2:-20}))
	while [[ -n $(_ui_map_matches "${1:?ui_map_wait_gone <id> [timeout]}") ]]; do
		((SECONDS < deadline)) || { echo "ui_map: $1 não sumiu em ${2:-20}s" >&2; return 1; }
		sleep 0.1
	done
}

# Espera o mapa ficar parado por <ms> (padrão 400): a tela terminou de mudar.
ui_map_settle() {
	local quiet=${1:-400} deadline=$((SECONDS + ${2:-20})) last="" now since
	since=$(date +%s%3N)
	while :; do
		# Sem arquivo ainda não há tela para estar parada.
		now=$(jq '.seq' "${UI_MAP:?defina UI_MAP}" 2>/dev/null || echo ausente)
		if [[ $now != "$last" ]]; then last=$now since=$(date +%s%3N)
		elif [[ $now != ausente ]] && (($(date +%s%3N) - since >= quiet)); then return 0; fi
		((SECONDS < deadline)) || { echo "ui_map: a tela não parou em ${2:-20}s" >&2; return 1; }
		sleep 0.05
	done
}

# Janela do UI_MAP_PID no workspace da prova e com o foco; imprime "x y" da origem.
_ui_map_window() {
	local client active
	client=$(hyprctl clients -j | jq -c --argjson pid "${UI_MAP_PID:?defina UI_MAP_PID}" 'map(select(.pid == $pid)) | first // empty')
	[[ -n $client ]] || { echo "ui_map: janela do PID $UI_MAP_PID não existe" >&2; return 1; }
	[[ $(jq '.workspace.id' <<<"$client") == "$UI_MAP_WS" ]] || { echo "ui_map: janela fora do workspace $UI_MAP_WS" >&2; return 1; }
	active=$(hyprctl activewindow -j | jq '.pid // 0')
	[[ $active == "$UI_MAP_PID" ]] || { echo "ui_map: foco não está na janela da prova (PID ativo $active)" >&2; return 1; }
	jq -r '"\(.at[0]) \(.at[1])"' <<<"$client"
}

# Espera o id, confere janela e foco, e clica no centro dele.
ui_map_click() {
	local id=${1:?ui_map_click <id>} x y w h wx wy cx cy
	ui_map_wait "$id" "${2:-20}" || return 1
	read -r x y w h < <(ui_map_bounds "$id") || return 1
	read -r wx wy < <(_ui_map_window) || return 1
	cx=$(jq -n "$wx + $x + $w / 2 | floor") cy=$(jq -n "$wy + $y + $h / 2 | floor")
	hyprctl dispatch movecursor "$cx $cy" >/dev/null
	[[ $(hyprctl cursorpos -j | jq -c '[.x, .y]') == "[$cx,$cy]" ]] || { echo "ui_map: cursor não chegou em $cx,$cy" >&2; return 1; }
	_ui_map_window >/dev/null || return 1
	ydotool click 0xC0 >/dev/null
}
