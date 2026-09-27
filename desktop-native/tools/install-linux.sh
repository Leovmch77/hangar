#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd "$(dirname "$0")" && pwd)
if [[ -f "$source_dir/hangar" && -f "$source_dir/icon.png" ]]; then
    binary="$source_dir/hangar"
    icon="$source_dir/icon.png"
else
    binary="$source_dir/../target/release/hangar-native"
    icon="$source_dir/../assets/brand/icon.png"
fi
[[ -f "$binary" && -f "$icon" ]] || { echo 'binário ou ícone do Hangar não encontrado' >&2; exit 1; }

data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
binary_target="$HOME/.local/bin/hangar-native"
desktop_target="$data_dir/applications/com.hangar.native.desktop"
install -Dm755 "$binary" "$binary_target"
install -Dm644 "$icon" "$data_dir/icons/hicolor/512x512/apps/com.hangar.native.png"
mkdir -p "$(dirname "$desktop_target")"
printf '[Desktop Entry]\nType=Application\nName=Hangar\nExec="%s"\nIcon=com.hangar.native\nTerminal=false\nCategories=Development;\nStartupWMClass=com.hangar.native\n' "$binary_target" > "$desktop_target"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$data_dir/applications"; fi
echo "$desktop_target"
