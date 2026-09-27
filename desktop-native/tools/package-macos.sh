#!/usr/bin/env bash
set -euo pipefail

binary=${1:?uso: package-macos.sh <binário> <Hangar.app>}
bundle=${2:?uso: package-macos.sh <binário> <Hangar.app>}
[[ -f "$binary" && ! -e "$bundle" ]] || { echo 'binário ausente ou destino já existe' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")/.." && pwd)
version=$(tr -d '[:space:]' < "$source_dir/../VERSION")
build=$(git -C "$source_dir" rev-list --count HEAD)
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$build" =~ ^[0-9]+$ ]] || {
    echo 'versão do pacote macOS inválida' >&2
    exit 1
}
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
install -m755 "$binary" "$bundle/Contents/MacOS/hangar"
install -m644 "$source_dir/assets/brand/icon.icns" "$bundle/Contents/Resources/Hangar.icns"
sed -e "s/__SHORT_VERSION__/$version/" -e "s/__BUILD_NUMBER__/$build/" \
    "$source_dir/assets/brand/Info.plist" > "$bundle/Contents/Info.plist"
echo "$bundle"
