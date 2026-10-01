#!/usr/bin/env bash
# vigia.sh -e: a lista segue `orq ball` e os avisos ao árbitro passam por `orq notify`.
# Sem backend: curl e hangar-send são falsos. O envio do orq tem fake próprio (linha `orq: …`),
# para que um alarme que saia por hangar-send direto não passe por um que saiu pelo orq.
set -euo pipefail
raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
export VT="$t"
mkdir -p "$t/bin"
# /api/sessions responde $VT/sessions.json, ou nada com $VT/api-down; $VT/on-sessions, se existir,
# roda uma vez antes. /history responde $VT/history.json. DELETE (?by=) e /pair respondem ok, ou
# falham com $VT/close-fails, $VT/close-404 e $VT/pair-fails.
cat > "$t/bin/curl" <<'SH'
#!/bin/sh
for a; do url=$a; done
printf '%s\n' "$*" >> "$VT/urls"
case "$url" in
  */api/sessions)
    [ -f "$VT/api-down" ] && exit 0
    if [ -f "$VT/on-sessions" ]; then bash "$VT/on-sessions"; rm -f "$VT/on-sessions"; fi
    cat "$VT/sessions.json" ;;
  */history*) [ -f "$VT/history.json" ] || exit 22; cat "$VT/history.json" ;;
  *'?by='*)
    [ -f "$VT/close-404" ] && { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    [ -f "$VT/close-fails" ] && { echo "curl: (22) The requested URL returned error: 500" >&2; exit 22; }
    echo '{"ok":true}' ;;
  */pair)
    [ -f "$VT/pair-fails" ] && { echo "curl: (22) The requested URL returned error: 409" >&2; exit 22; }
    echo '{"ok":true}' ;;
  *) exit 22 ;;
esac
SH
cat > "$t/bin/hangar-send" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$VT/sent.log"
SH
# $VT/falha = "<n> <trecho>": as próximas n entregas do orq que contêm o trecho falham.
cat > "$t/bin/orq-send" <<'SH'
#!/bin/sh
printf 'orq: %s\n' "$*" >> "$VT/sent.log"
if [ -f "$VT/falha" ]; then
  read -r n trecho < "$VT/falha"
  case "$*" in
    *"$trecho"*) if [ "$n" -gt 0 ]; then echo "$((n - 1)) $trecho" > "$VT/falha"; exit 1; fi ;;
  esac
fi
SH
chmod +x "$t/bin/curl" "$t/bin/hangar-send" "$t/bin/orq-send"
printf 'CP_AUTH_TOKEN=x\n' > "$t/env"
export ORQ_SEND="$t/bin/orq-send" ORQ_JEV=off
ORQPY="$raiz/skills/orquestrar/scripts/orq.py"
orq() { python3 "$ORQPY" --dir "$d" "$@" >/dev/null; }
novo() {
  d="$t/$1"; mkdir -p "$d"
  : > "$t/sent.log"; : > "$t/urls"; : > "$t/err"
  rm -f "$t/falha" "$t/api-down" "$t/history.json" "$t/close-fails" "$t/close-404" "$t/pair-fails"
  cat > "$t/orq-plano.md" <<'MD'
# Orchestration plan — t

## Projeto
Checagens: —
Integração: —
Prova: por-task
Paralelo: até 4
Revisão: sessão
Correção pelo revisor: até 0 linhas

## Tasks
| # | What it is | Where in their plan | Files | Verification | Wave | Roteiro |
|---|---|---|---|---|---|---|
| 1 | t | §1 | `README.md` | `true` | 1 | — |
MD
  python3 "$ORQPY" plan-check "$t/orq-plano.md" --repo "$raiz" --stamp >/dev/null
  orq init --arbiter arb --repo "$raiz" --contract "$t/regras.md" --plan "$t/orq-plano.md"
}
# M, CICLOS, INTERVALO, REP e CLOSE_IDLE_S mudam por cenário (VAR=x vigia); o stderr do vigia vai pro $VT/err.
vigia() {
  PATH="$t/bin:$PATH" CP_ENV="$t/env" CP_VIGIA_INTERVALO="${INTERVALO:-0}" CP_VIGIA_CICLOS="${CICLOS:-3}" \
    CP_VIGIA_REP="${REP:-10}" CP_VIGIA_CLOSE_IDLE_S="${CLOSE_IDLE_S:-600}" CP_VIGIA_LOG="$t/err" \
    timeout 20 bash "$raiz/skills/orquestrar/scripts/vigia.sh" arb -e "$d" -m "${M:-1}" "$@" > "$t/out" 2>> "$t/err" || fail "vigia died (rc=$?)"
}
fail() { echo "FAIL: $1"; for f in out err sent.log; do echo "--- $f"; cat "$t/$f"; done; exit 1; }

# A vez é do revisor: só ele é vigiado e cutucado; o árbitro é avisado pelo orq.
printf '%s' '[{"name":"exec1","state":"idle"},{"name":"rev1","state":"idle"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo vez
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
orq event entrega --task 1 --rodada 1 --commit abc
vigia
grep -q "watching: rev1 arb" "$t/out" || fail "a lista não seguiu a vez"
grep -q "^--tmux rev1 .*orq notify '\[decisao\]" "$t/sent.log" || fail "rev1 não foi cutucado com o caminho do orq notify"
if grep -q "exec1" "$t/sent.log"; then fail "exec1 espera como mandado e foi cutucado"; fi
grep -q "^orq: --tmux arb \[vigia\] ARMED" "$t/sent.log" || fail "a prova de armação não passou pelo orq"
grep -q "^orq: --tmux arb \[vigia\] rev1 is stopped" "$t/sent.log" || fail "o árbitro não foi avisado pelo orq"
if grep -q "^--tmux arb " "$t/sent.log"; then fail "recado ao árbitro saiu por fora do orq"; fi
# Batimento: o painel sabe quem o vigia olha sem perguntar ao árbitro.
python3 - "$d/vigia.json" <<'PY' || fail "batimento ausente ou torto"
import json, sys
hb = json.load(open(sys.argv[1], encoding="utf-8"))
assert hb["arbiter"] == "arb" and hb["watching"] == ["rev1", "arb"], hb
assert hb["states"] == {"rev1": "idle", "arb": "idle"} and hb["interval_s"] == 0, hb
assert isinstance(hb["pid"], int) and "T" in hb["ts"], hb
PY
if ls -A "$d" | grep -q '^\.vigia\.json\.'; then fail "sobrou temporário do batimento"; fi

# Sucessão do árbitro antes do lançamento: armação, lista, alarmes e /orq vão para arb2.
printf '%s' '[{"name":"exec1","state":"idle"},{"name":"rev1","state":"idle"},{"name":"arb2","state":"idle"}]' > "$t/sessions.json"
novo troca
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
orq event entrega --task 1 --rodada 1 --commit abc
orq event sessao_trocada --de arb --para arb2
vigia
grep -q "watching: rev1 arb2" "$t/out" || fail "a lista não seguiu a sucessão do árbitro"
grep -q "^orq: --tmux arb2 \[vigia\] ARMED" "$t/sent.log" || fail "a armação não foi para o árbitro da vez"
grep -q "^orq: --tmux arb2 \[vigia\] rev1 is stopped" "$t/sent.log" || fail "o alarme não foi para arb2"
if grep -q -- "--tmux arb " "$t/sent.log"; then fail "falou com o árbitro que saiu"; fi
grep -q "/api/sessions/arb2/orq" "$t/urls" || fail "o contrato não foi lido do árbitro da vez"

# Cota estourada em duas sessões seguidas: a troca de vez rearma o alarme.
printf '%s' '[{"name":"exec1","state":"idle","limited":true},{"name":"rev1","state":"idle","limited":true},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo cota
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
orq event entrega --task 1 --rodada 1 --commit abc
printf 'python3 %q --dir %q event veredito --task 1 --rodada 1 --resultado reprova --sessao rev1 >/dev/null\n' \
  "$ORQPY" "$d" > "$t/on-sessions"
vigia
grep -q "^orq: --tmux arb \[vigia\] Account out of quota: rev1=noquota" "$t/sent.log" || fail "sem alarme de cota para rev1"
grep -q "^orq: --tmux arb \[vigia\] Account out of quota: exec1=noquota" "$t/sent.log" || fail "o alarme de cota calou para exec1"

# API muda 5 voltas: o aviso ao árbitro passa pelo orq e fica no registro como alarme.
printf '%s' '[{"name":"exec1","state":"working","last_activity":9999999999},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo api-muda
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
: > "$t/api-down"
CICLOS=5 vigia
grep -q "^orq: --tmux arb \[vigia\] I cannot read /api/sessions" "$t/sent.log" || fail "API muda não passou pelo orq"
if grep -q "^--tmux arb " "$t/sent.log"; then fail "alarme de API muda saiu por fora do orq"; fi
grep -q "alarm: \[vigia\] I cannot read /api/sessions" "$d/registro.md" || fail "alarme de API muda fora do registro"

# Leitor de contexto morto 5 voltas (status_line que não é texto derruba o CTXDET): idem.
printf '%s' '[{"name":"exec1","state":"working","last_activity":9999999999,"status_line":1},{"name":"arb","state":"idle","status_line":1}]' > "$t/sessions.json"
novo ctx-mudo
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
CICLOS=5 vigia
grep -q "^orq: --tmux arb \[vigia\] I cannot read the sessions' context" "$t/sent.log" || fail "contexto mudo não passou pelo orq"
if grep -q "^--tmux arb " "$t/sent.log"; then fail "alarme de contexto mudo saiu por fora do orq"; fi

# Entrega que falhou não conta como alarme dado: volta na volta seguinte e a falha fica no log.
retenta() {  # $1 = trecho do alarme cuja primeira entrega o fake do orq derrubou
  [ "$(grep -c "^orq: --tmux arb \[vigia\] .*$1" "$t/sent.log")" -ge 2 ] || fail "alarme '$1' não voltou depois de falhar"
  grep -q "NOT delivered" "$t/err" || fail "falha de entrega de '$1' não foi pro log"
}
printf '%s' '[{"name":"exec1","state":"idle"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo r-parada; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
echo "1 exec1 is stopped" > "$t/falha"
M=2 vigia
retenta "exec1 is stopped"

printf '%s' '[{"name":"exec1","state":"working","last_activity":9999999999},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo r-laco; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
printf '%s' '[{"kind":"tool_use","tool_input":{"command":"sleep 5"}}]' > "$t/history.json"
echo "1 MAY be looping" > "$t/falha"
REP=1 vigia
retenta "MAY be looping"

# `orq screen take` repetido é a fila da tela, não laço: nem alarme nem aviso à sessão.
novo fila-tela; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
printf '%s' '[{"kind":"tool_use","tool_input":{"command":"python3 ~/.claude/skills/orquestrar/scripts/orq.py --dir /x screen take --owner ex --wait-min 9"}}]' > "$t/history.json"
REP=1 vigia
grep -q "/api/sessions/exec1/history" "$t/urls" || fail "o detector de laço não leu o histórico"
if grep -q "MAY be looping" "$t/sent.log" "$t/out"; then fail "a fila da tela virou alarme de laço"; fi
if grep -q "You repeat the SAME command" "$t/sent.log"; then fail "a fila da tela levou aviso de laço"; fi

# `orq lock take <recurso>` repetido é a mesma fila, agora para qualquer recurso.
novo fila-trava; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
printf '%s' '[{"kind":"tool_use","tool_input":{"command":"python3 ~/.claude/skills/orquestrar/scripts/orq.py --dir /x lock take db --owner ex --wait-min 9"}}]' > "$t/history.json"
REP=1 vigia
grep -q "/api/sessions/exec1/history" "$t/urls" || fail "o detector de laço não leu o histórico (trava)"
if grep -q "MAY be looping" "$t/sent.log" "$t/out"; then fail "a fila da trava virou alarme de laço"; fi
if grep -q "You repeat the SAME command" "$t/sent.log"; then fail "a fila da trava levou aviso de laço"; fi

novo r-trilha; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
touch -d '2 hours ago' "$d/eventos.jsonl" "$d/registro.md"
echo "1 The trail" > "$t/falha"
vigia
retenta "The trail"

printf '%s' '[{"name":"exec1","state":"working","last_activity":1},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo r-travada; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
echo "1 STUCK session" > "$t/falha"
M=5 vigia
retenta "STUCK session"

printf '%s' '[{"name":"exec1","state":"idle","limited":true},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo r-cota; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
echo "1 Account out of quota" > "$t/falha"
M=5 vigia
retenta "Account out of quota"

printf '%s' '[{"name":"exec1","state":"idle"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo r-ninguem; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
echo "1 Nobody has had the ball" > "$t/falha"
M=2 vigia
retenta "Nobody has had the ball"

# Três entregas falhas seguidas: o alarme é largado com um [aviso] no registro, sem 4ª tentativa.
printf '%s' '[{"name":"exec1","state":"idle","limited":true},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo r-teto; orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
echo "9 Account out of quota" > "$t/falha"
M=100 CICLOS=6 vigia
[ "$(grep -c "^orq: --tmux arb \[vigia\] Account out of quota" "$t/sent.log")" -eq 3 ] || fail "o alarme não parou na 3ª tentativa"
[ "$(grep -c "^- [^·]* · aviso: \[aviso\] \[vigia\] alarm dropped after 3 failed deliveries: .*Account out of quota" "$d/registro.md")" -eq 1 ] \
  || fail "o alarme largado não deixou um [aviso] no registro"

# Arrumação: executor e revisor de Task fechada idle fecham depois da janela pela API com
# ?by=<árbitro>; quem trabalha não fecha; --no-housekeeping desliga; falha para em 3 com [aviso].
closes() { grep -c "DELETE http://127.0.0.1:8765/api/sessions/$1?by=arb\$" "$t/urls" || true; }
finished() {  # exec1 fechou a Task 1 e está idle; exec2 fechou a Task 2 e trabalha
  printf '%s' '[{"name":"exec1","state":"idle","jsonl":"'"$t/exec1.jsonl"'"},{"name":"exec2","state":"working","last_activity":9999999999},{"name":"rev1","state":"idle","provider":"pi"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
  novo "$1"
  orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
  orq event task_inicio --task 2 --titulo y --executor exec2 --par rev1
  printf '{"ts":"%s","task":1,"hash":"a"}\n{"ts":"%s","task":2,"hash":"b"}\n' "$(date -Iseconds)" "$(date -Iseconds)" > "$d/closed.jsonl"
  : > "$t/exec1.jsonl"; rm -rf "$t/exec1"
}
# Transcript de exec1 com um lançamento de fundo: $1 = Agent|Bash, $2 = notified|pending.
launch() {
  if [ "$1" = Agent ]; then
    r='Async agent launched successfully.\nagentId: a1 (internal ID)'
    mkdir -p "$t/exec1/subagents"; : > "$t/exec1/subagents/agent-a1.jsonl"
  else
    r='Command running in background with ID: a1'
  fi
  printf '{"type":"user","timestamp":"%s","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"%s"}]}]}}\n' \
    "$(date -u +%FT%TZ)" "$r" > "$t/exec1.jsonl"
  [ "$2" = pending ] || printf '%s\n' '{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>a1</task-id>\n</task-notification>"}' >> "$t/exec1.jsonl"
}
finished fecha
INTERVALO=1 CICLOS=3 CLOSE_IDLE_S=2 vigia
[ "$(closes exec1)" -eq 1 ] || fail "exec1 ociosa não foi fechada exatamente uma vez depois da janela"
[ "$(closes rev1)" -eq 1 ] || fail "rev1 de Tasks fechadas não foi fechada depois da janela"
[ "$(closes exec2)" -eq 0 ] || fail "fechou sessão trabalhando"
if grep -q -- '--close' "$t/sent.log"; then fail "fechou por hangar-send em vez da API"; fi
grep -q "closed session: exec1 (Task 1 closed)" "$d/registro.md" || fail "fechamento sem linha no registro"

finished revisor-outro-grupo
orq event execucao_inicio --plano "$t/orq-plano.md" --branch main --gid g1
printf '%s' '[{"name":"exec1","state":"idle","provider":"pi","pair_gid":"g1"},{"name":"rev1","state":"idle","provider":"pi","pair_gid":"g2"},{"name":"arb","state":"idle","pair_gid":"g1"}]' > "$t/sessions.json"
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes exec1)" -ge 1 ] || fail "não fechou executor do próprio grupo"
[ "$(closes rev1)" -eq 0 ] || fail "fechou revisor movido para outro grupo"
[ "$(grep -c 'aviso: \[aviso\] closure skipped: rev1 is in another group (g2)' "$d/registro.md")" -eq 1 ] || fail "proteção de outro grupo não deixou aviso único"

finished revisor-ainda-ativo
orq event task_inicio --task 3 --titulo z --executor exec3 --par rev1
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes rev1)" -eq 0 ] || fail "fechou revisor que ainda possui Task aberta"

# Subagente de fundo lançado e sem notificação: não fecha. Notificado, fecha. Bash de fundo não
# notificado não segura o fechamento.
finished agente-vivo; launch Agent pending
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes exec1)" -eq 0 ] || fail "fechou sessão com subagente vivo"
if grep -q "close failed: exec1" "$d/registro.md"; then fail "subagente vivo contou como falha"; fi

finished agente-notificado; launch Agent notified
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes exec1)" -ge 1 ] || fail "subagente notificado segurou o fechamento"

finished bash-fundo; launch Bash pending
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes exec1)" -ge 1 ] || fail "Bash de fundo segurou o fechamento"

# Lançamento velho sem notificação (sessão retomada noutro processo): passa como parado.
finished agente-velho; launch Agent pending
touch -d '31 minutes ago' "$t/exec1/subagents/agent-a1.jsonl"
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes exec1)" -ge 1 ] || fail "lançamento de mais de 30 min segurou o fechamento"

# Pi/Kimi/omp não têm jsonl na lista nem tool Agent: fecha como antes, sem falha no registro.
finished pi-sem-jsonl
printf '%s' '[{"name":"exec1","state":"idle","provider":"pi"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
CLOSE_IDLE_S=0 CICLOS=3 vigia
[ "$(closes exec1)" -ge 1 ] || fail "sessão Pi sem jsonl não foi fechada"
if grep -q "close failed: exec1" "$d/registro.md"; then fail "sessão Pi sem jsonl contou como falha"; fi

# Transcript ilegível não fecha: conta como tentativa falha, para em 3 com [aviso].
finished transcript-sumiu; rm -f "$t/exec1.jsonl"
CLOSE_IDLE_S=0 CICLOS=5 vigia
[ "$(closes exec1)" -eq 0 ] || fail "fechou sem conseguir ler o transcript"
grep -q "close failed: exec1: subagents check: .*(1/3)" "$d/registro.md" || fail "falha de leitura do transcript fora do registro"
grep -q "aviso: \[aviso\] vigia gave up after 3 attempts: close failed: exec1: subagents check" "$d/registro.md" || fail "desistência sem [aviso]"

finished sem-arrumacao
CLOSE_IDLE_S=0 vigia --no-housekeeping
if grep -q 'DELETE' "$t/urls"; then fail "--no-housekeeping fechou sessão"; fi

finished fecha-404
: > "$t/close-404"
CLOSE_IDLE_S=0 CICLOS=4 vigia
[ "$(closes exec1)" -eq 1 ] || fail "404 no fechamento foi retentado"
if grep -q "closed session: exec1\|close failed: exec1" "$d/registro.md"; then fail "404 deixou linha no registro"; fi

finished fecha-falha
: > "$t/close-fails"
CLOSE_IDLE_S=0 CICLOS=5 vigia
[ "$(closes exec1)" -eq 3 ] || fail "fechamento falho não parou em 3 tentativas"
if grep -q "closed session: exec1" "$d/registro.md"; then fail "fechamento falho registrado como feito"; fi
grep -q "close failed: exec1: .*error: 500 (1/3)" "$d/registro.md" || fail "falha de fechamento fora do registro"
grep -q "aviso: \[aviso\] vigia gave up after 3 attempts: close failed: exec1" "$d/registro.md" || fail "desistência do fechamento sem [aviso]"

# Grupo: rev1 (revisora de Task aberta) está sem grupo e entra no do árbitro sem acordar os
# veteranos; exec1 já está no grupo; `outro` está em OUTRO grupo e não é fundido.
group() {
  printf '%s' '[{"name":"exec1","state":"working","last_activity":9999999999,"pair_gid":"g1"},{"name":"rev1","state":"idle"},{"name":"outro","state":"working","last_activity":9999999999,"pair_gid":"g2"},{"name":"arb","state":"idle","pair_gid":"g1","pair_task":"Plano X"}]' > "$t/sessions.json"
  novo "$1"
  orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
  orq event task_inicio --task 2 --titulo y --executor outro --par rev1
}
group grupo
vigia
grep -q -- '--data {"peer": "rev1", "task": "Plano X", "orq": true} http://127.0.0.1:8765/api/sessions/arb/pair' "$t/urls" \
  || fail "rev1 não entrou no grupo do árbitro como grupo de orquestração"
if grep -q '"peer": "exec1"\|"peer": "outro"' "$t/urls"; then fail "pareou quem já tinha grupo"; fi
grep -q "joined group: rev1" "$d/registro.md" || fail "entrada no grupo sem linha no registro"
[ "$(grep -c 'aviso: \[aviso\] outro is in another group (g2)' "$d/registro.md")" -eq 1 ] || fail "aviso de outro grupo não saiu uma vez só"

group grupo-desligado
vigia --no-housekeeping
if grep -q '/pair' "$t/urls"; then fail "--no-housekeeping pareou"; fi

group grupo-falha
: > "$t/pair-fails"
CICLOS=5 vigia
[ "$(grep -c '/api/sessions/arb/pair' "$t/urls")" -eq 3 ] || fail "pareamento falho não parou em 3 tentativas"
if grep -q "joined group: rev1" "$d/registro.md"; then fail "pareamento falho registrado como feito"; fi
grep -q "join failed: rev1: .*error: 409 (1/3)" "$d/registro.md" || fail "falha de pareamento fora do registro"
grep -q "aviso: \[aviso\] vigia gave up after 3 attempts: join failed: rev1" "$d/registro.md" || fail "desistência do grupo sem [aviso]"

# Sem `orq init`, todo alarme via orq cairia só no log: o vigia recusa armar.
d="$t/vazio"; mkdir -p "$d"; : > "$t/sent.log"
if PATH="$t/bin:$PATH" CP_ENV="$t/env" CP_VIGIA_INTERVALO=0 CP_VIGIA_CICLOS=1 CP_VIGIA_LOG="$t/err" \
  timeout 10 bash "$raiz/skills/orquestrar/scripts/vigia.sh" arb -e "$d" > "$t/out" 2> "$t/err2"; then
  fail "armou sem orq init"
fi
[ ! -s "$t/sent.log" ] || fail "mandou recado sem orq init"
grep -q "orq.json" "$t/err2" || fail "não disse por que não armou"

# Rearmar o vigia na mesma execução, com o mesmo árbitro: sem segunda prova de canal.
printf '%s' '[{"name":"exec1","state":"idle"},{"name":"rev1","state":"idle"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo rearma
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
vigia
: > "$t/sent.log"
vigia
if grep -q "ARMED" "$t/sent.log"; then fail "rearmou mandando a prova de canal de novo"; fi
grep -q "re-armed" "$t/out" || fail "rearmar sem prova não disse nada"

# Contexto acima do teto com a vez trocando: um alarme só até subir 10 pontos. O árbitro segue
# vigiado enquanto a lista em volta dele muda (exec1 → rev1).
printf '%s' '[{"name":"exec1","state":"working","last_activity":9999999999},{"name":"rev1","state":"idle"},{"name":"arb","state":"idle","status_line":"💬 ctx 600k/1000k"}]' > "$t/sessions.json"
novo ctx-vez
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
printf 'python3 %q --dir %q event entrega --task 1 --rodada 1 --commit abc >/dev/null\n' "$ORQPY" "$d" > "$t/on-sessions"
CICLOS=4 vigia
n=$(grep -c "YOUR context is at 60%" "$t/sent.log" || true)
[ "$n" -eq 1 ] || fail "alarme de contexto repetiu na troca de vez ($n)"
# Execução auto: cada volta solta `orq advance`. A Task fechada é integrada uma vez só; um passo que
# falha grava um advance_falhou e acorda o árbitro uma vez só, por mais voltas que passem.
novo_auto() {  # $1 = cenário, $2 = hash fechado da Task 1 (vazio = HEAD do repositório)
  d="$t/$1"; mkdir -p "$d"
  : > "$t/sent.log"; : > "$t/urls"; : > "$t/err"
  rm -f "$t/falha" "$t/api-down" "$t/history.json" "$t/close-fails" "$t/close-404" "$t/pair-fails"
  ra="$t/repo-$1"; mkdir -p "$ra"; echo 1 > "$ra/a.txt"
  git -C "$ra" init -q -b main
  git -C "$ra" add a.txt
  git -C "$ra" -c user.email=t@t -c user.name=t commit -qm base
  cat > "$t/plano-$1.md" <<'MD'
# Orchestration plan — t

## Projeto
Checagens: —
Integração: `test -f a.txt`
Prova: por-task
Paralelo: sequencial
Revisão: sessão
Correção pelo revisor: até 0 linhas

## Tasks
| # | What it is | Where in their plan | Files | Verification | Wave | Roteiro |
|---|---|---|---|---|---|---|
| 1 | t | §1 | `a.txt` | `true` | 1 | — |
MD
  python3 "$ORQPY" plan-check "$t/plano-$1.md" --repo "$ra" --stamp >/dev/null
  orq init --arbiter arb --repo "$ra" --contract "$t/regras.md" --plan "$t/plano-$1.md" --auto
  orq event execucao_inicio --plano "$t/plano-$1.md" --branch main --gid g1
  orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
  printf '{"ts":"%s","task":1,"hash":"%s"}\n' "$(date -Iseconds)" "${2:-$(git -C "$ra" rev-parse HEAD)}" > "$d/closed.jsonl"
}
espera() {  # $1 = trecho do eventos.jsonl; o advance roda destacado, então até 10 s
  for _ in $(seq 100); do grep -q "$1" "$d/eventos.jsonl" && return 0; sleep 0.1; done
  fail "o advance não gravou '$1'"
}
# jev_config() leria a chave real do runtime-config.json da máquina.
export CLAUDE_CONFIG_DIR="$t/cfg" TYPESAFE_API_KEY=
printf '%s' '[{"name":"exec1","state":"idle"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo_auto auto-integra
INTERVALO=1 CICLOS=3 vigia
espera '"tipo": "integrada"'
sleep 1
[ "$(grep -c '"tipo": "integrada"' "$d/eventos.jsonl")" -eq 1 ] || fail "a Task foi integrada mais de uma vez"

novo_auto auto-falha deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
INTERVALO=1 CICLOS=3 vigia
espera '"tipo": "advance_falhou"'
sleep 1
[ "$(grep -c '"tipo": "advance_falhou"' "$d/eventos.jsonl")" -eq 1 ] || fail "o passo que falhou foi repetido"
[ "$(grep -c '^orq: arb \[painel: orquestrador g1\] \[decisao\] orq advance failed at integrate T1' "$t/sent.log")" -eq 1 ] \
  || fail "a falha não acordou o árbitro exatamente uma vez"

# advance.lock preso = o orquestrador integrando (merge + Integração: passam de um ciclo): alguém
# tem a bola, e "ninguém com a bola" não dispara. Solta a trava, o alarme volta.
printf '%s' '[{"name":"exec1","state":"idle"},{"name":"arb","state":"idle"}]' > "$t/sessions.json"
novo_auto auto-integrando
: > "$d/closed.jsonl"
exec 9>>"$d/advance.lock"
flock -n 9 || fail "não peguei a trava do advance"
M=2 CICLOS=3 vigia
if grep -q "Nobody has had the ball" "$t/sent.log"; then fail "alarmou ninguém-com-a-bola com o advance rodando"; fi
# Trava presa mas intocada há mais de 2×900 s: passada travada, o alarme volta.
touch -d '-2 hours' "$d/advance.lock"
M=2 CICLOS=3 vigia
exec 9>&-
grep -q "Nobody has had the ball" "$t/sent.log" || fail "advance travado segurando a trava calou o alarme"
: > "$t/sent.log"
M=2 CICLOS=3 vigia
grep -q "Nobody has had the ball" "$t/sent.log" || fail "sem a trava o alarme não voltou"

# Sem a marca auto o vigia não solta nada.
novo sem-auto
orq event task_inicio --task 1 --titulo x --executor exec1 --par rev1
printf '{"ts":"%s","task":1,"hash":"%s"}\n' "$(date -Iseconds)" "$(git -C "$raiz" rev-parse HEAD)" > "$d/closed.jsonl"
vigia
sleep 1
[ ! -e "$d/advance.log" ] || fail "o vigia soltou o advance numa execução sem auto"
if grep -q '"tipo": "integrada"' "$d/eventos.jsonl"; then fail "execução sem auto foi integrada"; fi
echo ok
