# hangar — `pi` wrapper (fish). Installed by scripts/install-claude-wrapper.sh.
#
# Faz todo `pi` interativo aberto no terminal nascer como sessão do Hangar, igual às do app.
#
# Regras (as mesmas do pi.posix.sh):
#  - uso não interativo -> cru: (a) o PRIMEIRO argumento é subcomando do pi (install/remove/
#    uninstall/update/list/config/auth; `pi "remove the dead code"` continua prompt); (b) flag que imprime
#    e sai em qualquer posição (-p/--print, --mode, --list-models, --export, --help/-h, --version/-v).
#  - flag que gerencia a própria sessão (--session-id, --resume/-r, --continue/-c, --session,
#    --fork, --no-session) -> cru.
#  - fora do tmux + terminal -> `hangar-open pi …`: o lançador do Hangar abre a sessão e o terminal
#    anexa nela. Argumento que o pedido não cobre, sem hangar-server ou sem hangar-open -> sessão tmux com o nome da pasta.
#  - já no tmux / stdin sem tty -> cru com --session-id e CP_PI_SESSION (o mesmo uuid). O pi
#    reescreve o próprio argv; o backend lê o id em /proc/<pid>/environ (registry.py:_pi_sid_of).
#
# Escape hatch: `command pi ...` runs the raw binary, bypassing this wrapper.
function pi
    # subcomando: só vale como PRIMEIRO argumento (`pi remove x` é subcomando; `pi "remove x"` é prompt).
    if test (count $argv) -gt 0
        switch $argv[1]
            case install remove uninstall update list config auth
                command pi $argv
                return
        end
    end

    # usos não interativos primeiro: o pi imprime e sai, não tem TUI pra abrir como sessão.
    for a in $argv
        switch $a
            case -p --print --mode '--mode=*' --list-models '--list-models=*' --export '--export=*' --help -h --version -v
                command pi $argv
                return
        end
    end

    # Daqui pra baixo abre TUI: refaz a ponte de skills agora, pra skill instalada no Claude valer
    # já nesta abertura (antes dependia de reiniciar o backend). Silencioso e fail-soft.
    command -q hangar-skills-sync; and hangar-skills-sync

    # Flags que gerenciam a própria sessão: CLI cru (um id novo por cima de `pi -c` abriria sessão
    # FRESCA em vez de continuar).
    for a in $argv
        switch $a
            case --session-id '--session-id=*' --resume '--resume=*' -r --continue -c --session '--session=*' --fork '--fork=*' --no-session
                command pi $argv
                return
        end
    end

    # TMUX herdado pode estar MORTO (mesmo caso do wrapper claude). Valida o pane; stale -> limpa.
    if set -q TMUX
        if not set -q TMUX_PANE; or not tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1
            set -e TMUX TMUX_PANE
        end
    end

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar (ver claude.fish).
    if not set -q TMUX; and isatty stdin
        if command -q hangar-open
            hangar-open pi $argv
            set -l rc $status
            test $rc -eq 100; or return $rc
        else
            echo "hangar: hangar-open não encontrado; abrindo o pi sem o Hangar" >&2
        end

        # Sem o tmux o CLI ficaria invisível pro app: sessão com o nome da pasta, única.
        # Acento -> ASCII antes do filtro, mesma regra do backend (app/names.py).
        set -l base (basename "$PWD")
        if command -v iconv >/dev/null 2>&1
            set -l ascii (printf '%s' "$base" | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null)
            test $status -eq 0; and test -n "$ascii"; and set base $ascii
        end
        set base (string replace -ra '[^A-Za-z0-9_-]' '-' -- $base)
        set base (string replace -ra '^-+|-+$' '' -- $base)
        test -n "$base"; or set base session
        set -l name $base
        set -l i 2
        while tmux has-session -t "=$name" 2>/dev/null
            set name "$base-$i"
            set i (math $i + 1)
        end
        set -l id (uuidgen 2>/dev/null)
        test -n "$id"; or set id (cat /proc/sys/kernel/random/uuid 2>/dev/null)
        # CP_PI_SESSION exportado dentro do pane: o servidor tmux não repassa o env de quem chama.
        # Chamada duplicada: variável vazia na posição de comando é erro fatal no fish.
        # CP_SESSION_NAME: identidade da sessão pro hangar-send de dentro do pane.
        if command -q systemd-run; and set -q XDG_RUNTIME_DIR; and systemd-run --user --scope --collect -q -- true >/dev/null 2>&1
            systemd-run --user --scope --collect -q -- tmux new-session -s $name -c "$PWD" -e "CP_SESSION_NAME=$name" \
                sh -c 'export CP_PI_SESSION="$1"; shift; exec pi --session-id "$CP_PI_SESSION" "$@"' _ "$id" $argv
        else
            tmux new-session -s $name -c "$PWD" -e "CP_SESSION_NAME=$name" \
                sh -c 'export CP_PI_SESSION="$1"; shift; exec pi --session-id "$CP_PI_SESSION" "$@"' _ "$id" $argv
        end
        return
    end

    # CLI cru com o id: já no tmux ou stdin sem tty.
    # Substituição que falha deixa a variável como LISTA VAZIA no fish (não como string vazia): sem o
    # fallback — o mesmo do pi.posix.sh — uma máquina sem uuidgen fazia `pi --session-id $id $argv`
    # colapsar pra `pi --session-id <primeiro argumento do usuário>`, comendo o argumento e exportando
    # CP_PI_SESSION vazio. As aspas em "$id" abaixo fecham o resto do buraco.
    set -l id (uuidgen 2>/dev/null)
    test -n "$id"; or set id (cat /proc/sys/kernel/random/uuid 2>/dev/null)
    set -x CP_PI_SESSION $id
    command pi --session-id "$id" $argv
end
