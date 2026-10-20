# pair_hook

Saída do hook de SessionStart (`backend/hooks/pair_hook.py <pair_dir>`) rodado como processo, um arquivo por variante. `input`: arquivos da pasta de grupo (`pair_dir`, texto cru), sidecars sem terminal em `$HOME/.hangar/claude-headless` (`headless`), ambiente acrescentado a `HOME`/`PATH`/`LANG=C.UTF-8` (`env`) e o tmux falso no PATH (`tmux`: tabela do `list-panes -a` e código do `has-session`; `null` = sem tmux). `output`: código, stdout e stderr, com o caminho da pasta trocado por `<pair>`. `ids` = itens HOOK-* cobertos.

- Commit de origem: `b803d419a423983b51bba9fe4fabf9206521557a` (Python dos grupos igual ao de `f83efc1ed`).
- Comando: `cd backend && uv run python tests/fixtures/contract/gen_golden.py --only pair_hook`

Gerado executando o Python; nunca editar à mão.
