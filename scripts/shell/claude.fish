# hangar — `claude` wrapper (fish). Installed by scripts/install-claude-wrapper.sh.
#
# Faz todo `claude` interativo aberto no terminal nascer como sessão do Hangar, igual às do app.
#
# Regras (as mesmas do claude.posix.sh):
#  - --session-id/--resume/-c/--continue -> CLI cru, sem id novo (o CLI recusa --session-id junto).
#  - já no tmux ($TMUX) / -p / --print / stdin sem tty -> CLI cru com --session-id injetado.
#  - fora do tmux + terminal -> `hangar-open claude …`: o lançador do Hangar (`hangar-server open`)
#    abre a sessão (nome, conta, motor, plugin, hooks) e o terminal anexa nela. Argumento que o
#    pedido não cobre, ou sem hangar-server -> CLI cru com o id. Recusa do Hangar -> erro, sem
#    segunda abertura.
#
# Escape hatch: `command claude ...` runs the raw binary, bypassing this wrapper.
function claude
    # Motor de modelo (claude-engine setou CP_ENGINE): o env é aplicado DENTRO do pane pelo
    # `hangar-engine --exec`, não por `tmux -e`. Dois motivos: (1) tmux não herda o env de quem chama, e
    # (2) `-e ANTHROPIC_AUTH_TOKEN=…` deixaria a key visível em /proc/<pid>/cmdline para qualquer
    # usuário da máquina. Depois do exec, o cmdline é o do claude — sem segredo. Construído ANTES do
    # scan de flags abaixo porque -c/--resume/--session-id saem por um early return e também
    # precisam do prefixo — senão o motor é silenciosamente ignorado e a sessão sobe na conta
    # Anthropic.
    set -l pre
    if set -q CP_ENGINE; and test -n "$CP_ENGINE"
        set pre hangar-engine --exec $CP_ENGINE --
    end

    # Plugins do Hangar por `--plugin-dir`, igual às sessões que o backend abre: só assim ficam por
    # fora dos plugins do marketplace e o do Hangar espelha no app a faixa que os mods desenham. Os
    # caminhos vêm do arquivo que o backend grava, um por linha e o do Hangar primeiro (este wrapper
    # não sabe onde o repositório mora); o backend só o grava quando o `claude` aceita a flag. Modo
    # -p não tem faixa e segue como estava.
    set -l plug
    if not contains -- -p $argv; and not contains -- --print $argv; and test -r "$HOME/.hangar/plugin-dir"
        while read -l plugdir
            if test -n "$plugdir"; and test -d "$plugdir"
                set -a plug --plugin-dir $plugdir
            else if test -n "$plugdir"
                echo "hangar: plugin-dir '$plugdir' não existe; a faixa dos mods não vai para o app" >&2
            end
        end <"$HOME/.hangar/plugin-dir"
    end

    for a in $argv
        switch $a
            case --session-id '--session-id=*' --resume '--resume=*' -c --continue
                # mesmo bypass de `command` do caminho "só injeta o id" abaixo: sem motor, chama o
                # binário direto (evita recursão na função); com motor, quem executa é o hangar-engine
                # (processo à parte achado no PATH) — `command` não existiria pra ele executar.
                if test (count $pre) -eq 0
                    command claude $plug $argv
                else
                    $pre claude $plug $argv
                end
                return
        end
    end

    set -l id (uuidgen)

    # TMUX herdado pode estar MORTO (ex: kitty single-instance cujo mestre nasceu dentro de um pane
    # que já fechou -> todo terminal novo herda TMUX/TMUX_PANE stale). Sem esta guarda, o wrapper
    # achava que "já está em tmux", só injetava o id e o claude abria CRU (invisível no app).
    if set -q TMUX
        # list-panes -t <pane>: exit 1 se o pane não existe (display-message devolve 0 até pra pane morto).
        if not set -q TMUX_PANE; or not tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1
            set -e TMUX TMUX_PANE
        end
    end

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar, igual às do app. Saída 100
    # do hangar-open = argumento que o pedido não cobre ou sem hangar-server -> CLI cru abaixo.
    if not set -q TMUX; and not contains -- -p $argv; and not contains -- --print $argv; and isatty stdin
        if command -q hangar-open
            hangar-open claude $argv
            set -l rc $status
            test $rc -eq 100; or return $rc
        else
            echo "hangar: hangar-open não encontrado; abrindo o claude sem o Hangar" >&2
        end
    end

    # CLI cru com o id: já no tmux, -p, stdin sem tty, ou o Hangar não abriu acima.
    # `command` só faz sentido quando o QUEM roda é este próprio shell: bypassa a função `claude`
    # para não recursar nela mesma. Com $pre setado, quem executa é o hangar-engine (um processo
    # separado, achado no PATH) — o execvpe dele nunca vê função de shell, então "command" viraria
    # só uma string a mais no argv (e um alvo inexistente pro execvpe procurar).
    if test (count $pre) -eq 0
        COLORTERM=truecolor CLAUDE_CODE_TMUX_TRUECOLOR=1 command claude --session-id $id $plug $argv
    else
        COLORTERM=truecolor CLAUDE_CODE_TMUX_TRUECOLOR=1 $pre claude --session-id $id $plug $argv
    end
end
