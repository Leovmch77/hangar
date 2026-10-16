# hangar — `claude` wrapper (bash + zsh). Sourced from your rc by
# scripts/install-claude-wrapper.sh. Fish has its own version: scripts/shell/claude.fish
#
# Faz todo `claude` interativo aberto no terminal nascer como sessão do Hangar, igual às do app.
#
# Regras:
#  - --session-id/--resume/-c/--continue -> CLI cru, sem id novo (o CLI recusa --session-id junto).
#  - já no tmux ($TMUX) / -p / --print / stdin sem tty -> CLI cru com --session-id injetado.
#  - fora do tmux + terminal -> `hangar-open claude …`: o lançador do Hangar (`hangar-server open`)
#    abre a sessão (nome, conta, motor, plugin, hooks) e o terminal anexa nela. Argumento que o
#    pedido não cobre, ou sem hangar-server -> CLI cru com o id. Recusa do Hangar -> erro, sem
#    segunda abertura.
#
# Escape hatch: `command claude ...` runs the raw binary, bypassing this wrapper.
claude() {
    # Motor de modelo (CP_ENGINE, setado por claude-engine): env aplicado DENTRO do pane por
    # `hangar-engine --exec`, não por `tmux -e` — tmux não herda o env do caller, e `-e TOKEN=…` deixaria
    # a key em /proc/<pid>/cmdline, legível por qualquer usuário. Array em vez de string para não
    # depender de word-splitting (zsh não faz em variável não-quotada). Construído ANTES do scan de
    # flags abaixo porque -c/--resume/--session-id saem por um early return e também precisam do
    # prefixo — senão o motor é silenciosamente ignorado e a sessão sobe na conta Anthropic.
    local -a pre
    pre=()
    if [ -n "${CP_ENGINE:-}" ]; then
        pre=(hangar-engine --exec "$CP_ENGINE" --)
    fi

    local a
    local print=0
    for a in "$@"; do case "$a" in -p|--print) print=1 ;; esac; done

    # Plugins do Hangar por `--plugin-dir`, igual às sessões que o backend abre: só assim ficam por
    # fora dos plugins do marketplace e o do Hangar espelha no app a faixa que os mods desenham. Os
    # caminhos vêm do arquivo que o backend grava, um por linha e o do Hangar primeiro (este wrapper
    # não sabe onde o repositório mora); o backend só o grava quando o `claude` aceita a flag. Modo
    # -p não tem faixa e segue como estava.
    local -a plug
    plug=()
    local plugdir=
    if [ "$print" = 0 ] && [ -r "$HOME/.hangar/plugin-dir" ]; then
        # O `|| [ -n ]` pega a última linha sem quebra no fim.
        while IFS= read -r plugdir || [ -n "$plugdir" ]; do
            if [ -n "$plugdir" ] && [ -d "$plugdir" ]; then
                plug+=(--plugin-dir "$plugdir")
            elif [ -n "$plugdir" ]; then
                echo "hangar: plugin-dir '$plugdir' não existe; a faixa dos mods não vai para o app" >&2
            fi
        done <"$HOME/.hangar/plugin-dir"
    fi

    # respect flags that manage their own session (injecting --session-id alongside them errors)
    for a in "$@"; do
        case "$a" in
            --session-id|--session-id=*|--resume|--resume=*|-c|--continue)
                # mesmo bypass de `command` do caminho "só injeta o id" abaixo: sem motor, chama o
                # binário direto (evita recursão na função); com motor, quem executa é o hangar-engine
                # (processo à parte achado no PATH) — `command` não existiria pra ele executar.
                if [ ${#pre[@]} -eq 0 ]; then
                    command claude "${plug[@]}" "$@"
                else
                    "${pre[@]}" claude "${plug[@]}" "$@"
                fi
                return
                ;;
        esac
    done

    local id
    id=$(uuidgen 2>/dev/null) || id=$(cat /proc/sys/kernel/random/uuid)

    # TMUX herdado pode estar MORTO (ex: kitty single-instance cujo mestre nasceu dentro de um pane
    # que já fechou). Valida o pane; stale -> limpa e segue pro caminho "fora do tmux" (abre pelo Hangar).
    if [ -n "${TMUX:-}" ]; then
        # list-panes -t <pane>: exit 1 se o pane não existe (display-message devolve 0 até pra pane morto).
        if [ -z "${TMUX_PANE:-}" ] || ! tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1; then
            unset TMUX TMUX_PANE
        fi
    fi

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar, igual às do app. Saída 100
    # do hangar-open = argumento que o pedido não cobre ou sem hangar-server -> CLI cru abaixo.
    if [ -z "${TMUX:-}" ] && [ "$print" = 0 ] && [ -t 0 ]; then
        if command -v hangar-open >/dev/null 2>&1; then
            local rc=0
            hangar-open claude "$@" || rc=$?
            [ "$rc" = 100 ] || return "$rc"
        else
            echo "hangar: hangar-open não encontrado; abrindo o claude sem o Hangar" >&2
        fi
    fi

    # CLI cru com o id: já no tmux, -p, stdin sem tty, ou o Hangar não abriu acima.
    # `command` só faz sentido quando o QUEM roda é este próprio shell: bypassa a função `claude`
    # para não recursar nela mesma. Com $pre setado, quem executa é o hangar-engine (um processo
    # separado, achado no PATH) — o execvpe dele nunca vê função de shell, então "command" viraria
    # só uma string a mais no argv (e um alvo inexistente pro execvpe procurar).
    if [ ${#pre[@]} -eq 0 ]; then
        COLORTERM=truecolor CLAUDE_CODE_TMUX_TRUECOLOR=1 command claude --session-id "$id" "${plug[@]}" "$@"
    else
        COLORTERM=truecolor CLAUDE_CODE_TMUX_TRUECOLOR=1 "${pre[@]}" claude --session-id "$id" "${plug[@]}" "$@"
    fi
}
