# hangar — `pi` wrapper (bash + zsh). Sourced from your rc by
# scripts/install-claude-wrapper.sh. Fish has its own version: scripts/shell/pi.fish
#
# Faz todo `pi` interativo aberto no terminal nascer como sessão do Hangar, igual às do app.
#
# Regras:
#  - uso não interativo -> cru: (a) o PRIMEIRO argumento é subcomando do pi (install/remove/
#    uninstall/update/list/config/auth; `pi "remove the dead code"` continua prompt); (b) flag que imprime
#    e sai em qualquer posição (-p/--print, --mode, --list-models, --export, --help/-h, --version/-v).
#  - flag que gerencia a própria sessão (--session-id, --resume/-r, --continue/-c, --session,
#    --fork, --no-session) -> cru.
#  - fora do tmux + terminal -> `hangar-open pi …`: o lançador do Hangar abre a sessão e o terminal
#    anexa nela. Argumento que o pedido não cobre, ou sem hangar-server -> cru com o id abaixo.
#  - já no tmux / stdin sem tty -> cru com --session-id e CP_PI_SESSION (o mesmo uuid). O pi
#    reescreve o próprio argv; o backend lê o id em /proc/<pid>/environ (registry.py:_pi_sid_of).
#
# Escape hatch: `command pi ...` runs the raw binary, bypassing this wrapper.
pi() {
    local a
    # subcomando: só vale como PRIMEIRO argumento (`pi remove x` é subcomando; `pi "remove x"` é prompt).
    case "${1:-}" in
        install|remove|uninstall|update|list|config|auth)
            command pi "$@"
            return
            ;;
    esac

    # usos não interativos primeiro: o pi imprime e sai, não tem TUI pra abrir como sessão.
    for a in "$@"; do
        case "$a" in
            -p|--print|--mode|--mode=*|--list-models|--list-models=*|--export|--export=*|--help|-h|--version|-v)
                command pi "$@"
                return
                ;;
        esac
    done

    # Daqui pra baixo abre TUI: refaz a ponte de skills agora, pra skill instalada no Claude valer
    # já nesta abertura (antes dependia de reiniciar o backend). Silencioso e fail-soft.
    command -v hangar-skills-sync >/dev/null 2>&1 && hangar-skills-sync

    # Flags que gerenciam a própria sessão: CLI cru (um id novo por cima de `pi -c` abriria sessão
    # FRESCA em vez de continuar).
    for a in "$@"; do
        case "$a" in
            --session-id|--session-id=*|--resume|--resume=*|-r|--continue|-c|--session|--session=*|--fork|--fork=*|--no-session)
                command pi "$@"
                return
                ;;
        esac
    done

    # TMUX herdado pode estar MORTO (mesmo caso do wrapper claude: kitty single-instance cujo mestre
    # nasceu dentro de um pane que já fechou). Valida o pane; stale -> limpa e segue pro caminho
    # "fora do tmux" (abre pelo Hangar).
    if [ -n "${TMUX:-}" ]; then
        if [ -z "${TMUX_PANE:-}" ] || ! tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1; then
            unset TMUX TMUX_PANE
        fi
    fi

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar (ver claude.posix.sh).
    if [ -z "${TMUX:-}" ] && [ -t 0 ]; then
        if command -v hangar-open >/dev/null 2>&1; then
            local rc=0
            hangar-open pi "$@" || rc=$?
            [ "$rc" = 100 ] || return "$rc"
        else
            echo "hangar: hangar-open não encontrado; abrindo o pi sem o Hangar" >&2
        fi
    fi

    # CLI cru com o id: já no tmux, stdin sem tty, ou o Hangar não abriu acima.
    local id
    id=$(uuidgen 2>/dev/null) || id=$(cat /proc/sys/kernel/random/uuid)
    export CP_PI_SESSION="$id"
    command pi --session-id "$id" "$@"
}
