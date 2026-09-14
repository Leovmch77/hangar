#!/usr/bin/env bash
# Mudança que a máquina de quem já usa não recebe por `git pull` precisa de um passo declarado em
# docs/atualizacoes/ — no MESMO commit. O botão Atualizar não roda mais o instalador inteiro; o
# que roda é o que o passo pedir. Sem o passo, wrapper/tarefa/statusline ficam velhos até alguém
# lembrar, e ninguém lembra.
#
# Uso:  check-passo-de-atualizacao.sh --staged          (pre-commit: o que está em stage)
#       check-passo-de-atualizacao.sh <de>..<para>       (CI: o intervalo do push)
# Saída 0 = ok (ou nada relevante mudou); 1 = mudou algo relevante sem passo novo.
# Escape deliberado, pra mudança que comprovadamente não muda nada na máquina (comentário, teste):
#       HANGAR_SEM_PASSO=1 git commit ...
set -uo pipefail

if [[ -n "${HANGAR_SEM_PASSO:-}" ]]; then
    echo "passo de atualização: pulado por HANGAR_SEM_PASSO=1" >&2
    exit 0
fi

case "${1:-}" in
    --staged) arquivos="$(git diff --cached --name-only --diff-filter=ACMR)" ;;
    *..*)     arquivos="$(git diff --name-only --diff-filter=ACMR "$1")" ;;
    *) echo "uso: $0 --staged | <de>..<para>" >&2; exit 2 ;;
esac
[[ -z "$arquivos" ]] && exit 0

# O que muda a MÁQUINA, não o código que o backend serve. Testes e o próprio hook ficam de fora:
# os hooks entram pelo core.hooksPath (mudança vale no próprio checkout, sem instalar nada).
relevantes="$(printf '%s\n' "$arquivos" | grep -E \
    '^(install\.(sh|ps1)|scripts/[^/]+\.(sh|ps1|py|mjs|cjs|js|fish)|hooks/.*|backend/app/[a-z_]*installer\.py|backend/app/hook_installer\.py)$' \
    | grep -Ev '^scripts/(hooks/|test-|check-passo-de-atualizacao\.sh)' \
    | grep -Ev '\.test\.(mjs|cjs|js)$' || true)"
[[ -z "$relevantes" ]] && exit 0

passos="$(printf '%s\n' "$arquivos" | grep -E '^docs/atualizacoes/[^/]+\.md$' | grep -v 'README\.md$' || true)"
[[ -n "$passos" ]] && exit 0

cat >&2 <<FIM
  ── falta o passo de atualização ───────────────────────────────────────────
  Este commit muda o que a máquina de quem já usa NÃO recebe por git pull:
$(printf '%s\n' "$relevantes" | sed 's/^/      /')
  O botão Atualizar só roda o que um passo declarado pedir. Crie, no mesmo
  commit, um arquivo docs/atualizacoes/AAAA-MM-DD-<o-que-muda>.md com o
  comando cirúrgico e a prova (modelo e lista de comandos no README de lá).
  Mudança que não altera nada na máquina (comentário, teste):
      HANGAR_SEM_PASSO=1 git commit ...
FIM
exit 1
