# hangar — `omp` wrapper (bash + zsh). Sourced from your rc by
# scripts/install-claude-wrapper.sh. Fish has its own version: scripts/shell/omp.fish
#
# Mesmo papel do pi.posix.sh, com UMA diferença que muda a forma: o omp NÃO tem `--session-id`.
# Quem escolhe a sessão é o CAMINHO do transcript (`--session <arquivo>`), então o wrapper monta o
# caminho igual ao servidor (`crates/hangar-server/src/session_open/agents.rs`, o pane novo do omp)
# e exporta CP_PI_SESSION com o MESMO uuid do nome do arquivo — é por ele que o backend acha a
# sessão em /proc/<pid>/environ quando o bilhete da extensão ainda não existe (registry:_pi_sid_of).
#
# Regras (idênticas às do pi):
#  - uso não interativo -> cru: (a) o PRIMEIRO argumento é subcomando do omp (`omp models` lista
#    modelos; `omp "models are slow"` continua prompt); (b) flag que imprime e sai (-p/--print,
#    --mode, --alias, --export, --help/-h, --version/-v).
#  - flag que gerencia a própria sessão (--session, --resume/-r, --continue/-c, --no-session,
#    --session-dir) -> cru.
#  - fora do tmux + terminal -> `hangar-open omp …`: o lançador do Hangar abre a sessão (perfil por
#    --profile ou OMP_PROFILE) e o terminal anexa nela. Argumento que o pedido não cobre, ou sem
#    hangar-server, ou sem hangar-open -> sessão tmux com o nome da pasta.
#  - já no tmux / stdin não é tty -> cru com o --session + o export.
#
# Escape hatch: `command omp ...` roda o binário cru, sem este wrapper.

# Mesmo caminho que o session_open/agents.rs do servidor monta pro `--session`:
# <raiz>/<slug do cwd>/<ts>_<id>.jsonl. O slug troca só o separador por '-' (acento e espaço passam).
# Perfil pedido na linha (`--profile x` / `--profile=x`) ou já no ambiente (OMP_PROFILE). Vazio = sem perfil.
hangar_omp_perfil() {
    local a
    while [ $# -gt 0 ]; do
        a=$1; shift
        case "$a" in
            --profile) printf '%s' "${1:-}"; return ;;
            --profile=*) printf '%s' "${a#--profile=}"; return ;;
        esac
    done
    printf '%s' "${OMP_PROFILE:-}"
}

hangar_omp_alvo() {  # $1 = uuid; com perfil a raiz é a do perfil (o omp ignora PI_CODING_AGENT_DIR ali)
    local raiz="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/sessions"
    [ -n "${OMP_PROFILE:-}" ] && raiz="$HOME/.omp/profiles/$OMP_PROFILE/agent/sessions"
    local slug="--$(printf '%s' "$PWD" | sed -e 's#^[/\\]##' -e 's#[/\\:]#-#g')--"
    printf '%s/%s/%s_%s.jsonl' "$raiz" "$slug" "$(date -u +%Y-%m-%dT%H-%M-%S-000Z)" "$1"
}

omp() {
    local a
    # subcomando: só vale como PRIMEIRO argumento (lista de `omp --help`, seção COMMANDS).
    case "${1:-}" in
        acp|agents|auth-broker|auth-gateway|bench|browser-relay|cleanse|commit|completions|compress|\
config|dry-balance|gallery|gc|git|grep|grievances|if-bench|images|install|join|models|plugin|ps|\
read|render|say|search|setup|share|shell|ssh|stats|tiny-models|token|ttsr|update|usage|worktree)
            command omp "$@"
            return
            ;;
    esac

    # usos não interativos: o omp imprime e sai, não tem TUI pra envolver em tmux. `--mode` é o
    # caso que mais dói: `--mode rpc`/`rpc-ui`/`json` é um consumidor programático falando por
    # stdio — envolver em tmux e ainda injetar --session quebraria todos eles.
    for a in "$@"; do
        case "$a" in
            -p|--print|--mode|--mode=*|--alias|--alias=*|--export|--export=*|--help|-h|--version|-v)
                command omp "$@"
                return
                ;;
        esac
    done

    # Daqui pra baixo abre TUI: refaz a ponte de skills agora, pra skill instalada no Claude valer
    # já nesta abertura (antes dependia de reiniciar o backend). Silencioso e fail-soft.
    command -v hangar-skills-sync >/dev/null 2>&1 && hangar-skills-sync

    # Flags que gerenciam a própria sessão: CLI cru (sobrepor `--session` a um `omp -c` abriria
    # sessão FRESCA em vez de continuar).
    for a in "$@"; do
        case "$a" in
            --session|--session=*|--resume|--resume=*|-r|--continue|-c|--no-session|--session-dir|--session-dir=*)
                command omp "$@"
                return
                ;;
        esac
    done

    # Perfil vai como OMP_PROFILE (o omp honra; é de onde o backend lê o perfil de um pane vivo) e
    # muda a raiz que o hangar_omp_alvo monta.
    local perfil
    perfil=$(hangar_omp_perfil "$@")
    [ -n "$perfil" ] && export OMP_PROFILE="$perfil"

    # TMUX herdado pode estar MORTO (kitty single-instance cujo mestre nasceu num pane já fechado).
    # Valida o pane; stale -> limpa e segue pro caminho "fora do tmux".
    if [ -n "${TMUX:-}" ]; then
        if [ -z "${TMUX_PANE:-}" ] || ! tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1; then
            unset TMUX TMUX_PANE
        fi
    fi

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar (ver claude.posix.sh).
    if [ -z "${TMUX:-}" ] && [ -t 0 ]; then
        if command -v hangar-open >/dev/null 2>&1; then
            local rc=0
            hangar-open omp "$@" || rc=$?
            [ "$rc" = 100 ] || return "$rc"
        else
            echo "hangar: hangar-open não encontrado; abrindo o omp sem o Hangar" >&2
        fi

        # Sem o tmux o CLI ficaria invisível pro app: sessão com o nome da pasta, única.
        # Acento -> ASCII antes do filtro, mesma regra do backend (app/names.py).
        local base name i ascii run=()
        base=$(basename "$PWD")
        if command -v iconv >/dev/null 2>&1; then
            ascii=$(printf '%s' "$base" | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null) \
                && [ -n "$ascii" ] && base=$ascii
        fi
        base=$(printf '%s' "$base" | tr -c 'A-Za-z0-9_-' '-')
        while [ "${base#-}" != "$base" ]; do base=${base#-}; done
        while [ "${base%-}" != "$base" ]; do base=${base%-}; done
        [ -n "$base" ] || base=session
        name=$base; i=2
        while tmux has-session -t "=$name" 2>/dev/null; do
            name="$base-$i"; i=$((i + 1))
        done
        # O probe confere que o systemd do usuário aceita scope transiente, não só que o binário existe.
        if command -v systemd-run >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ] \
           && systemd-run --user --scope --collect -q -- true >/dev/null 2>&1; then
            run=(systemd-run --user --scope --collect -q --)
        fi
        local id envp=()
        id=$(uuidgen 2>/dev/null) || id=$(cat /proc/sys/kernel/random/uuid)
        # O pane nasce do servidor tmux, não deste shell: perfil por `-e`, CP_PI_SESSION por export
        # dentro do pane. CP_SESSION_NAME: identidade da sessão pro hangar-send de dentro do pane.
        [ -n "$perfil" ] && envp=(-e "OMP_PROFILE=$perfil")
        "${run[@]}" tmux new-session -s "$name" -c "$PWD" -e "CP_SESSION_NAME=$name" "${envp[@]}" \
            sh -c 'export CP_PI_SESSION="$1"; alvo="$2"; shift 2; exec omp --session "$alvo" "$@"' \
            _ "$id" "$(hangar_omp_alvo "$id")" "$@"
        return
    fi

    # CLI cru com o caminho: já no tmux ou stdin sem tty.
    local id
    id=$(uuidgen 2>/dev/null) || id=$(cat /proc/sys/kernel/random/uuid)
    export CP_PI_SESSION="$id"
    command omp --session "$(hangar_omp_alvo "$id")" "$@"
}
