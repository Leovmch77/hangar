#!/usr/bin/env bash
# Instala o app nativo do Hangar (desktop-native) da release `native-latest`, no pacote do sistema e
# do processador desta máquina, conferido pelo sha256 do manifesto antes de tocar em qualquer coisa.
# Máquina sem build na release sai 0 com aviso: a janela continua sendo o Electron.
# Uso: scripts/install-native.sh [--forcar]   (sem --forcar, pula quando a versão instalada já é a da release)
set -euo pipefail
cd "$(dirname "$0")/.."

RELEASE=${HANGAR_NATIVE_UPDATE_URL:-https://github.com/jeffer1312/hangar/releases/download/native-latest}
MARCA_DIR="$HOME/.hangar/native"
MARCA="$MARCA_DIR/release.json"
FORCAR=0; [ "${1:-}" = --forcar ] && FORCAR=1

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PACOTE=Hangar-linux-x86_64.tar.gz; APP="$HOME/.local/bin/hangar-native" ;;
  Darwin-arm64) PACOTE=Hangar-macos-aarch64.zip; APP="$HOME/Applications/Hangar.app" ;;
  *) PACOTE= ;;
esac

marca() { mkdir -p "$MARCA_DIR"; printf '%s\n' "$1" > "$MARCA"; }
# Prova do passo do link hangar://: aqui (sem build, macOS) não há o que registrar, então a marca só diz "passo feito nesta máquina".
marca_esquema() { mkdir -p "$MARCA_DIR"; : > "$MARCA_DIR/scheme-hangar"; }
versao_de() { grep -o '"version": *"[^"]*"' "$1" 2>/dev/null | grep -o '[0-9][0-9.]*' || true; }

# O navegador do painel lateral carrega a WPE WebKit só na hora de abrir: sem ela o app funciona e
# só some a linha "Navegador". Por isso aqui é aviso, nunca parada nem instalação (o update não pede senha).
avisa_wpe() {
  local lib=libWPEWebKit-2.0.so.1 d ids cmd
  case "$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || true)" in *"$lib"*) return 0 ;; esac
  for d in /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/local/lib; do
    if [ -e "$d/$lib" ]; then return 0; fi
  done
  ids=" $(grep -hE '^(ID|ID_LIKE)=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' | tr '\n' ' ' || true) "
  case "$ids" in
    *" arch "*|*" cachyos "*) cmd="sudo pacman -S wpewebkit" ;;
    # O Ubuntu não empacota a WPE WebKit 2.0; sem este caso ele cairia no apt do Debian (ID_LIKE=debian).
    *" ubuntu "*) cmd="a sua distro não empacota a WPE WebKit 2.0; veja https://wpewebkit.org" ;;
    *" debian "*) cmd="sudo apt install libwpewebkit-2.0-1   (Debian 13 ou mais novo)" ;;
    *" fedora "*) cmd="sudo dnf install wpewebkit" ;;
    *) cmd="instale o pacote da WPE WebKit 2.0 (em geral, wpewebkit) pelo gerenciador da sua distro" ;;
  esac
  echo "app nativo: aviso — o navegador do painel lateral precisa da WPE WebKit ($lib), que não foi encontrada."
  echo "  O app funciona sem ela, só sem o Navegador. Para instalar: $cmd"
}

if [ -z "$PACOTE" ]; then
  echo "app nativo: a release não tem build para $(uname -s) $(uname -m); a janela segue sendo o Electron"
  marca '{"sem_build": true}'; marca_esquema
  exit 0
fi
case "$PACOTE" in *linux*) avisa_wpe ;; esac

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
baixa() { curl -fsSL --retry 2 --connect-timeout 15 -o "$2" "$1"; }

baixa "$RELEASE/native-latest.json" "$TMP/manifesto.json" \
  || { echo "app nativo: não consegui ler a release em $RELEASE" >&2; exit 1; }
VERSAO=$(versao_de "$TMP/manifesto.json")
if [ "$FORCAR" = 0 ] && [ -e "$APP" ] && [ -n "$VERSAO" ] && [ "$(versao_de "$MARCA")" = "$VERSAO" ]; then
  echo "app nativo já na versão $VERSAO"
  exit 0
fi
SHA=$(grep -o "\"$PACOTE\": *\"[0-9a-f]\{64\}\"" "$TMP/manifesto.json" | grep -o '[0-9a-f]\{64\}' || true)
[ -n "$SHA" ] || { echo "app nativo: $PACOTE não está no manifesto da release" >&2; exit 1; }
baixa "$RELEASE/$PACOTE" "$TMP/$PACOTE" || { echo "app nativo: download de $PACOTE falhou" >&2; exit 1; }
LIDO=$({ sha256sum "$TMP/$PACOTE" 2>/dev/null || shasum -a 256 "$TMP/$PACOTE"; } | cut -d' ' -f1)
[ "$LIDO" = "$SHA" ] || { echo "app nativo: sha256 de $PACOTE não confere com a release; nada foi instalado" >&2; exit 1; }

case "$PACOTE" in
  *.tar.gz)
    tar -xzf "$TMP/$PACOTE" -C "$TMP"
    "$TMP/install-linux.sh" >/dev/null
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    # Atalho de instalação antiga, com o ícone velho: o dock escolhe qualquer um dos dois pela mesma classe de janela.
    rm -f "$APPS/hangar-native.desktop"
    if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$APPS" 2>/dev/null || true; fi
    ;;
  *.zip)
    mkdir -p "$TMP/app" "$HOME/Applications"
    unzip -q "$TMP/$PACOTE" -d "$TMP/app"
    # O anterior só sai depois que o novo entrou: se o pacote vier sem Hangar.app, o app de antes fica.
    [ -d "$TMP/app/Hangar.app" ] || { echo "app nativo: o pacote não trouxe Hangar.app; nada foi instalado" >&2; exit 1; }
    rm -rf "$APP.old"; [ -e "$APP" ] && mv "$APP" "$APP.old"
    if mv "$TMP/app/Hangar.app" "$APP"; then rm -rf "$APP.old"; else [ -e "$APP.old" ] && mv "$APP.old" "$APP"; exit 1; fi
    marca_esquema
    ;;
esac
# A marca é a prova do passo de atualização: só existe se o app ficou de fato no lugar.
[ -x "$APP" ] || [ -d "$APP" ] || { echo "app nativo: $APP não ficou no lugar; nada foi marcado" >&2; exit 1; }

# Primeira abertura já conectada ao backend desta máquina. Só quando o app ainda não tem conexão:
# a que a pessoa escolheu depois nunca é sobrescrita.
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/hangar-native"
TOKEN=$(grep '^CP_AUTH_TOKEN=' backend/.env 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ ! -f "$CFG/connection.json" ] && [ -n "$TOKEN" ]; then
  PORTA=$(grep '^CP_PORT=' backend/.env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  mkdir -p "$CFG" && chmod 700 "$CFG"
  (umask 077; printf '{"address": "http://127.0.0.1:%s", "token": "%s"}\n' "${PORTA:-8765}" "$TOKEN" > "$CFG/connection.json")
fi

marca "$(cat "$TMP/manifesto.json")"
echo "app nativo $VERSAO instalado em $APP"
