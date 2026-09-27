# Mapa de elementos para provas (`HANGAR_NATIVE_UI_MAP`)

Com `HANGAR_NATIVE_UI_MAP=<arquivo>` no ambiente do binário, o app grava nesse arquivo, a cada quadro
em que a lista mudar, todos os elementos que têm `.id(...)`. Sem a variável, nada é gravado.
A escrita é atômica (`<arquivo>.tmp` + rename): quem lê nunca vê o JSON pela metade.

```json
{"seq": 21, "elements": [
  {"id": "font-1", "path": ["gpui_component::window_border::WindowBorder", "window-backdrop", "root",
     "hangar-root", "settings-content", "gpui_component::button::button::Button", "gpui_base::button::Button", "font-1"],
   "x": 1115.2, "y": 156.0, "w": 120.8, "h": 28.0, "visible": true}
]}
```

- `seq` sobe a cada gravação.
- `path`: ids da raiz até o elemento; ids de view (`view-N`) ficam de fora.
- `x y w h`: pixels lógicos relativos ao canto da janela. Para clicar, some a posição `at` que o `hyprctl clients -j` dá para a janela.
- `visible`: se sobra alguma parte depois do recorte dos elementos pais. Um elemento que saiu rolando conta como `false`. Um coberto por diálogo continua `true`.
- Não tem rótulo nem texto da tela, só ids. Um id feito com dado (nome de sessão, id de mensagem) aparece como foi montado no código.

Para descobrir um id: `grep -rn '\.id("' src` ou `Button::new("…")` (o primeiro argumento vira o id), ou leia o mapa gravado numa execução.

## `tools/ui_map.sh`

`source` no script, com `UI_MAP=<arquivo do mapa>` e `UI_MAP_PID=<PID do app que a prova abriu>`
(`UI_MAP_WS`, padrão 21). O id aceita `*` no fim como prefixo (`message-*`). Só contam elementos visíveis.

| Função | Faz |
|---|---|
| `ui_map_bounds <id>` | imprime `x y w h` do único visível; sai 1 se não há nenhum, 2 se há mais de um |
| `ui_map_wait <id> [s]` | espera aparecer (padrão 20 s) |
| `ui_map_wait_gone <id> [s]` | espera sumir |
| `ui_map_settle [ms] [s]` | espera o mapa ficar parado por `ms` (padrão 400): use antes de capturar |
| `ui_map_click <id> [s]` | espera, confere janela do PID no workspace e com foco, move o cursor ao centro, confere e clica |

## Exemplo de prova.sh

```bash
tools=${HANGAR_NATIVE_TOOLS:-/home/jefferson/pessoal/hangar-native-desktop/desktop-native/tools}
source "$tools/ui_map.sh"
export UI_MAP="$out/ui-map.json"
hyprctl dispatch exec "[workspace 21 silent] env HANGAR_NATIVE_UI_MAP=$UI_MAP $binary"
# … anote o PID do binário em UI_MAP_PID e dê foco à janela dele …
ui_map_click 'style-proof*'            # linha da sessão na barra lateral
ui_map_wait 'message-*'                # a conversa abriu
ydotool key 29:1 51:1 51:0 29:0        # Ctrl+, abre Configurações
ui_map_wait settings-back
ui_map_click appearance-style-compact
ui_map_settle && grim -g "$geometria" "$out/03.png"
```

Provas completas: `visual/task73/prova-uimap.sh` e `visual/task103/prova.sh` no diretório da orquestração.
