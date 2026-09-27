#!/usr/bin/env bash
# Build release do hangar-native com LTO completo e uma unidade de código.
# O perfil vai por variável de ambiente, não no Cargo.toml: o build release comum
# continua rápido para as faixas, e só o binário do usuário paga o link longo.
# Uso: CARGO_TARGET_DIR=<target próprio> tools/build-otimizado.sh <destino-do-binario>
# O target deve ser exclusivo deste perfil: dividir com o release comum recompila tudo a cada troca.
set -euo pipefail

destino=${1:?uso: CARGO_TARGET_DIR=<dir> $0 <destino-do-binario>}
: "${CARGO_TARGET_DIR:?defina CARGO_TARGET_DIR (target exclusivo deste perfil)}"
# Relativos valem a partir de onde o script foi chamado, não de desktop-native/.
destino=$(realpath -m -- "$destino")
export CARGO_TARGET_DIR=$(realpath -m -- "$CARGO_TARGET_DIR")
[[ -d $(dirname "$destino") ]] || { echo "pasta de $destino não existe" >&2; exit 1; }

cd "$(dirname "$0")/.."
CARGO_PROFILE_RELEASE_LTO=fat CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
	cargo build --locked --release

# Cópia + rename: sobrescrever o binário em uso dá "Text file busy".
install -m 755 "$CARGO_TARGET_DIR/release/hangar-native" "$destino.novo"
mv -f "$destino.novo" "$destino"
echo "$destino"
