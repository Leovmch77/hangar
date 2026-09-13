#!/usr/bin/env bash
# Trava o que `hangar-send --new` manda no POST /api/sessions, contra um backend FALSO que só grava
# o corpo. É shell, a suíte pytest não alcança; e o script de verdade é copiado (não colado aqui),
# pra o teste quebrar junto com ele.
#
# Existe pelo --headless: só a tela de criar sessão abria sessão sem terminal, e o flag faltando no
# script fazia quem orquestra por hangar-send cair calado numa sessão com terminal.
#
# Uso: ./scripts/test-hangar-send-new.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
falhas=0

# O hangar-send chama `python3`. No Windows ele pode ser o atalho da Microsoft Store, que existe no
# PATH e não executa nada: acha um Python que RODA e o expõe como python3 só pra este teste.
PY=""
for c in python3 python py; do
    if "$c" -c 'pass' >/dev/null 2>&1; then PY="$(command -v "$c")"; break; fi
done
[[ -n "$PY" ]] || { echo "FALHA: nenhum Python que execute no PATH"; exit 1; }
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$PY" > "$TMP/bin/python3"
chmod +x "$TMP/bin/python3"
export PATH="$TMP/bin:$PATH"

PORTA=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
mkdir -p "$TMP/scripts" "$TMP/backend"
cp "$REPO/scripts/hangar-send" "$TMP/scripts/hangar-send"
printf 'CP_AUTH_TOKEN=teste\nCP_PORT=%s\n' "$PORTA" > "$TMP/backend/.env"

python3 - "$PORTA" "$TMP/corpo.json" <<'PY' &
import http.server, sys
porta, destino = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        corpo = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        open(destino, "wb").write(corpo)
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(b"{}")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", porta), H).serve_forever()
PY
SERVIDOR=$!
trap 'kill "$SERVIDOR" 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do
    python3 -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), 0.2)' "$PORTA" 2>/dev/null && break
    sleep 0.1
done

campo() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d.get(sys.argv[2])))' "$TMP/corpo.json" "$1"; }
checa() { # <caso> <esperado> <obtido>
    if [[ "$2" == "$3" ]]; then printf 'ok   %s -> %s\n' "$1" "$3"
    else printf 'FALHA %s -> esperava %s, veio %s\n' "$1" "$2" "$3"; falhas=$((falhas + 1)); fi
}

# 1. --headless vai no corpo, junto com o modelo.
rm -f "$TMP/corpo.json"
bash "$TMP/scripts/hangar-send" --new hl-x /tmp --headless --model haiku >/dev/null 2>&1
checa "--headless no corpo" 'true' "$(campo headless 2>/dev/null)"
checa "--model junto" '"haiku"' "$(campo model 2>/dev/null)"

# 2. Sem o flag, a chave nem vai (o default do backend é false).
rm -f "$TMP/corpo.json"
bash "$TMP/scripts/hangar-send" --new sem-flag /tmp >/dev/null 2>&1
checa "sem --headless, sem a chave" 'null' "$(campo headless 2>/dev/null)"

# 3. Só com provider claude: outro provider para ANTES do POST.
rm -f "$TMP/corpo.json"
bash "$TMP/scripts/hangar-send" --new hl-codex /tmp --headless --provider codex >/dev/null 2>&1
checa "--headless com codex: código" '2' "$?"
checa "--headless com codex: nada enviado" 'nao' "$([[ -f "$TMP/corpo.json" ]] && echo sim || echo nao)"

# 4. Repetido é erro, como os outros flags.
bash "$TMP/scripts/hangar-send" --new hl-2x /tmp --headless --headless >/dev/null 2>&1
checa "--headless duas vezes: código" '2' "$?"

# 5. O --help documenta o flag (a ajuda é o cabeçalho do script).
bash "$REPO/scripts/hangar-send" --help 2>/dev/null | grep -q -- '--headless'
checa "--help menciona --headless" '0' "$?"

if [[ $falhas -gt 0 ]]; then echo "$falhas falha(s)"; exit 1; fi
echo "tudo ok"
