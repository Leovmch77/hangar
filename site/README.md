# site

Landing page de `hangar.dev.br`: PT em `/`, EN em `/en/`, gerada em `site/public/` (fora do git).

## Gerar e ver

```bash
python3 site/build.py
python3 -m http.server -d site/public 8099
```

## Testar

Só quando pedido.

```bash
python3 -m unittest discover site/tests
node --test site/tests/        # Node >= 22
```

## Publicar

```bash
site/deploy.sh          # prévia
site/deploy.sh main     # produção
```

Rode `npx wrangler login` uma vez antes: o login da `cf` não serve para upload.

## Cache

Tudo em `/assets/media/` (vídeos, capas, imagens, `og.png`) sai `immutable` por um ano
(`site/static/_headers`). Arquivo trocado precisa de nome novo.

## Regravar vídeos

Só Linux/Hyprland. Abre janelas na tela de quem grava.

```bash
python3 site/tools/record/live.py &
site/tools/record/record.sh <cena> <segundos> <ctrl-down> <lang>
site/tools/record/enc.sh <cena> <lang>
```

| cena | segundos | ctrl-down |
|---|---|---|
| `agents` | 15 | 1 |
| `ask` | 16 | 1 |
| `pair` | 14 | 1 |
| `orq` | 13 | 4 (seleciona `orq-checkout`, a 4ª linha da lateral) |

- `<lang>` é `en` ou `pt`. A saída fica em `site/tools/record/out/`; copie `<cena>-<lang>.mp4`
  e `.jpg` para `site/media/` (EN) ou `site/media/pt/` (PT), com o nome `<cena>.mp4`/`.jpg`.
- A janela tem 1600x960 na posição 160,60: o monitor precisa de pelo menos 1760x1020 lógicos
  (tamanho dividido pela escala). `launch.sh` recusa se não couber.
- Variáveis: `HANGAR_RECORD_MONITOR=<nome>` escolhe o monitor (padrão: o focado);
  `HANGAR_RECORD_SIZE`, `HANGAR_RECORD_POS`, `HANGAR_NATIVE_BIN` (padrão: `hangar-native` no
  `PATH`) e `HANGAR_RECORD_OUT` mudam tamanho, posição, binário e pasta de saída.
