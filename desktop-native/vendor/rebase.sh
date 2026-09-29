#!/usr/bin/env bash
# Reaplica os ajustes do Hangar numa versão nova de um crate vendorizado, e exporta os ajustes como patch.
#
#   vendor/rebase.sh bump <crate> <versão-atual> <versão-nova>
#       baixa as duas versões originais do crates.io, cria vendor/<crate>-<nova> a partir da original nova e funde
#       cada ajuste nosso por 3 vias (original atual → nossa cópia → original nova). Arquivo que o upstream não tocou
#       entra limpo; onde os dois mexeram ficam marcadores <<<<<<< upstream / >>>>>>> ours para resolver à mão.
#       Não apaga a cópia atual nem mexe no Cargo.toml.
#   vendor/rebase.sh export [<crate>-<versão> ...]
#       regrava vendor/patches/<crate>-<versão>.patch = diff da original do crates.io para a nossa cópia.
#       Sem argumento, exporta todas as cópias de vendor/. Rodar depois de qualquer mudança num crate vendorizado.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cache=${REBASE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/hangar-vendor}
mkdir -p "$cache" "$here/patches"

pristine() { # <crate> <versão> → imprime o diretório da original extraída
    local dir="$cache/$1-$2"
    if [ ! -d "$dir" ]; then
        curl -fsSL "https://crates.io/api/v1/crates/$1/$2/download" | tar -xz -C "$cache"
    fi
    printf '%s\n' "$dir"
}

# Ruído de empacotamento do crates.io, fora dos ajustes.
noise() { case "$1" in .cargo_vcs_info.json|.cargo-ok|Cargo.lock|Cargo.toml.orig) return 0;; esac; return 1; }

export_one() { # <crate>-<versão>
    local copy=$1 crate=${1%-*} version=${1##*-} orig out
    orig=$(pristine "$crate" "$version")
    out="$here/patches/$copy.patch"
    # Sem data nos cabeçalhos: o patch só muda quando o ajuste muda.
    (cd "$cache" && diff -ruN -x .cargo_vcs_info.json -x .cargo-ok -x Cargo.lock -x Cargo.toml.orig \
        "$copy" "$here/$copy" | sed -E "s#$here/##g; s/^((---|\+\+\+) [^\t]+)\t.*/\1/") > "$out" || true
    echo "$out: $(grep -c '^+++ ' "$out") arquivos"
}

bump() { # <crate> <atual> <nova>
    local crate=$1 old=$2 new=$3 ours="$here/$1-$2" dest="$here/$1-$3" o n conflicts=0
    [ -d "$ours" ] || { echo "sem cópia em $ours" >&2; exit 1; }
    [ -e "$dest" ] && { echo "$dest já existe" >&2; exit 1; }
    o=$(pristine "$crate" "$old"); n=$(pristine "$crate" "$new")
    cp -a "$n" "$dest"
    (cd "$ours" && find . -type f -printf '%P\n') | while read -r rel; do
        noise "$(basename "$rel")" && continue
        if [ ! -e "$o/$rel" ]; then
            mkdir -p "$(dirname "$dest/$rel")"; cp "$ours/$rel" "$dest/$rel"; echo "nosso      $rel"
        elif ! cmp -s "$o/$rel" "$ours/$rel"; then
            if [ ! -e "$n/$rel" ]; then echo "SUMIU      $rel (o upstream removeu; portar à mão)"; continue; fi
            if git merge-file -L upstream -L "orig-$old" -L ours "$dest/$rel" "$o/$rel" "$ours/$rel"; then
                echo "limpo      $rel"
            else
                echo "CONFLITO   $rel"
            fi
        fi
    done
    echo "Resolva os CONFLITO, confira os limpos contra o que o upstream mudou, depois: $0 export $crate-$new"
}

case "${1:-}" in
    bump) shift; bump "$@" ;;
    export) shift
        if [ $# -eq 0 ]; then set -- $(cd "$here" && ls -d */ | tr -d / | grep -v '^patches$'); fi
        for copy in "$@"; do export_one "$copy"; done ;;
    *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
