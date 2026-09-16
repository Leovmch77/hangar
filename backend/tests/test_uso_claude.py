import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app import costs_cache as cc, costs_claude_transcript as ct, pricing, uso_report
from app.uso_claude import comando_bash

T0 = "2026-09-10T12:00:00Z"


@pytest.fixture(autouse=True)
def _limpo(tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(pricing, "_CACHE_DIR", tmp_path / "pricing")
    ct.invalidar_cache()
    yield
    ct.invalidar_cache()


def _escrever(p: Path, linhas: list[dict]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(json.dumps(x) for x in linhas) + "\n", encoding="utf-8")


def _usage(i=10, o=5, cw=0, cr=0):
    return {"input_tokens": i, "output_tokens": o, "cache_creation_input_tokens": cw,
            "cache_read_input_tokens": cr}


def _assistant(blocos, mid, usage=None, ts=T0, model="claude-opus-5"):
    return {"type": "assistant", "timestamp": ts, "cwd": "/repo", "requestId": "r" + mid,
            "message": {"id": mid, "model": model, "usage": usage or _usage(), "content": blocos}}


def _user(conteudo, prompt_id, ts=T0, **extra):
    return {"type": "user", "timestamp": ts, "cwd": "/repo", "promptId": prompt_id,
            "message": {"role": "user", "content": conteudo}, **extra}


def _tool_use(nome, entrada, tid):
    return {"type": "tool_use", "id": tid, "name": nome, "input": entrada}


def _tool_result(tid, texto):
    return {"type": "tool_result", "tool_use_id": tid, "content": texto}


def test_conta_tools_bash_mcp_e_mede_o_resultado(tmp_path):
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("faz", "p1"),
        _assistant([_tool_use("Bash", {"command": "cd x && git status"}, "t1")], "m1"),
        _user([_tool_result("t1", "x" * 400)], "p1"),
        _assistant([_tool_use("Bash", {"command": "TOKEN=$(grep a b | cut -d= -f2); curl u"}, "t2")], "m2"),
        _user([_tool_result("t2", [{"type": "text", "text": "y" * 100}])], "p1"),
        _assistant([_tool_use("mcp__hangar__nav", {"url": "u"}, "t3")], "m3"),
        _user([_tool_result("t3", "z" * 40)], "p1"),
        _assistant([_tool_use("Read", {"file_path": "/f"}, "t4")], "m4"),
        _user([_tool_result("t4", "w" * 8)], "p1"),
    ])
    r = uso_report.montar(ct.varrer_uso(tmp_path), [], "all")
    tools = {b.key: b for b in r.by_tool}
    assert tools["Bash"].chamadas == 2 and tools["Bash"].ctx_chars == 500
    assert tools["Read"].chamadas == 1 and tools["Read"].ctx_chars == 8
    assert tools["Read"].ctx_tokens_est == 2
    bash = {b.key: b for b in r.by_bash}
    assert bash["git"].chamadas == 1 and bash["git"].ctx_chars == 400
    assert bash["grep"].chamadas == 1 and bash["grep"].ctx_chars == 100
    mcp = {b.key: b for b in r.by_mcp}
    assert mcp["hangar"].chamadas == 1 and mcp["hangar"].ctx_chars == 40
    assert r.totals.chamadas == 4          # bash/mcp não duplicam a chamada do tool
    assert r.totals.ctx_chars == 548
    assert r.totals.sessions == 1


@pytest.mark.parametrize("cmd, esperado", [
    ("git status", "git"),
    ("cd /x && npm run build", "npm"),
    ("(cd sub && uv run pytest)", "uv"),
    ("CP_X=1 FOO=bar python3 -c 1", "python3"),
    ("TOKEN=$(grep a .env | cut -d= -f2); curl -s u", "grep"),
    ("sudo systemctl restart x", "systemctl"),
    ("timeout 300 npx vitest run", "npx"),
    ("/usr/bin/see img.png", "see"),
    ("for i in 1 2; do echo $i; done", "for"),
    ("", "?"),
])
def test_comando_bash(cmd, esperado):
    assert comando_bash(cmd) == esperado


def test_skill_conta_pelo_tool_e_pela_barra_e_o_custo_vai_ate_a_troca_de_prompt(tmp_path, monkeypatch):
    monkeypatch.setattr(pricing, "rate_for", lambda m: pricing.Rate(
        provider="anthropic", input=1.0, output=10.0, cache_read=0.1, cache_write=1.25, origin="teste",
        cache_estimado=False))
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("usa a skill", "p1"),
        # Resposta ANTES da skill: não é dela.
        _assistant([{"type": "text", "text": "vou"}], "m0", _usage(i=1000)),
        _assistant([_tool_use("Skill", {"skill": "acme:kubectl"}, "t1")], "m1", _usage(i=100, o=10)),
        # Bloco repetido da MESMA resposta: usage não soma de novo.
        _assistant([{"type": "text", "text": "..."}], "m1", _usage(i=100, o=10)),
        _user([_tool_result("t1", "# SKILL\n" + "k" * 992)], "p1"),
        _assistant([{"type": "text", "text": "feito"}], "m2", _usage(i=200, o=20)),
        # Prompt novo: a janela da skill fechou.
        _user("outra coisa", "p2"),
        _assistant([{"type": "text", "text": "ok"}], "m3", _usage(i=5000)),
        # Skill por barra: <command-name> + texto expandido (isMeta, mesmo promptId).
        _user("<command-message>x</command-message>\n<command-name>/ecc:cost-report</command-name>", "p3"),
        _user([{"type": "text", "text": "e" * 300}], "p3", isMeta=True),
        _assistant([{"type": "text", "text": "relatório"}], "m4", _usage(i=50, o=5)),
    ])
    r = uso_report.montar(ct.varrer_uso(tmp_path), [], "all")
    skills = {b.key: b for b in r.by_skill}
    k = skills["acme:kubectl"]
    assert k.chamadas == 1 and k.plugin == "acme"
    assert k.ctx_chars == 1000
    # Só m2: m0 é antes, m1 é a resposta que DECIDE chamar (não é execução) e m3 é outro prompt.
    assert (k.input, k.output) == (200, 20)
    assert k.cost == pytest.approx(200 / 1e6 * 1.0 + 20 / 1e6 * 10.0)
    c = skills["ecc:cost-report"]
    assert c.chamadas == 1 and c.plugin == "ecc" and c.ctx_chars == 300
    assert (c.input, c.output) == (50, 5)
    # Origem exata: a ferramenta Skill é o modelo; a barra é o usuário.
    assert (k.chamadas, k.pedidas) == (1, 0)
    assert (c.chamadas, c.pedidas) == (1, 1)
    plugins = {b.key: b for b in r.by_plugin}
    assert plugins["acme"].chamadas == 1 and plugins["ecc"].chamadas == 1
    assert (plugins["acme"].input, plugins["acme"].cost) == (200, pytest.approx(k.cost))
    assert r.totals.cost == pytest.approx(k.cost + c.cost)


def test_agente_liga_ao_transcript_filho_pelo_agentId(tmp_path, monkeypatch):
    monkeypatch.setattr(pricing, "rate_for", lambda m: pricing.Rate(
        provider="anthropic", input=1.0, output=10.0, cache_read=0.1, cache_write=1.25, origin="teste",
        cache_estimado=False))
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("pesquisa", "p1"),
        _assistant([_tool_use("Agent", {"subagent_type": "Explore", "prompt": "x"}, "t1")], "m1"),
        _user([_tool_result("t1", "lançado")], "p1", toolUseResult={"agentId": "abc123", "status": "async_launched"}),
        _assistant([_tool_use("Agent", {"prompt": "y"}, "t2")], "m2"),
        _user([_tool_result("t2", "lançado")], "p1", toolUseResult={"agentId": "def456"}),
    ])
    _escrever(tmp_path / "p" / "s1" / "subagents" / "agent-abc123.jsonl", [
        _assistant([{"type": "text", "text": "achei"}], "a1", _usage(i=1000, o=100)),
    ])
    uso = ct.varrer_uso(tmp_path)
    tokens = [__import__("app.costs_sources", fromlist=["UsageRow"]).UsageRow(
        ts=u.ts, source="claude", provider="anthropic", model=u.model, project=u.cwd,
        session_id=u.session_id, input=u.input, output=u.output, cache_write=u.cache_write,
        cache_read=u.cache_read, subagente=u.subagente) for u in ct.varrer(tmp_path)]
    r = uso_report.montar(uso, tokens, "all")
    ag = {b.key: b for b in r.by_agente}
    assert ag["Explore"].chamadas == 1
    assert (ag["Explore"].input, ag["Explore"].output) == (1000, 100)
    assert ag["Explore"].cost == pytest.approx(1000 / 1e6 + 100 / 1e6 * 10)
    assert ag["general-purpose"].chamadas == 1 and ag["general-purpose"].cost == 0


def test_agente_pedido_ou_sozinho_pela_heuristica_do_prompt(tmp_path):
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("dispara um subagente pra mapear isso", "p1"),
        _assistant([_tool_use("Agent", {"subagent_type": "Explore", "prompt": "x"}, "t1")], "m1"),
        _user([_tool_result("t1", "ok")], "p1", toolUseResult={"agentId": "a1"}),
        _user("conserta o bug do login", "p2"),
        _assistant([_tool_use("Agent", {"subagent_type": "Explore", "prompt": "y"}, "t2")], "m2"),
        _user([_tool_result("t2", "ok")], "p2", toolUseResult={"agentId": "a2"}),
        # Prompt em blocos (imagem + texto) também conta; o texto expandido (isMeta) não.
        _user([{"type": "text", "text": "roda os agents em paralelo"}], "p3"),
        _user([{"type": "text", "text": "sem agente nenhum aqui"}], "p3", isMeta=True),
        _assistant([_tool_use("Agent", {"subagent_type": "Explore", "prompt": "z"}, "t3")], "m3"),
    ])
    r = uso_report.montar(ct.varrer_uso(tmp_path), [], "all")
    ag = {b.key: b for b in r.by_agente}
    assert (ag["Explore"].chamadas, ag["Explore"].pedidas) == (3, 2)


def test_contexto_mede_rendered_ou_content_e_ignora_stdout_de_hook(tmp_path):
    att = lambda a, **extra: {"type": "attachment", "timestamp": T0, "attachment": a, **extra}
    _escrever(tmp_path / "p" / "s1.jsonl", [
        att({"type": "instructions"}, rendered=[{"content": "i" * 1000}]),
        att({"type": "hook_success", "hookName": "SessionStart:startup",
             "content": "PONYTAIL MODE ACTIVE — level: full\nblá", "stdout": "s" * 5000},
            rendered=[{"content": "P" * 40}]),
        # Hook que só tem stdout: nada entrou no contexto.
        att({"type": "hook_success", "hookName": "PostToolUse:Edit", "content": "", "stdout": "s" * 70000}),
        # CLI antiga, sem `rendered`: mede o content.
        att({"type": "hook_additional_context", "hookName": "UserPromptSubmit",
             "content": ["[skill-suggester] Prompt casa com skills\n- x"]}),
        att({"type": "total_tokens_reminder", "text": "t" * 90}),
        _user("oi", "p1"),
        _assistant([{"type": "text", "text": "oi"}], "m1"),
    ])
    r = uso_report.montar(ct.varrer_uso(tmp_path), [], "all")
    ctx = {b.key: b for b in r.by_contexto}
    assert ctx["instructions"].ctx_chars == 1000
    pony = ctx["hook_success:SessionStart:startup · PONYTAIL MODE ACTIVE — level: full"]
    assert pony.ctx_chars == 40 and pony.plugin == "ponytail"
    assert ctx["hook_success:PostToolUse:Edit"].ctx_chars == 0
    assert ctx["hook_success:PostToolUse:Edit"].chamadas == 1
    sug = ctx["hook_additional_context:UserPromptSubmit · [skill-suggester] Prompt casa com skills"]
    assert sug.ctx_chars == len("[skill-suggester] Prompt casa com skills\n- x") and sug.plugin == "skill-suggester"
    assert ctx["total_tokens_reminder"].ctx_chars == 90
    assert {b.key for b in r.by_plugin} == {"skill-suggester", "ponytail"}


def test_periodo_corta_pelo_dia_local_e_o_eco_volta(tmp_path):
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _assistant([_tool_use("Read", {"file_path": "/a"}, "t1")], "m1", ts="2026-09-01T12:00:00Z"),
        _assistant([_tool_use("Read", {"file_path": "/b"}, "t2")], "m2", ts="2026-09-10T12:00:00Z"),
    ])
    agora = datetime(2026, 9, 10, 15, tzinfo=timezone.utc)
    r = uso_report.montar(ct.varrer_uso(tmp_path), [], "7d", now=agora)
    assert r.by_tool[0].chamadas == 1
    assert r.applied.period == "7d"
    assert uso_report.montar(ct.varrer_uso(tmp_path), [], "all", now=agora).by_tool[0].chamadas == 2


def test_filtro_por_conta_corta_tudo_menos_a_lista_de_contas(tmp_path, monkeypatch):
    from dataclasses import replace
    from app import costs_sources as cs
    monkeypatch.setattr(pricing, "rate_for", lambda m: pricing.Rate(
        provider="anthropic", input=1.0, output=10.0, cache_read=0.1, cache_write=1.25, origin="teste",
        cache_estimado=False))
    monkeypatch.setitem(cs._ROTULOS, "anthropic:a", "a@x.com")
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("x", "p1"),
        _assistant([_tool_use("Skill", {"skill": "orquestrar"}, "t1")], "m1"),
        _user([_tool_result("t1", "k")], "p1"),
        _assistant([{"type": "text", "text": "ok"}], "m2", _usage(i=100, o=0)),
        _assistant([_tool_use("Agent", {"subagent_type": "Explore", "prompt": "x"}, "t2")], "m3"),
        _user([_tool_result("t2", "l")], "p1", toolUseResult={"agentId": "ag1"}),
    ])
    _escrever(tmp_path / "p" / "s1" / "subagents" / "agent-ag1.jsonl", [
        _assistant([{"type": "text", "text": "achei"}], "a1", _usage(i=1000, o=0)),
    ])
    linhas = ct.varrer_uso(tmp_path)
    uso = [replace(l, conta="anthropic:a") for l in linhas] + [replace(l, conta="anthropic:b") for l in linhas]
    tokens = []
    for conta in ("anthropic:a", "anthropic:b"):
        tokens += [cs.UsageRow(ts=u.ts, source="claude", provider=conta, model=u.model, project=u.cwd,
                               session_id=u.session_id, input=u.input, output=u.output,
                               cache_write=u.cache_write, cache_read=u.cache_read,
                               subagente=u.subagente, account_id=conta) for u in ct.varrer(tmp_path)]
    tudo = uso_report.montar(uso, tokens, "all")
    assert {b.key: b.label for b in tudo.by_conta} == {"anthropic:a": "a@x.com", "anthropic:b": None}
    assert tudo.by_skill[0].chamadas == 2 and tudo.by_agente[0].chamadas == 2
    assert tudo.conta is None
    so_a = uso_report.montar(uso, tokens, "all", conta="anthropic:a")
    assert so_a.conta == "anthropic:a"
    assert so_a.by_skill[0].chamadas == 1 and so_a.by_skill[0].input == 110   # m2 + m3, uma conta
    assert so_a.by_agente[0].chamadas == 1 and so_a.by_agente[0].input == 1000   # filho da conta certa
    assert [b.key for b in so_a.by_conta] == [b.key for b in tudo.by_conta]        # seletor inteiro


def test_uso_sobrevive_ao_cache_em_disco(tmp_path):
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _assistant([_tool_use("Read", {"file_path": "/a"}, "t1")], "m1"),
    ])
    antes = ct.varrer_uso(tmp_path)
    ct.invalidar_cache()
    assert ct.varrer_uso(tmp_path) == antes
    assert antes[0].session_id == "p/s1"
