# pair_hook

Saída do hook de SessionStart (`backend/hooks/pair_hook.py <pair_dir>`) rodado como processo, um arquivo por variante. `input`: arquivos da pasta de grupo (`pair_dir`, texto cru), sidecars sem terminal em `$HOME/.hangar/claude-headless` (`headless`), ambiente acrescentado a `HOME`/`PATH`/`LANG=C.UTF-8` (`env`) e o tmux falso no PATH (`tmux`: tabela do `list-panes -a` e código do `has-session`; `null` = sem tmux). `output`: código, stdout e stderr, com o caminho da pasta trocado por `<pair>`. `ids` = itens HOOK-* cobertos.

- Commit de origem: `b803d419a423983b51bba9fe4fabf9206521557a` (Python dos grupos igual ao de `f83efc1ed`).
- Gravadas no commit `4c3fe10b3`, pelo `gen_golden.py --only pair_hook` de então.

**Congeladas:** o `pair_hook.py` saiu (o hook agora é `hangar-server pair-context`) e não há como
gerá-las de novo. Nunca editar à mão; o que o Rust muda por decisão tem teste próprio em
`crates/hangar-server/tests/it/groups_context_cmd.rs`.
