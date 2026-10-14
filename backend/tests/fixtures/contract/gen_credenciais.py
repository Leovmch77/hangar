"""Golden do `GET /api/credenciais`: o status e o corpo que a rota Python dava para pastas de conta,
`engines.json`, cookies, apelidos e `config.toml` do Kimi montados num HOME temporário.

O teste `contract_credenciais.rs` monta a MESMA árvore (com `⟦HOME⟧` trocado pela pasta dele), sobe o
roteador Rust e compara caso a caso. Fatos que a rota Python pedia ao Rust pela ponte (login Claude,
login e preparo Codex, cotas) entram aqui como `fatos`: o valor que o Rust devolve para aquela árvore
(CLI falsos e cache de cota semeado no teste). Limites dessa injeção: `conferencia.md`.

A rota Python saiu do repositório com a migração; para regerar, rode no commit gravado em `origem`
(`git worktree add /tmp/c <commit>`).

Uso, de backend/:  uv run python tests/fixtures/contract/gen_credenciais.py
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN = HERE / "golden" / "credenciais.json"
HOME = "⟦HOME⟧"
START = "# >>> hangar: provedor {0} (app/agentes_sync) — gerado, não editar à mão"
END = "# <<< hangar: fim do provedor {0}"


def login(logged, email=None, plano=None):
    return {"estado": "ok", "loggedIn": logged, "email": email, "plano": plano, "motivo": None,
            "refreshExpiresAt": None}


CLI_MISSING = {"estado": "indisponivel", "loggedIn": None, "email": None, "plano": None,
               "motivo": "cli-indisponivel", "refreshExpiresAt": None}
UNAVAILABLE = {"method": "unknown", "status": "unavailable", "email": None, "plan": None}
IDLE = {"status": "idle", "trust_pending": False, "issues": [], "etapa": None, "herdado": None}


def quota(id, label, provedor, ativa, cota):
    """Linha que o Rust devolve para a entrada `cota` do cache semeado."""
    return {**cota, "id": id, "label": label, "provedor": provedor, "ativa": ativa,
            "idade_s": None, "refresh_expires_at": None}


def dumps(value) -> str:
    # Sem escapar: o `⟦HOME⟧` dentro de um arquivo JSON precisa sair literal para ser trocado.
    return json.dumps(value, ensure_ascii=False)


def marker_codex(name):
    return dumps({"version": 1, "id": name})


def case_completo():
    files = {
        ".claude/.fake-auth.json": dumps({"loggedIn": True, "email": "a@b", "subscriptionType": "max"}),
        ".claude-work/.hangar-conta": "",
        ".claude-work/.fake-auth.json": dumps({"loggedIn": False}),
        ".claude-semcli/.hangar-conta": "",
        ".claude-backup/.credentials.json": "{}",
        ".claude-backup/projects/x": "",
        ".claude-pend/.hangar-conta": "",
        ".claude-pend/.hangar-account-pending": "",
        ".claude/.hangar-apelidos.json": dumps({
            f"claude:{HOME}/.claude-work": "  Firma  ",
            f"claude:{HOME}/.claude-semcli": "   ",
            "chave:kimi": "Kimi Pessoal",
            f"codex:{HOME}/.codex-work": "Trabalho",
            "kimi:gen": "Gerado",
        }),
        ".claude/engines.json": dumps({
            "kimi": {"label": "Kimi", "base_url": "https://api.kimi.com/coding", "api_key": "sk-kimi-abcdefg4f2a", "model": "k3"},
            "curta": {"base_url": "https://x.example", "api_key": "1234567890", "model": "m"},
            "oc": {"label": "", "base_url": "https://opencode.ai/zen/go", "api_key": "", "model": "m"},
            "oc2": {"label": 0, "base_url": "https://opencode.ai/zen", "api_key": "çççççççççççç", "model": "m"},
            "cc": {"label": "CommandCode", "base_url": "https://api.commandcode.ai", "api_key": "k", "model": "m"},
            "semchave": {"model": "m"},
            "Nome Ruim": {"base_url": "https://y", "api_key": "abc", "model": "m"},
            "vazio": {"base_url": "", "api_key": 5, "model": "m"},
        }),
        ".claude/.hangar-opencode.json": dumps({
            "chave:oc": {"workspace_id": "ws", "auth_cookie": "c"},
            "chave:oc2": {"workspace_id": "ws", "auth_cookie": ""},
        }),
        ".codex/.fake-account.json": dumps({"account": {"type": "chatgpt", "email": "e@x", "planType": "pro"}}),
        ".codex-work/.hangar-codex-conta": marker_codex("work"),
        ".codex-work/.fake-account.json": dumps({"account": {"type": "apiKey"}}),
        ".codex-off/.hangar-codex-conta": marker_codex("off"),
        ".codex-off/.fake-account.json": dumps({"account": None}),
        ".codex-ruim/.hangar-codex-conta": marker_codex("outro"),
        ".kimi-code/config.toml": "\n".join([
            "default_model = \"apikey/k3\"",
            "[providers.apikey]", "type = \"kimi\"", "api_key = \"sk-a\"", "base_url = \"https://api.kimi.com/coding/v1\"",
            START.format("gen"), "[providers.gen]", "type = \"kimi\"", "api_key = \"sk-g\"",
            "base_url = \"https://api.kimi.com/coding/v1\"", END.format("gen"),
            "[providers.oauth]", "type = \"kimi\"", "base_url = \"https://api.kimi.com\"", ""]),
    }
    lida = {"estado": "lida", "janelas": [{"rotulo": "5h", "pct": 13, "reset_ts": 1800000000},
                                         {"rotulo": "Fable", "pct": 2.5, "reset_ts": None, "por_modelo": True}],
            "ts": None, "motivo": None, "reset_credits": None}
    off = {"estado": "indisponivel", "janelas": [], "ts": None, "motivo": "http-404", "reset_credits": None}
    codex = {"estado": "lida", "janelas": [{"rotulo": "5h", "pct": 40.0, "reset_ts": None, "por_modelo": False}],
             "ts": None, "motivo": None,
             "reset_credits": {"available_count": 2, "credits": [{"id": "r1", "expires_at": 1800000000, "title": "Grátis"}]}}
    cache = [
        quota(f"claude:{HOME}/.claude", "default", "claude", True, lida),
        quota(f"claude:{HOME}/.claude-work", "Firma", "claude", False, off),
        quota(f"codex:{HOME}/.codex", "Codex", "codex", False, codex),
        quota(f"codex:{HOME}/.codex-work", "Trabalho", "codex", False, off),
        quota("kimi:apikey", "apikey", "kimi", False, {**off, "motivo": "formato-desconhecido"}),
        quota("kimi:gen", "Gerado", "kimi", False, lida),
        quota("chave:kimi", "Kimi Pessoal", "kimi", False, lida),
        quota("chave:curta", "curta", "kimi", False, off),
        quota("chave:cc", "CommandCode", "commandcode", False, off),
        quota(f"claude:{HOME}/.claude-semcli", "semcli", "claude", False, off),
        quota(f"codex:{HOME}/.codex-off", "off", "codex", False, off),
        quota("chave:oc2", "oc2", "kimi", False, off),
    ]
    return {"name": "completo", "query": "", "files": files, "codex_cli": True,
            "fatos": {"claude_auth": {".claude": login(True, "a@b", "max"), ".claude-work": login(False),
                                      ".claude-semcli": CLI_MISSING},
                      "codex_auth": {"default": {"method": "oauth", "status": "connected", "email": "e@x", "plan": "pro"},
                                     "work": {"method": "api_key", "status": "connected", "email": None, "plan": None},
                                     "off": {"method": "none", "status": "disconnected", "email": None, "plan": None}},
                      "codex_sync": {"work": IDLE, "off": IDLE},
                      "quotas": cache}}


def case_forcar():
    files = {".claude/.fake-auth.json": dumps({"loggedIn": False})}
    reading = {"estado": "sem_credencial", "janelas": [], "motivo": "credencial-ilegivel", "ts": None,
               "reset_credits": None}
    return {"name": "forcar_rele_cota", "query": "?forcar=true", "files": files, "codex_cli": False,
            "fatos": {"claude_auth": {".claude": login(False)}, "codex_auth": {}, "codex_sync": {},
                      "quotas_forcadas": [quota(f"claude:{HOME}/.claude", "default", "claude", True, reading)],
                      "quotas": []}}


OFF = {"estado": "indisponivel", "janelas": [], "ts": None, "motivo": "http-404", "reset_credits": None}


def base_quotas(codex=False, extra=()):
    rows = [quota(f"claude:{HOME}/.claude", "default", "claude", True, OFF)]
    if codex:
        rows.append(quota(f"codex:{HOME}/.codex", "Codex", "codex", False, OFF))
    return rows + [quota(id, label, "kimi", False, OFF) for id, label in extra]


def case_codex_prazo():
    files = {".claude/.fake-auth.json": dumps({"loggedIn": True}),
             ".codex/.fake-account.json": dumps({"account": {"type": "apiKey"}}),
             ".codex/.fake-delay": ""}
    return {"name": "codex_estoura_prazo", "query": "", "files": files, "codex_cli": True,
            "fatos": {"claude_auth": {".claude": login(True)}, "codex_auth": {"default": "prazo"},
                      "codex_sync": {}, "quotas": base_quotas(codex=True)}}


def case_codex_sem_cli():
    files = {".claude/.fake-auth.json": dumps({"loggedIn": True}), ".codex/config.toml": ""}
    return {"name": "codex_sem_cli", "query": "", "files": files, "codex_cli": False,
            "fatos": {"claude_auth": {".claude": login(True)},
                      "codex_auth": {"default": {**UNAVAILABLE, "reason": "cli_missing"}},
                      "codex_sync": {}, "quotas": base_quotas(codex=True)}}


def case_engines(name, raw, quotas=None):
    """`quotas="falha"`: a árvore que derruba a enumeração das fontes também derrubava a cota."""
    return {"name": name, "query": "", "files": {".claude/.fake-auth.json": dumps({"loggedIn": True}),
                                                 ".claude/engines.json": raw},
            "codex_cli": False, "fatos": {"claude_auth": {".claude": login(True)}, "codex_auth": {},
                                          "codex_sync": {}, "quotas": base_quotas() if quotas is None else quotas}}


CASES = [case_completo(), case_forcar(), case_codex_prazo(), case_codex_sem_cli(),
         case_engines("engines_fora_do_utf8", "", "falha") | {"files_hex": {".claude/engines.json": "7b2261223aff7d"}},
         case_engines("motor_nao_objeto", dumps({"a": "texto"}), "falha"),
         case_engines("motor_label_numero", dumps({"a": {"label": 5, "base_url": "x", "api_key": "k"}}),
                      base_quotas(extra=[("chave:a", 5)])),
         case_engines("motor_base_url_lista", dumps({"a": {"base_url": ["x"], "api_key": "k"}})),
         case_engines("engines_quebrado", "{nao json"),
         case_engines("engines_com_bom", "\ufeff" + dumps({"a": {"base_url": "x", "api_key": "k"}})),
         case_engines("vazio", "{}"),
         case_engines("query_invalida", "{}") | {"query": "?forcar=talvez"}]


def materialize(home: Path, files: dict) -> None:
    for rel, content in files.items():
        path = home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def run_one(spec_path: str) -> None:
    """Num processo próprio: módulos do backend guardam HOME e caches na importação."""
    import asyncio
    spec = json.loads(Path(spec_path).read_text())
    home = os.environ["HOME"]
    fatos = json.loads(json.dumps(spec["fatos"], ensure_ascii=False).replace(HOME, home))
    sys.path.insert(0, str(HERE.parents[2]))
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import account_bridge, credenciais
    from app.auth import require_auth

    account_bridge.owner_mode = lambda: "rust"
    account_bridge.request_claude = lambda action, path: fatos["claude_auth"][os.path.relpath(path, home)]

    def quotas(*, force=False, cached_only=False, invalidate=None):
        rows = fatos["quotas_forcadas"] if force else fatos["quotas"]
        if rows == "falha":
            from fastapi import HTTPException
            raise HTTPException(503, detail={"code": "quota_bridge_unavailable"})
        return rows
    account_bridge.request_quotas = quotas

    class Service:
        async def preparation_status_async(self, account):
            return fatos["codex_sync"].get(account.id, IDLE)

        async def read_auth_rapido(self, account):
            value = fatos["codex_auth"][account.id]
            if value == "prazo":
                await asyncio.sleep(4)
            return value

        async def read_auth(self, account, *, refresh=False):
            assert refresh
            return await self.read_auth_rapido(account)

    app = FastAPI()
    app.include_router(credenciais.credenciais_router)
    app.dependency_overrides[require_auth] = lambda: None
    app.state.codex_contas_login = Service()
    response = TestClient(app, raise_server_exceptions=False).get("/api/credenciais" + spec["query"])
    body = response.text.replace(home, HOME)
    try:
        body = json.loads(body)
    except ValueError:
        pass
    print(json.dumps({"status": response.status_code, "content_type": response.headers.get("content-type"),
                      "body": body}, ensure_ascii=False))


def main() -> None:
    out = []
    for case in CASES:
        with tempfile.TemporaryDirectory() as root:
            home = Path(root).resolve()
            materialize(home, json.loads(json.dumps(case["files"], ensure_ascii=False).replace(HOME, str(home))))
            for rel, raw in case.get("files_hex", {}).items():
                (home / rel).write_bytes(bytes.fromhex(raw))
            bin_dir = home / "bin"
            bin_dir.mkdir()
            if case["codex_cli"]:
                (bin_dir / "codex").write_text("#!/bin/sh\nexit 1\n")
                (bin_dir / "codex").chmod(0o755)
            spec = home / "spec.json"
            spec.write_text(json.dumps(case))
            env = {k: v for k, v in os.environ.items() if k not in {"CODEX_HOME", "CLAUDE_CONFIG_DIR",
                                                                     "CP_CLAUDE_CONFIG_DIRS", "KIMI_CODE_HOME",
                                                                     "CP_ENGINES_FILE"} and not k.startswith("OPENCODE_")}
            env.update({"HOME": str(home), "USERPROFILE": str(home),
                        "PATH": f"{bin_dir}:/usr/bin:/bin"})
            result = subprocess.run([sys.executable, __file__, "--one", str(spec)], env=env,
                                    capture_output=True, text=True, cwd=HERE.parents[2])
            if result.returncode:
                sys.exit(f"{case['name']}: {result.stderr}")
            out.append({**case, "esperado": json.loads(result.stdout.strip().splitlines()[-1])})
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True).stdout.strip()
    document = {"origem": {"commit": commit,
                           "comando": "cd backend && uv run python tests/fixtures/contract/gen_credenciais.py"},
                "casos": out}
    GOLDEN.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(out)} casos em {GOLDEN}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--one"]:
        run_one(sys.argv[2])
    else:
        main()
