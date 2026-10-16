# Mermaid embutido

`mermaid.min.js.gz` é o `dist/mermaid.min.js` do pacote npm `mermaid` 12.2.0 (MIT, licença em
`LICENSE`), comprimido com `gzip -9 -n`. O `hangar-server` o embute com `include_bytes!` e desenha os
diagramas da rota `POST /api/mermaid` no Chromium do servidor, sem rede (`src/mermaid/`).

Origem: <https://www.npmjs.com/package/mermaid/v/12.2.0>, arquivo `package/dist/mermaid.min.js` do
tarball (IIFE que define `globalThis.mermaid`, sem `import()` de pedaços).

## Atualizar

1. `npm pack mermaid@<versão>` numa pasta vazia e `tar xzf mermaid-<versão>.tgz`.
2. Conferir a licença (`package/LICENSE`) e copiá-la para cá.
3. `gzip -9 -n -c package/dist/mermaid.min.js > mermaid.min.js.gz`.
4. Trocar `MERMAID_VERSION` em `src/mermaid/mod.rs` (entra na chave do cache: diagramas antigos
   são desenhados de novo) e a versão deste arquivo.
5. Rodar os testes do módulo: um deles confere que o arquivo descomprime, define `mermaid` e não
   tem `<script` nem `</script` cru, que fechariam o `<script>` da página do desenho.
