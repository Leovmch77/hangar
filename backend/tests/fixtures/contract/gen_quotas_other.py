"""Cota das fontes que não são Claude nem Codex (Kimi, CommandCode, OpenCode Go): o que os leitores
Python devolviam para cada resposta HTTP, e quais fontes saíam de cada combinação de arquivos.

Os leitores rodam de verdade (urllib incluído) contra um servidor HTTP local que dá a resposta do
caso; só as URLs fixas do CommandCode e do OpenCode apontam para ele. O teste
`crates/hangar-server/tests/contract_quotas_other.rs` serve as MESMAS respostas ao leitor Rust e
compara caso a caso. Casos marcados com `diferenca` têm saída nova aprovada (decisoes.md).

Os leitores Python saíram do repositório depois desta captura: para regravar, rode a partir do
commit de origem gravado no golden (`git worktree add /tmp/q <commit>`).

Uso, de backend/:  uv run python tests/fixtures/contract/gen_quotas_other.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))
GOLDEN = HERE / "golden" / "quotas_other.json"
TZ = "BRT3"          # data sem fuso é hora local: UTC-3 fixo prova que é local, não UTC
NOW = 1_790_000_000.0

os.environ["TZ"] = TZ
time.tzset()

from app import cotas, opencode_cota  # noqa: E402

# Resposta real de 18/08/2026 (strings em limit/remaining, sem `used`).
USAGE_KIMI = {
    "usage": {"limit": "100", "remaining": "80", "resetTime": "2026-08-24T17:59:46.782017Z"},
    "limits": [{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                "detail": {"limit": "100", "remaining": "75",
                           "resetTime": "2026-08-18T17:59:46.782017Z"}}],
}
# Resposta real de 21/08/2026 (USD, resetAt em ms, 0 = sem reset).
USAGE_COMMANDCODE = {
    "credits": {"belowThreshold": False, "creditThreshold": 0,
                "monthlyCredits": 52.2129667955, "purchasedCredits": 0, "freeCredits": 0},
    "windowLimits": {"limited": True, "exceeded": None,
                     "fiveHour": {"used": 0, "cap": 14, "exceeded": False, "resetAt": 0},
                     "weekly": {"used": 17.7870332045, "cap": 35, "exceeded": False,
                                "resetAt": 1787564008022}},
}


def html(*, rolling=(12.5, 3600), weekly=(48.0, 172800), monthly=None, invertido=False) -> str:
    partes = ["<html><script>window._$HY=1;"]
    for chave, val in (("rollingUsage", rolling), ("weeklyUsage", weekly), ("monthlyUsage", monthly)):
        if val is None:
            continue
        pct, reset = val
        corpo = (f"resetInSec:{reset},usagePercent:{pct}" if invertido
                 else f"usagePercent:{pct},resetInSec:{reset}")
        partes.append(f"{chave}:$R[3]={{{corpo}}};")
    partes.append("</script></html>")
    return "".join(partes)


def kimi_limit(limit, remaining, reset="2026-08-18T17:59:46Z", duration=300):
    return {"window": {"duration": duration}, "detail": {"limit": limit, "remaining": remaining,
                                                         "resetTime": reset}}


def j(value) -> str:
    return json.dumps(value)


# --------------------------------------------------------------------------- servidor de casos

class _State:
    response = (200, "", None)       # (status, corpo, location)
    seen: list = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        status, body, location = _State.response
        if self.path.startswith("/login"):
            status, body, location = 200, "<html>Sign in to continue</html>", None
        _State.seen.append({"path": self.path,
                            "authorization": self.headers.get("Authorization"),
                            "accept": self.headers.get("Accept"),
                            "user_agent": self.headers.get("User-Agent"),
                            "cookie": self.headers.get("Cookie")})
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        if location:
            self.send_header("Location", location)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def reader_cases(base: str) -> list[dict]:
    """Cada caso: leitor, credencial, resposta servida. `{BASE}` vira o endereço do servidor."""
    cases = []

    def case(name, reader, response=None, *, key="sk-test", path="/coding/v1", workspace="ws-1",
             cookie="cookie-1", refused=False, diferenca=None, base=None):
        cases.append({"name": name, "reader": reader, "key": key, "path": path, "base": base,
                      "workspace": workspace, "cookie": cookie, "refused": refused,
                      "response": response, "diferenca": diferenca})

    ok = lambda body: {"status": 200, "body": body}  # noqa: E731
    # Kimi
    case("kimi_real_18_08", "kimi", ok(j(USAGE_KIMI)))
    case("kimi_real_13_10_sem_plano", "kimi", ok("{}"))
    case("kimi_numeros_json", "kimi", ok(j({"limits": [kimi_limit(200, 50)], "usage": {"limit": 10, "remaining": 0}})))
    case("kimi_numero_com_espaco_e_expoente", "kimi", ok(j({"limits": [kimi_limit(" 1e2 ", "25")]})))
    case("kimi_bool_nao_e_numero", "kimi", ok(j({"limits": [kimi_limit(True, "1")], "usage": {"limit": "10", "remaining": False}})))
    case("kimi_limite_zero_e_negativo", "kimi", ok(j({"limits": [kimi_limit("0", "0"), kimi_limit("-5", "1")]})))
    case("kimi_pct_preso", "kimi", ok(j({"limits": [kimi_limit("100", "150"), kimi_limit("100", "-50")]})))
    case("kimi_nan_e_inf_em_texto", "kimi", ok(j({"limits": [kimi_limit("nan", "1"), kimi_limit("100", "inf"), kimi_limit("inf", "1")]})))
    case("kimi_underscore", "kimi", ok(j({"limits": [kimi_limit("1_000", "500")]})))
    case("kimi_rotulos", "kimi", ok(j({"limits": [
        kimi_limit("10", "5", duration=300), kimi_limit("10", "5", duration=1440),
        kimi_limit("10", "5", duration=10080), kimi_limit("10", "5", duration="90"),
        kimi_limit("10", "5", duration=300.5), kimi_limit("10", "5", duration=0),
        kimi_limit("10", "5", duration=None), kimi_limit("10", "5", duration="x"),
        {"window": "nao-objeto", "detail": {"limit": "10", "remaining": "5"}},
        "item-nao-objeto", {"window": {"duration": 60}},
    ]})))
    case("kimi_reset_formatos", "kimi", ok(j({"limits": [
        kimi_limit("10", "5", reset="2026-08-18T17:59:46Z"),
        kimi_limit("10", "5", reset="2026-08-18T17:59:46.5+02:00"),
        kimi_limit("10", "5", reset="2026-08-18T17:59:46.1234567Z"),
        kimi_limit("10", "5", reset="2026-08-18"),
        kimi_limit("10", "5", reset="2026-08-18T17:59:46"),
        kimi_limit("10", "5", reset="2026-08-18 17:59"),
        kimi_limit("10", "5", reset="nao-e-data"),
        kimi_limit("10", "5", reset=""),
        kimi_limit("10", "5", reset=1787564008),
    ]})))
    case("kimi_usage_so", "kimi", ok(j({"usage": {"limit": "100", "remaining": "40"}})))
    case("kimi_limits_nao_lista", "kimi", ok(j({"limits": {"a": 1}, "usage": "x"})))
    case("kimi_json_lista", "kimi", ok("[]"))
    case("kimi_json_invalido", "kimi", ok("{nao json"))
    case("kimi_utf8_invalido", "kimi", {"status": 200, "body": "invalido", "raw_hex": "7b22a8227d"})
    case("kimi_corpo_vazio", "kimi", ok(""))
    for code in (401, 403, 404, 429, 500, 503):
        case(f"kimi_http_{code}", "kimi", {"status": code, "body": j(USAGE_KIMI)})
    case("kimi_202_com_corpo", "kimi", {"status": 202, "body": j(USAGE_KIMI)})
    case("kimi_recusada", "kimi", refused=True)
    case("kimi_barra_final", "kimi", ok(j(USAGE_KIMI)), path="/coding/v1///")
    case("kimi_redirect", "kimi", {"status": 302, "body": "", "location": "/coding/v1/usages-outro"},
         diferenca="D6")
    case("kimi_chave_com_quebra", "kimi", ok(j(USAGE_KIMI)), key="sk-a\nb", diferenca="D5")
    case("kimi_duracao_inf", "kimi", ok(j({"limits": [kimi_limit("10", "5", duration="inf")]})))
    case("kimi_duracao_nan", "kimi", ok(j({"limits": [kimi_limit("10", "5", duration="nan")]})))
    case("kimi_json_com_nan", "kimi", ok('{"limits": [{"window": {"duration": 300}, "detail": '
                                         '{"limit": NaN, "remaining": "1", "resetTime": NaN}}], '
                                         '"usage": {"limit": Infinity, "remaining": -Infinity}}'))
    case("kimi_url_sem_esquema", "kimi", ok(j(USAGE_KIMI)), path="", base="nao-e-url")
    case("kimi_url_ftp", "kimi", ok(j(USAGE_KIMI)), path="", base="ftp://127.0.0.1:1/x")
    # CommandCode
    case("commandcode_real_21_08", "commandcode", ok(j(USAGE_COMMANDCODE)))
    case("commandcode_sem_janelas", "commandcode", ok(j({"windowLimits": {"fiveHour": {"used": 1, "cap": 0}}})))
    case("commandcode_window_nao_objeto", "commandcode", ok(j({"windowLimits": [1]})))
    case("commandcode_strings_e_preso", "commandcode", ok(j({"windowLimits": {
        "fiveHour": {"used": "20", "cap": "10", "resetAt": "1787564008022"},
        "weekly": {"used": -1, "cap": 10, "resetAt": True}}})))
    case("commandcode_429", "commandcode", {"status": 429, "body": ""})
    case("commandcode_403_cloudflare", "commandcode", {"status": 403, "body": "error code: 1010"})
    case("commandcode_json_lista", "commandcode", ok("[1]"))
    case("commandcode_recusada", "commandcode", refused=True)
    # OpenCode
    case("opencode_tres_janelas", "opencode", ok(html(monthly=(9.0, 864000))))
    case("opencode_ordem_invertida", "opencode", ok(html(invertido=True)))
    case("opencode_janela_ausente", "opencode", ok(html(monthly=None)))
    case("opencode_pagina_login", "opencode", ok("<html><body>Sign in to continue</body></html>"))
    case("opencode_pct_preso_reset_negativo", "opencode", ok(html(rolling=(-3.0, -60), weekly=(140.0, 60))))
    case("opencode_primeira_ocorrencia", "opencode",
         ok(html(rolling=(1.0, 10)) + html(rolling=(2.0, 20))))
    case("opencode_chave_fora_do_bloco", "opencode",
         ok("rollingUsage:$R[1]={usagePercent:5}resetInSec:7}"))
    case("opencode_inteiros_e_negativos", "opencode", ok("weeklyUsage:$R[12]={a:1,usagePercent:-0,b:2,resetInSec:30,c:3}"))
    case("opencode_corpo_vazio", "opencode", ok(""))
    case("opencode_403", "opencode", {"status": 403, "body": "negado"})
    case("opencode_utf8_invalido", "opencode", {"status": 200, "body": "x", "raw_hex": "ff" + html().encode().hex()})
    case("opencode_workspace_codificado", "opencode", ok(html()), workspace="ws/1 ?&é")
    case("opencode_recusada", "opencode", refused=True)
    case("opencode_redirect_login", "opencode", {"status": 302, "body": "", "location": "/login"},
         diferenca="D6")
    case("opencode_cookie_com_quebra", "opencode", ok(html()), cookie="a\r\nb", diferenca="D5")
    return cases


def run_reader(case: dict, base: str, closed: str) -> dict:
    response = case["response"] or {"status": 0, "body": ""}
    body = bytes.fromhex(response["raw_hex"]) if response.get("raw_hex") else response["body"]
    _State.response = (response["status"], body, response.get("location"))
    _State.seen = []
    origin = case["base"] or (closed if case["refused"] else base)
    if case["reader"] == "kimi":
        result = cotas._seguro(cotas._Fonte("x", "x", "kimi",
                                            lambda: cotas._ler_kimi(case["key"], origin + case["path"])))
    elif case["reader"] == "commandcode":
        with patch.object(cotas, "_URL_COMMANDCODE", origin + "/alpha/billing/credits"):
            result = cotas._seguro(cotas._Fonte("x", "x", "commandcode",
                                                lambda: cotas._ler_commandcode(case["key"])))
    else:
        with patch.object(opencode_cota, "_URL", origin + "/workspace/{}/go"), \
                patch.object(opencode_cota.time, "time", lambda: NOW):
            result = cotas._seguro(cotas._Fonte("x", "x", "opencode", lambda: cotas._ler_opencode(
                {"workspace_id": case["workspace"], "auth_cookie": case["cookie"]})))
    estado, janelas, motivo = result
    return {**case, "expected": {"estado": estado, "janelas": [w.model_dump() for w in janelas],
                                 "motivo": motivo},
            "requests": list(_State.seen)}


# --------------------------------------------------------------------------- enumeração das fontes

def source_cases() -> list[dict]:
    kimi_ok = 'default_model = "apikey/k3"\n[providers.apikey]\ntype = "kimi"\napi_key = "sk-kimi"\nbase_url = "https://api.kimi.com/coding/v1"\n'
    return [
        {"name": "nada"},
        {"name": "kimi_e_motores_na_ordem_dos_arquivos",
         "kimi_config": kimi_ok + '[providers.zz]\ntype = "kimi"\napi_key = "k2"\nbase_url = "https://x.commandcode.ai/v1"\n'
                                  '[providers.aa]\ntype = "kimi"\napi_key = "k3"\nbase_url = "https://outro/v1"\n'
                                  '[providers.oauth]\ntype = "kimi"\nbase_url = "https://api.kimi.com"\n'
                                  '[providers.vazio]\ntype = "kimi"\napi_key = ""\nbase_url = "https://a"\n'
                                  '[providers.semurl]\ntype = "kimi"\napi_key = "k"\n'
                                  '[providers.outro_tipo]\ntype = "openai"\napi_key = "k"\nbase_url = "https://a"\n'
                                  '[providers.chave_numero]\ntype = "kimi"\napi_key = 5\nbase_url = "https://a"\n',
         "engines": j({"zeta": {"base_url": "https://api.kimi.com/coding", "api_key": "sk-z", "model": "k3", "label": "Kimi Z"},
                       "alfa": {"base_url": "https://api.kimi.com/coding/v1/", "api_key": "sk-a", "model": "k3"},
                       "cc": {"base_url": "https://api.commandcode.ai/v1", "api_key": "cc-1", "model": "m", "label": ""},
                       "oc": {"base_url": "https://opencode.ai/zen/go/v1", "api_key": "oc-1", "model": "m"},
                       "oc-sem-cookie": {"base_url": "https://opencode.ai/zen/v1", "api_key": "oc-2", "model": "m", "label": None},
                       "local": {"base_url": "http://127.0.0.1:8317", "api_key": "sk-l", "model": "m", "label": 0},
                       "Maiusculo": {"base_url": "https://a", "api_key": "k", "model": "m"},
                       "nome com espaco": {"base_url": "https://a", "api_key": "k", "model": "m"},
                       "quebra\n": {"base_url": "https://a", "api_key": "kq", "model": "m"},
                       "sem-chave": {"base_url": "https://a", "model": "m"},
                       "chave-vazia": {"base_url": "https://a", "api_key": "", "model": "m"},
                       "url-numero": {"base_url": 1, "api_key": "k", "model": "m"},
                       "rotulo-numero": {"base_url": "https://a", "api_key": "kr", "model": "m", "label": 7},
                       "upper-host": {"base_url": "https://API.KIMI.COM/coding", "api_key": "ku", "model": "m"}}),
         "opencode": j({"chave:oc": {"workspace_id": "ws-9", "auth_cookie": "ck-9"},
                        "chave:incompleto": {"workspace_id": "ws", "auth_cookie": ""}}),
         "apelidos": j({"chave:alfa": "  Meu Alfa  ", "kimi:apikey": "", "chave:zeta": 3, "claude:/x": "C"})},
        {"name": "opencode_pelo_ambiente",
         "engines": j({"oc": {"base_url": "https://opencode.ai/zen/go/v1", "api_key": "oc-1", "model": "m"}}),
         "env": {"OPENCODE_GO_WORKSPACE_ID": " ws-env ", "OPENCODE_GO_AUTH_COOKIE": " ck-env "}},
        {"name": "opencode_ambiente_incompleto",
         "engines": j({"oc": {"base_url": "https://opencode.ai/zen/go/v1", "api_key": "oc-1", "model": "m"}}),
         "env": {"OPENCODE_GO_WORKSPACE_ID": "ws-env", "OPENCODE_GO_AUTH_COOKIE": "  "}},
        {"name": "arquivos_antigos",
         "engines": j({"oc": {"base_url": "https://opencode.ai/zen/go/v1", "api_key": "oc-1", "model": "m"}}),
         "opencode_legacy": j({"chave:oc": {"workspace_id": "ws-velho", "auth_cookie": "ck-velho"}}),
         "apelidos_legacy": j({"chave:oc": "Antigo"})},
        {"name": "arquivo_novo_vence_o_antigo",
         "engines": j({"oc": {"base_url": "https://opencode.ai/zen/go/v1", "api_key": "oc-1", "model": "m"}}),
         "opencode": j([]), "opencode_legacy": j({"chave:oc": {"workspace_id": "w", "auth_cookie": "c"}}),
         "apelidos": "{quebrado", "apelidos_legacy": j({"chave:oc": "Antigo"})},
        # Motor que não é objeto derrubava o `sources` inteiro (e com ele toda a cota): bug do tipo D1.
        {"name": "motor_nao_objeto_derruba",
         "engines": j({"a": {"base_url": "https://a", "api_key": "k", "model": "m"}, "nao-objeto": "texto"})},
        {"name": "engines_invalido", "engines": "{quebrado", "kimi_config": "nao = [toml"},
        {"name": "engines_nao_objeto", "engines": j(["a"]), "kimi_config": "providers = 3\n"},
        {"name": "kimi_com_bom", "kimi_config": "﻿" + kimi_ok},
        {"name": "kimi_home_e_engines_pelo_ambiente", "kimi_config_at": "kimi-alt", "engines_at": "motores.json",
         "kimi_config": kimi_ok, "engines": j({"m": {"base_url": "https://a", "api_key": "k", "model": "x"}})},
        {"name": "mesma_chave_nos_dois", "kimi_config": kimi_ok,
         "engines": j({"k": {"base_url": "https://api.kimi.com/coding/v1", "api_key": "sk-kimi", "model": "k3"}})},
    ]


def run_sources(case: dict, root: Path) -> dict:
    home = root / case["name"]
    claude = home / ".claude"
    claude.mkdir(parents=True)
    env = {"HOME": str(home)}
    kimi_dir = home / (case.get("kimi_config_at") or ".kimi-code")
    if case.get("kimi_config_at"):
        env["KIMI_CODE_HOME"] = str(kimi_dir)
    engines_file = home / case["engines_at"] if case.get("engines_at") else claude / "engines.json"
    if case.get("engines_at"):
        env["CP_ENGINES_FILE"] = str(engines_file)
    writes = {"kimi_config": kimi_dir / "config.toml", "engines": engines_file,
              "opencode": claude / ".hangar-opencode.json",
              "opencode_legacy": claude / ".claude-pocket-opencode.json",
              "apelidos": claude / ".hangar-apelidos.json",
              "apelidos_legacy": claude / ".claude-pocket-apelidos.json"}
    for field, path in writes.items():
        if case.get(field) is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(case[field], encoding="utf-8")
    env.update(case.get("env") or {})
    readers = {}

    def record(kind):
        def fn(*args):
            readers.setdefault("_current", []).append({"tipo": kind, "args": list(args)})
            return "indisponivel", [], "x"
        return fn

    clean = {k: v for k, v in os.environ.items()
             if k not in ("KIMI_CODE_HOME", "CP_ENGINES_FILE", "OPENCODE_GO_WORKSPACE_ID", "OPENCODE_GO_AUTH_COOKIE")}
    with patch.dict(os.environ, {**clean, **env}, clear=True), \
            patch.object(cotas, "_ler_kimi", record("kimi")), \
            patch.object(cotas, "_ler_commandcode", record("commandcode")), \
            patch.object(opencode_cota, "ler", lambda w, c: (readers.setdefault("_current", []).append(
                {"tipo": "opencode", "args": [w, c]}), ("indisponivel", [], "x"))[1]):
        try:
            sources = cotas._other_sources()
            facts = cotas.quota_facts("sources", [])
        except Exception as error:  # noqa: BLE001 - o golden grava que a enumeração falhou
            sources, facts = None, {"erro": type(error).__name__}
        rows = []
        for source in sources or []:
            readers["_current"] = []
            source.ler()
            rows.append({"id": source.chave, "label": source.label, "provedor": source.provedor,
                         "ativa": source.ativa, "leitor": readers["_current"][0]})
    files = {field: case[field] for field in writes if case.get(field) is not None}
    return {"name": case["name"], "files": files, "env": case.get("env") or {},
            "kimi_config_at": case.get("kimi_config_at"), "engines_at": case.get("engines_at"),
            "expected": ({"erro": facts["erro"]} if sources is None
                         else {"sources": rows, "aliases": facts["aliases"]})}


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    closed = f"http://127.0.0.1:{_closed_port()}"
    readers = [run_reader(case, base, closed) for case in reader_cases(base)]
    server.shutdown()
    with tempfile.TemporaryDirectory() as tmp:
        sources = [run_sources(case, Path(tmp)) for case in source_cases()]
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True,
                            text=True, check=True).stdout.strip()
    document = {"origem": {"commit": commit, "comando": "cd backend && uv run python tests/fixtures/contract/gen_quotas_other.py",
                           "python": sys.version.split()[0]},
                "tz": TZ, "now": NOW, "readers": readers, "sources": sources}
    GOLDEN.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{GOLDEN}: {len(readers)} leituras, {len(sources)} enumerações")


if __name__ == "__main__":
    main()
