# pair_text

Texto do protocolo de grupo que o Python devolve em `POST /internal/pair/text` (a rota que o Rust chama), um arquivo por variante: `request`, `status`, `response`. `ids` = itens TXT-* do inventário cobertos.

- Commit de origem: `b803d419a423983b51bba9fe4fabf9206521557a` (Python dos grupos igual ao de `f83efc1ed`).
- Comando: `cd backend && uv run python tests/fixtures/contract/gen_golden.py --only pair_text`

Gerado executando o Python; nunca editar à mão.
