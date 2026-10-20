# groups_python_mode

Status e corpo das 6 rotas de grupo do FastAPI no modo `python` (sem Rust), pelos mesmos passos de `golden/group_routes.json` e `golden/group_cross_routes.json`. Só registra o que deixa de existir quando o Python sair dos grupos.

- Commit de origem: `b803d419a423983b51bba9fe4fabf9206521557a` (Python dos grupos igual ao de `f83efc1ed`).
- Comando: `cd backend && uv run python tests/fixtures/contract/gen_golden.py --only groups_python_mode`

Gerado executando o Python; nunca editar à mão.
