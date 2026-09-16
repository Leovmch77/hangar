import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app import costs_cache as cc, costs_claude_transcript as ct, pricing, uso_areas, uso_report
from app.uso_claude import comando_bash

T0 = "2026-09-10T12:00:00Z"


@pytest.fixture(autouse=True)
def _limpo(tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(pricing, "_CACHE_DIR", tmp_path / "pricing")
    # O mapa real da máquina (~/.hangar/uso-areas.json) não pode mudar o resultado do teste.
    monkeypatch.setattr(uso_areas, "_arquivo", lambda: tmp_path / "uso-areas.json")
    uso_areas.recarregar()
    ct.invalidar_cache()
    yield
    ct.invalidar_cache()
    uso_areas.recarregar()


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
    assert tudo.conta == []
    so_a = uso_report.montar(uso, tokens, "all", conta="anthropic:a")
    assert so_a.conta == ["anthropic:a"]
    # Várias contas de uma vez: soma das duas, sem duplicar o seletor.
    duas = uso_report.montar(uso, tokens, "all", conta=["anthropic:a", "anthropic:b"])
    assert duas.by_skill[0].chamadas == 2 and len(duas.by_conta) == 2
    assert so_a.by_skill[0].chamadas == 1 and so_a.by_skill[0].input == 110   # m2 + m3, uma conta
    assert so_a.by_agente[0].chamadas == 1 and so_a.by_agente[0].input == 1000   # filho da conta certa
    assert [b.key for b in so_a.by_conta] == [b.key for b in tudo.by_conta]        # seletor inteiro


def _png_b64(largura: int, altura: int) -> str:
    import base64, struct
    cabecalho = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", largura, altura)
    return base64.b64encode(cabecalho + b"\x08\x06\x00\x00\x00" + b"x" * 40).decode()


def test_imagens_enviadas_e_lidas_com_tokens_pelos_pixels(tmp_path):
    img = lambda w, h: {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _png_b64(w, h)}}
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user([{"type": "text", "text": "olha"}, img(1500, 750)], "p1"),
        _assistant([_tool_use("Read", {"file_path": "/x.png"}, "t1")], "m1"),
        _user([{"type": "tool_result", "tool_use_id": "t1", "content": [img(750, 750)]}], "p1"),
        _user([{"type": "text", "text": "e essa"}, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "abcd"}}], "p2"),
    ])
    r = uso_report.montar(ct.varrer_uso(tmp_path), [], "all")
    im = {b.key: b for b in r.by_imagem}
    assert im["enviada"].chamadas == 2
    assert im["enviada"].ctx_tokens_est == 1500 * 750 // 750 + 0     # jpeg conta, sem estimativa
    assert im["lida:Read"].chamadas == 1 and im["lida:Read"].ctx_tokens_est == 750
    assert r.totals.chamadas == 4                                     # Read + 3 imagens


def test_filtros_projeto_modelo_plugin_e_serie_diaria_com_foco(tmp_path):
    def linha(dia, cwd, model, skill):
        return [
            {**_user("x", f"p-{dia}-{skill}", ts=f"{dia}T12:00:00Z"), "cwd": cwd},
            {**_assistant([_tool_use("Skill", {"skill": skill}, f"t-{dia}-{skill}")], f"m-{dia}-{skill}",
                          ts=f"{dia}T12:00:01Z", model=model), "cwd": cwd},
        ]
    _escrever(tmp_path / "p" / "s1.jsonl",
              linha("2026-09-01", "/a", "claude-opus-5", "ecc:x")
              + linha("2026-09-02", "/b", "claude-sonnet-5", "acme:y")
              + linha("2026-09-02", "/a", "claude-opus-5", "acme:y"))
    uso = ct.varrer_uso(tmp_path)
    tudo = uso_report.montar(uso, [], "all")
    assert [b.key for b in tudo.by_projeto] == ["/a", "/b"] or {b.key for b in tudo.by_projeto} == {"/a", "/b"}
    assert {b.key for b in tudo.by_modelo} == {"claude-opus-5", "claude-sonnet-5"}
    assert [(b.key, b.chamadas) for b in tudo.by_day] == [("2026-09-01", 1), ("2026-09-02", 2)]
    so_a = uso_report.montar(uso, [], "all", projeto="/a")
    assert so_a.totals.chamadas == 2 and {b.key for b in so_a.by_projeto} == {"/a", "/b"}
    so_sonnet = uso_report.montar(uso, [], "all", modelo="claude-sonnet-5")
    assert [b.key for b in so_sonnet.by_skill] == ["acme:y"] and so_sonnet.totals.chamadas == 1
    so_acme = uso_report.montar(uso, [], "all", plugin="acme")
    assert {b.key for b in so_acme.by_skill} == {"acme:y"} and so_acme.plugin == ["acme"]
    foco = uso_report.montar(uso, [], "all", foco="ecc:x")
    assert [(b.key, b.chamadas) for b in foco.by_day] == [("2026-09-01", 1)]
    assert len(foco.by_skill) == 2                                   # foco só recorta a série


def test_uso_sobrevive_ao_cache_em_disco(tmp_path):
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _assistant([_tool_use("Read", {"file_path": "/a"}, "t1")], "m1"),
    ])
    antes = ct.varrer_uso(tmp_path)
    ct.invalidar_cache()
    assert ct.varrer_uso(tmp_path) == antes
    assert antes[0].session_id == "p/s1"


def _areas(uso) -> dict[str, tuple]:
    out: dict[str, list] = {}
    for l in uso:
        if l.tipo == "area":
            a = out.setdefault(l.nome, [0, 0, 0, 0])
            for i, v in enumerate((l.chamadas, l.input, l.output, l.cache_write)):
                a[i] += v
    return {k: tuple(v) for k, v in out.items()}


def test_turno_divide_o_uso_real_pelas_areas_das_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(pricing, "rate_for", lambda m: pricing.Rate(
        provider="anthropic", input=1.0, output=10.0, cache_read=0.1, cache_write=1.25, origin="teste",
        cache_estimado=False))
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("mexe no front e no back", "p1"),
        _assistant([_tool_use("Read", {"file_path": "/repo/frontend/src/A.svelte"}, "t1")], "m1",
                   _usage(i=100, o=10)),
        _assistant([_tool_use("Edit", {"file_path": "/repo/backend/app/x.py"}, "t2")], "m2",
                   _usage(i=200, o=20)),
        # Caminho relativo ao cwd; `/dev/null` fora do repositório não é área.
        _assistant([_tool_use("Bash", {"command": "uv run pytest backend/tests/test_x.py 2>/dev/null"}, "t3")],
                   "m3", _usage(i=300, o=30, cw=10)),
        # Mesma resposta, usage CRESCENDO (streaming): vale a última linha, como no leitor de custos.
        _assistant([{"type": "text", "text": "..."}], "m3", _usage(i=300, o=50, cw=10)),
        # Fora do repositório: outros.
        _assistant([_tool_use("Read", {"file_path": "/tmp/print.png"}, "t4")], "m4", _usage(i=0, o=0)),
        _user("e aí?", "p2"),
        _assistant([{"type": "text", "text": "só conversa"}], "m5", _usage(i=50, o=5)),
        _user("olha o banco", "p3"),
        _assistant([_tool_use("Skill", {"skill": "acme:database"}, "t6")], "m6", _usage(i=70, o=7)),
    ])
    uso = ct.varrer_uso(tmp_path)
    areas = _areas(uso)
    # p1: front 1, back 2 (Edit + Bash), outros 1 → 600 de input em quartos; o cache write (10)
    # não divide exato e o maior resto fecha a soma.
    assert areas["front"][:3] == (1, 150, 20) and areas["back"][:3] == (2, 300, 40)
    assert areas["outros"][:3] == (1, 150, 20)
    assert areas["front"][3] + areas["back"][3] + areas["outros"][3] == 10 and areas["back"][3] == 5
    assert areas["conversa"] == (0, 50, 5, 0)
    assert areas["banco"] == (1, 70, 7, 0)
    assert sum(a[1] for a in areas.values()) == 100 + 200 + 300 + 50 + 70

    r = uso_report.montar(uso, [], "all")
    por_area = {b.key: b for b in r.by_area}
    assert por_area["back"].cost == pytest.approx(300 / 1e6 + 40 / 1e6 * 10 + 5 / 1e6 * 1.25)
    # A área não soma no total do relatório: o custo dela já é o das skills/agentes/conversa.
    assert r.totals.cost == pytest.approx(sum(b.cost for b in r.by_skill))
    assert {(b.key, b.label) for b in r.by_area_dia} >= {("2026-09-10|front", "front")}
    foco = uso_report.montar(uso, [], "all", foco="back")
    assert [(b.key, b.chamadas) for b in foco.by_day] == [("2026-09-10", 2)]
    assert foco.by_day[0].cost == pytest.approx(por_area["back"].cost)


def test_mapa_por_projeto_vence_o_padrao_e_troca_de_mapa_rele_o_cache(tmp_path):
    _escrever(tmp_path / "p" / "s1.jsonl", [
        _user("x", "p1"),
        _assistant([_tool_use("Read", {"file_path": "/repo/src/app/page.ts"}, "t1")], "m1"),
    ])
    assert set(_areas(ct.varrer_uso(tmp_path))) == {"outros"}
    (tmp_path / "uso-areas.json").write_text(json.dumps(
        {"projetos": {"repo": [["front", ["src/app/*"]]]}}), encoding="utf-8")
    # Reinício do backend: mapa relido, memória do cache vazia, disco com a assinatura antiga.
    uso_areas.recarregar()
    ct.invalidar_cache()
    assert set(_areas(ct.varrer_uso(tmp_path))) == {"front"}


def test_arquivo_de_outro_repositorio_usa_a_raiz_dele(tmp_path):
    (tmp_path / "hangar" / ".git").mkdir(parents=True)
    (tmp_path / "wt" / "hangar-t1" / ".git").mkdir(parents=True)
    cwd = str(tmp_path / "hangar")
    # Worktree fora do cwd: `frontend/` é relativo à raiz DELE, não "fora do projeto".
    fora = str(tmp_path / "wt" / "hangar-t1" / "frontend" / "x.ts")
    assert uso_areas.area_do_caminho(fora, cwd, uso_areas.regras_de(cwd)) == "front"
    assert uso_areas.area_do_caminho(str(tmp_path / "solto" / "a.md"), cwd, uso_areas.regras_de(cwd)) == "outros"


@pytest.mark.parametrize("caminho,esperado", [
    ("/r/backend/migrations/001.sql", "banco"),
    ("/r/backend/app/api.py", "back"),
    ("/r/frontend/README.md", "docs"),
    ("/r/scripts/instalar.py", "infra"),
    ("/r/deploy/Dockerfile", "infra"),
    ("/r/packages/core/src/uso.ts", "front"),
    ("/r/qualquer.txt", "outros"),
])
def test_area_padrao_por_pasta_e_extensao(caminho, esperado):
    assert uso_areas.area_do_caminho(caminho, "/r", uso_areas.PADRAO) == esperado
