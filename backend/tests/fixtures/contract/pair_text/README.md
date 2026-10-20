# pair_text

Texto do protocolo de grupo que o Python devolve em `POST /internal/pair/text` (a rota que o Rust chama), um arquivo por variante: `request`, `status`, `response`. `ids` = itens TXT-* do inventário cobertos.

- Commit de origem: `b803d419a423983b51bba9fe4fabf9206521557a` (Python dos grupos igual ao de `f83efc1ed`).
- Gravadas no commit `4c3fe10b3`, pelo `gen_golden.py --only pair_text` de então.

**Congeladas:** o texto do Python e a rota `/internal/pair/text` saíram (o texto agora é do Rust) e
não há como gerá-las de novo. Nunca editar à mão; o que o Rust muda por decisão tem teste próprio
em `crates/hangar-server/tests/it/groups_text.rs`.
