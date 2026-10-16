# hangar — `omp` wrapper (fish). Installed by scripts/install-claude-wrapper.sh.
#
# Mesmo papel do pi.fish, com UMA diferença que muda a forma: o omp NÃO tem `--session-id`.
# Quem escolhe a sessão é o CAMINHO do transcript (`--session <arquivo>`), então o wrapper monta o
# caminho igual ao servidor (`crates/hangar-server/src/session_open/agents.rs`, o pane novo do omp)
# e exporta CP_PI_SESSION com o MESMO uuid do nome do arquivo — é por ele que o backend acha a
# sessão em /proc/<pid>/environ quando o bilhete da extensão ainda não existe (registry:_pi_sid_of).
#
# Regras (as mesmas do omp.posix.sh):
#  - uso não interativo -> cru: (a) o PRIMEIRO argumento é subcomando do omp (`omp models` lista
#    modelos; `omp "models are slow"` continua prompt); (b) flag que imprime e sai (-p/--print,
#    --mode, --alias, --export, --help/-h, --version/-v).
#  - flag que gerencia a própria sessão (--session, --resume/-r, --continue/-c, --no-session,
#    --session-dir) -> cru.
#  - fora do tmux + terminal -> `hangar-open omp …`: o lançador do Hangar abre a sessão (perfil por
#    --profile ou OMP_PROFILE) e o terminal anexa nela. Argumento que o pedido não cobre, ou sem
#    hangar-server -> cru com o caminho abaixo.
#  - já no tmux / stdin não é tty -> cru com o --session + o export.
#
# Escape hatch: `command omp ...` roda o binário cru, sem este wrapper.

# Mesmo caminho que o session_open/agents.rs do servidor monta pro `--session`:
# <raiz>/<slug do cwd>/<ts>_<id>.jsonl. O slug troca só o separador por '-' (acento e espaço passam).
# Perfil pedido na linha (`--profile x` / `--profile=x`) ou já no ambiente (OMP_PROFILE). Vazio = sem perfil.
function hangar_omp_perfil
    set -l esperando 0
    for a in $argv
        if test $esperando -eq 1
            printf '%s' "$a"; return
        end
        switch $a
            case --profile
                set esperando 1
            case '--profile=*'
                printf '%s' (string replace -- '--profile=' '' "$a"); return
        end
    end
    printf '%s' "$OMP_PROFILE"
end

function hangar_omp_alvo --argument-names id
    set -l raiz "$PI_CODING_AGENT_DIR"
    test -n "$raiz"; or set raiz "$HOME/.omp/agent"
    # Com perfil a raiz é a do perfil (o omp ignora PI_CODING_AGENT_DIR ali).
    test -n "$OMP_PROFILE"; and set raiz "$HOME/.omp/profiles/$OMP_PROFILE/agent"
    set -l slug "--"(string replace -r '^[/\\\\]' '' -- "$PWD" | string replace -ra '[/\\\\:]' '-')"--"
    printf '%s/sessions/%s/%s_%s.jsonl' "$raiz" "$slug" (date -u +%Y-%m-%dT%H-%M-%S-000Z) "$id"
end

function omp
    # subcomando: só vale como PRIMEIRO argumento (lista de `omp --help`, seção COMMANDS).
    if test (count $argv) -gt 0
        switch $argv[1]
            case acp agents auth-broker auth-gateway bench browser-relay cleanse commit completions \
                 compress config dry-balance gallery gc git grep grievances if-bench images install \
                 join models plugin ps read render say search setup share shell ssh stats \
                 tiny-models token ttsr update usage worktree
                command omp $argv
                return
        end
    end

    # usos não interativos: o omp imprime e sai, não tem TUI pra envolver em tmux. `--mode` é o
    # caso que mais dói: `--mode rpc`/`rpc-ui`/`json` é um consumidor programático falando por
    # stdio — envolver em tmux e ainda injetar --session quebraria todos eles.
    for a in $argv
        switch $a
            case -p --print --mode '--mode=*' --alias '--alias=*' --export '--export=*' --help -h --version -v
                command omp $argv
                return
        end
    end

    # Daqui pra baixo abre TUI: refaz a ponte de skills agora, pra skill instalada no Claude valer
    # já nesta abertura (antes dependia de reiniciar o backend). Silencioso e fail-soft.
    command -q hangar-skills-sync; and hangar-skills-sync

    # Flags que gerenciam a própria sessão: CLI cru (sobrepor `--session` a um `omp -c` abriria
    # sessão FRESCA em vez de continuar).
    for a in $argv
        switch $a
            case --session '--session=*' --resume '--resume=*' -r --continue -c --no-session --session-dir '--session-dir=*'
                command omp $argv
                return
        end
    end

    # Perfil vai como OMP_PROFILE (o omp honra; é de onde o backend lê o perfil de um pane vivo) e
    # muda a raiz que o hangar_omp_alvo monta.
    set -l perfil (hangar_omp_perfil $argv)
    test -n "$perfil"; and set -gx OMP_PROFILE $perfil

    # TMUX herdado pode estar MORTO (kitty single-instance cujo mestre nasceu num pane já fechado).
    if set -q TMUX
        if not set -q TMUX_PANE; or not tmux list-panes -t "$TMUX_PANE" >/dev/null 2>&1
            set -e TMUX TMUX_PANE
        end
    end

    # Fora do tmux e em terminal: a sessão nasce pelo lançador do Hangar (ver claude.fish).
    if not set -q TMUX; and isatty stdin
        if command -q hangar-open
            hangar-open omp $argv
            set -l rc $status
            test $rc -eq 100; or return $rc
        else
            echo "hangar: hangar-open não encontrado; abrindo o omp sem o Hangar" >&2
        end
    end

    # CLI cru com o caminho: já no tmux, stdin sem tty, ou o Hangar não abriu acima. Substituição que
    # falha deixa a variável como LISTA VAZIA no fish: sem o fallback o nome do transcript nasceria
    # sem uuid, e o backend nunca acharia o arquivo pelo glob `*_<uuid>.jsonl`.
    set -l id (uuidgen 2>/dev/null)
    test -n "$id"; or set id (cat /proc/sys/kernel/random/uuid 2>/dev/null)
    set -x CP_PI_SESSION $id
    command omp --session (hangar_omp_alvo "$id") $argv
end
