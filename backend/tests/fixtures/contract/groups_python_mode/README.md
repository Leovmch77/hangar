# groups_python_mode

Status e corpo das 6 rotas de grupo do FastAPI no modo `python` (sem Rust), pelos mesmos passos de `golden/group_routes.json` e `golden/group_cross_routes.json`. Só registra o que deixa de existir quando o Python sair dos grupos.

- Commit de origem: `b803d419a423983b51bba9fe4fabf9206521557a` (Python dos grupos igual ao de `f83efc1ed`).
- Gravadas no commit `4c3fe10b3`, pelo `gen_golden.py --only groups_python_mode` de então.

**Congeladas:** o Python dos grupos saiu; no modo `python` as 6 rotas respondem 503
`groups_need_rust_server` (`backend/tests/test_groups_bridge.py`), e não há como gerá-las de novo.
Nunca editar à mão.
