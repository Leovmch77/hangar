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
# Um icon-theme.cache antigo nessa pasta esconde o ícone novo: o menu mostra o de "não encontrado".
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -f -t "$data_dir/icons/hicolor" >/dev/null 2>&1 || echo 'aviso: o cache de ícones não foi atualizado; o menu pode mostrar o ícone antigo' >&2; fi
mkdir -p "$(dirname "$desktop_target")"
printf '[Desktop Entry]\nType=Application\nName=Hangar\nExec="%s" %%u\nIcon=com.hangar.native\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/hangar;\nStartupWMClass=com.hangar.native\n' "$binary_target" > "$desktop_target"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$data_dir/applications"; fi
# Link hangar:// (convite de sessão compartilhada) abre este app.
# A marca é a prova do passo de atualização: só existe depois do registro dar certo.
scheme_ok=1
if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default com.hangar.native.desktop x-scheme-handler/hangar || { scheme_ok=0; echo 'aviso: não consegui registrar hangar:// com o xdg-mime; o link de convite não abre o app' >&2; }
else
    # Sem xdg-mime o .desktop (com MimeType) é tudo que dá para deixar; a marca sai mesmo assim para o passo não repetir à toa.
    echo 'aviso: xdg-mime ausente; nenhum programa padrão para hangar:// foi definido' >&2
fi
if [[ $scheme_ok = 1 ]]; then mkdir -p "$HOME/.hangar/native" && : > "$HOME/.hangar/native/scheme-hangar"; fi
echo "$desktop_target"
