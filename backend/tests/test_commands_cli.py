import asyncio
import threading

from app import commands as C
from app.commands import list_commands
from tests.test_claude_headless import adapter, sidecar  # noqa: F401 — fixtures


def _by_name(cmds):
    return {c.name: c for c in cmds}


def test_headless_guarda_a_lista_do_initialize_e_os_so_de_tui_do_init(adapter, monkeypatch):  # noqa: F811
    sess = adapter._sessions["s1"]

    async def ctrl(s, subtype, **kw):
        return {"commands": [{"name": "usage", "description": "Show usage", "argumentHint": ""},
                             {"name": "doctor", "description": "x"}, "lixo"]}
    monkeypatch.setattr(adapter, "_ctrl", ctrl)
    monkeypatch.setattr(adapter, "_agendar_cota", lambda s: None)

    async def drenar(s):
        pass
    monkeypatch.setattr(adapter, "_drenar_fim_de_turno", drenar)

    async def fluxo():
        assert adapter.comandos("s1") == (None, frozenset())
        await adapter._esperar_initialize(sess)
        await adapter._on_event(sess, {"type": "system", "subtype": "init", "session_id": sess.sid,
                                       "terminal_slash_commands": ["doctor", "color"]})
    asyncio.run(fluxo())
    cli, so_tui = adapter.comandos("s1")
    assert [c["name"] for c in cli] == ["usage", "doctor"]
    assert so_tui == {"doctor", "color"}


def test_lista_da_cli_manda_nos_nomes_e_descricao_local_vem_primeiro(tmp_path):
    proj = tmp_path / "proj"
    (proj / ".claude" / "commands").mkdir(parents=True)
    (proj / ".claude" / "commands" / "deploy.md").write_text("---\ndescription: Sobe\n---\n", encoding="utf-8")
    cli = [
        {"name": "clear", "description": "Clear conversation history"},
        {"name": "usage", "description": "Show plan usage limits", "argumentHint": ""},
        {"name": "security-review"},
        {"name": "ecc:hookify", "description": "Create hooks (ecc)", "argumentHint": "[regra]"},
        {"name": "doctor", "description": "Diagnose"},
    ]
    by = _by_name(list_commands(str(proj), cli, frozenset({"doctor"}), com_tui=False))
    assert by["clear"].description == "Limpa o histórico da conversa" and by["clear"].destructive
    assert by["usage"].description == "Show plan usage limits" and by["usage"].argumentHint is None
    assert by["security-review"].description is None and by["security-review"].source == "builtin"
    assert by["ecc:hookify"].source == "plugin" and by["ecc:hookify"].argumentHint == "[regra]"
    assert by["deploy"].source == "skill"           # projeto entra: a sonda roda fora dele
    assert "doctor" not in by                        # só-de-TUI fora
    assert "quit" not in by and "btw" not in by      # sem terminal: fixo de TUI não aparece

    # Com terminal: a CLI não informa os comandos só de TUI, então os fixos somam.
    tui = _by_name(list_commands(str(proj), cli))
    assert {"btw", "resume", "login", "permissions", "usage", "ecc:hookify"} <= set(tui)
    assert tui["quit"].destructive and tui["usage"].description == "Show plan usage limits"


def test_sonda_roda_uma_vez_e_depois_serve_do_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(C, "_cache_path", lambda: tmp_path / "slash.json")
    assinatura = {"v": "bin|1|2"}
    monkeypatch.setattr(C, "_chave_cli", lambda cdir: assinatura["v"])
    monkeypatch.setattr(C, "_sonda_falhou_em", {})
    chamadas = []
    liberar = threading.Event()

    def sondar(cdir):
        chamadas.append(cdir)
        liberar.wait(5)
        return [{"name": "usage"}]
    monkeypatch.setattr(C, "sondar_cli", sondar)
    assert C.comandos_da_cli(None) is None
    assert C.comandos_da_cli(None) is None           # em voo: não dispara outra
    liberar.set()
    for _ in range(100):
        if C._cache_path().exists() and not C._sonda_em_voo:
            break
        threading.Event().wait(0.02)
    assert C.comandos_da_cli(None) == [{"name": "usage"}]
    assert chamadas == [None]
    # Plugin instalado muda a assinatura: o cache velho não serve mais e sai outra sonda.
    assinatura["v"] = "bin|1|3"
    assert C.comandos_da_cli(None) is None
    for _ in range(100):
        if not C._sonda_em_voo:
            break
        threading.Event().wait(0.02)
    assert chamadas == [None, None]


def test_sonda_que_falha_loga_e_nao_repete_na_hora(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(C, "_cache_path", lambda: tmp_path / "slash.json")
    monkeypatch.setattr(C, "_chave_cli", lambda cdir: "bin|1|2")
    monkeypatch.setattr(C, "_sonda_falhou_em", {})
    chamadas = []

    def sondar(cdir):
        chamadas.append(cdir)
        raise RuntimeError("claude saiu sem responder")
    monkeypatch.setattr(C, "sondar_cli", sondar)
    caplog.set_level("WARNING", logger="hangar.commands")
    assert C.comandos_da_cli(None) is None
    for _ in range(100):
        if not C._sonda_em_voo:
            break
        threading.Event().wait(0.02)
    assert C.comandos_da_cli(None) is None
    assert chamadas == [None]
    assert "sonda da CLI falhou" in caplog.text
