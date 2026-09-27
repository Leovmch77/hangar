#!/usr/bin/env bash
set -euo pipefail

binary=${1:?uso: package-macos.sh <binário> <Hangar.app>}
bundle=${2:?uso: package-macos.sh <binário> <Hangar.app>}
[[ -f "$binary" && ! -e "$bundle" ]] || { echo 'binário ausente ou destino já existe' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
install -m755 "$binary" "$bundle/Contents/MacOS/hangar"
install -m644 "$source_dir/assets/brand/icon.icns" "$bundle/Contents/Resources/Hangar.icns"
install -m644 "$source_dir/assets/brand/Info.plist" "$bundle/Contents/Info.plist"
echo "$bundle"
