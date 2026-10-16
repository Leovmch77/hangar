# hangar — `kimi` wrapper (fish). Installed by scripts/install-claude-wrapper.sh.
#
# Makes every interactive `kimi` opened in a terminal a Hangar session, same as the app opens.
# SIMPLER than the pi wrapper on purpose: the Kimi CLI has no
# `--session-id` flag (the session id is born inside, at the first prompt), so there is no id to
# inject and no env var to export. The pane<->session link is the ticket the backend's kimi hook
# writes (it inherits TMUX_PANE from the pane) — see backend/hooks/kimi_state_hook.py.
#
# Rules (same as the posix version):
#  - subcommand as the FIRST argument -> raw (export/provider/acp/web/server/login/doctor/vis/
#    migrate/upgrade/update). Matched on $1 only, so `kimi "export the function"` stays an
#    interactive launch with an initial prompt. Same rule as the pi/codex wrappers.
#  - a flag that makes kimi print and exit anywhere in the args -> raw: -p/--prompt,
#    --output-format, --help/-h, --version/-V. Wrapping these would open a TUI that never prints.
#  - resume flags (-S/--session, -c/--continue) -> raw.
#  - outside tmux + terminal -> `hangar-open kimi …`: the Hangar launcher opens the session and
#    the terminal attaches to it. An argument the request doesn't cover, or no hangar-server -> raw.
#  - already in tmux ($TMUX) / stdin not a tty (pipe/script) -> raw: the hook ticket links the pane.
#
# Escape hatch: `command kimi ...` runs the raw binary, bypassing this wrapper.
function kimi
    # subcomando: só vale como PRIMEIRO argumento.
    if test (count $argv) -gt 0
        switch $argv[1]
            case export provider acp web server login doctor vis migrate upgrade update
                command kimi $argv
                return
        end
    end

    # usos não interativos primeiro: o kimi imprime e sai, não tem TUI pra envolver em tmux.
    for a in $argv
        switch $a
            case -p --prompt '--prompt=*' --output-format '--output-format=*' --help -h --version -V
                command kimi $argv
                return
        end
    end

    # Daqui pra baixo abre TUI: refaz a ponte de skills agora, pra skill instalada no Claude valer
    # já nesta abertura (antes dependia de reiniciar o backend). Silencioso e fail-soft.
    command -q hangar-skills-sync; and hangar-skills-sync

    # Retomada (-S/--session, -c/--continue): CLI cru.
    for a in $argv
        switch $a
            case -S --session '--session=*' -c --continue
                command kimi $argv
                return
        end
    end

    # TMUX herdado pode estar MORTO (mesmo caso dos outros wrappers). Valida o pane; stale -> limpa.
    if set -q TMUX
        if not set -q TMUX_PANE; or not tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1
            set -e TMUX TMUX_PANE
        end
    end

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar (ver claude.fish).
    if not set -q TMUX; and isatty stdin
        if command -q hangar-open
            hangar-open kimi $argv
            set -l rc $status
            test $rc -eq 100; or return $rc
        else
            echo "hangar: hangar-open não encontrado; abrindo o kimi sem o Hangar" >&2
        end
    end

    # já no tmux, stdin sem tty, ou o Hangar não abriu acima: nada a injetar (o bilhete do hook liga
    # pane->sessão).
    command kimi $argv
end
