"""Claude sem terminal: a máquina de estados do stdout e o que vai pro stdin, sem processo real.
O processo é trocado por um stub que só guarda o que seria escrito; os eventos são os do
stream-json medido contra a CLI (docs/research/claude-sem-terminal-monocode.md)."""
import asyncio
import base64
import json

import pytest

from app.adapters.claude_headless import adapter as A
from app.adapters.claude_headless import sessions as S
from app.adapters.claude_headless.adapter import ClaudeHeadlessAdapter, _Sessao
from app.adapters.preview_push import PushPreviewSource

_ESFORCO_PADRAO_REAL = A._esforco_padrao


class _Proc:
    returncode = None
    pid = 4242


@pytest.fixture
def sidecar(tmp_path, monkeypatch):
    from app import pqueue
    # Toda nota local vai pra PromptQueue("s1"): sem isto os testes do /effort escreviam na fila
    # REAL de uma sessão "s1", e o test_sse (mesmo nome) lia essas bolhas antes do `reset`.
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(PushPreviewSource, "_sources", {})
    monkeypatch.setattr(A, "_dir_marcadores", lambda meta: tmp_path / "state")
    # Sem config_dir o esforço padrão viria do ~/.claude/settings.json de quem roda os testes.
    monkeypatch.setattr(A, "_esforco_padrao", lambda config_dir: None)
    return S.save("s1", str(tmp_path), "11111111-1111-1111-1111-111111111111", model="haiku", permission_mode="manual")


@pytest.fixture
def adapter(sidecar):
    ad = ClaudeHeadlessAdapter()
    sess = _Sessao("s1", sidecar)
    sess.proc = _Proc()
    ad._sessions["s1"] = sess
    escritos: list[dict] = []

    async def _write(s, obj):
        escritos.append(obj)
    ad._write = _write  # type: ignore[method-assign]
    ad.escritos = escritos  # type: ignore[attr-defined]
    return ad


def _run(coro):
    return asyncio.run(coro)


def test_prompt_vai_pro_stdin_e_turno_fecha_no_result(adapter):
    async def fluxo():
        assert await adapter.send_prompt("s1", "oi") == "sent"
        sess = adapter._sessions["s1"]
        assert sess.state == "working" and not await adapter.deliverable("s1")
        await adapter._on_event(sess, {"type": "system", "subtype": "status", "status": "requesting"})
        assert sess.label == "Pensando…"
        await adapter._on_event(sess, {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "text"}}})
        await adapter._on_event(sess, {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}})
        assert PushPreviewSource.get("s1").text == "ok"
        await adapter._on_event(sess, {"type": "assistant", "message": {
            "content": [{"type": "text", "text": "ok"}],
            "usage": {"input_tokens": 2, "cache_read_input_tokens": 39000, "output_tokens": 4}}})
        assert PushPreviewSource.get("s1").text == ""
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "num_turns": 1, "total_cost_usd": 0.04,
                                       "usage": {"input_tokens": 2, "cache_read_input_tokens": 39000, "output_tokens": 4},
                                       "modelUsage": {"claude-haiku-4-5": {"contextWindow": 200000}}})
        assert sess.state == "idle" and await adapter.deliverable("s1")
        assert adapter.status_line(sess) == "🤖 Haiku │ 💬 39k/4 39k/200k │ 💵 $0.04"
    _run(fluxo())
    msg = adapter.escritos[0]
    assert msg["type"] == "user" and msg["message"]["content"] == [{"type": "text", "text": "oi"}]


def test_rotulo_do_spinner_conta_tempo_tokens_e_pensamento_como_a_tui(adapter, monkeypatch):
    relogio = [1000.0]
    monkeypatch.setattr(A.time, "monotonic", lambda: relogio[0])
    sess = adapter._sessions["s1"]

    def stream(ev):
        return adapter._on_event(sess, {"type": "stream_event", "event": ev})

    async def fluxo():
        assert await adapter.send_prompt("s1", "oi") == "sent"
        assert adapter._evento(sess).label == "Trabalhando… (0s)"
        # 1ª chamada: pensa 2s, escreve, fecha com o output_tokens real.
        await stream({"type": "message_start", "message": {"usage": {"output_tokens": 1}}})
        await stream({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}})
        relogio[0] += 2.5
        assert adapter._evento(sess).label == "Pensando… (2s · thought for 2s)"
        await stream({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "x" * 400}})
        await stream({"type": "content_block_stop", "index": 0})
        await stream({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "name": "Bash"}})
        assert adapter._evento(sess).label == "Bash… (2s · ↓ 100 tokens · thought for 2s)"   # estimativa
        await stream({"type": "message_delta", "usage": {"output_tokens": 334}})
        assert adapter._evento(sess).label == "Bash… (2s · ↓ 334 tokens · thought for 2s)"   # real
        # 2ª chamada soma, e o tempo passa de um minuto.
        relogio[0] += 80
        await stream({"type": "message_start", "message": {"usage": {"output_tokens": 1}}})
        await stream({"type": "message_delta", "usage": {"output_tokens": 900}})
        assert adapter._evento(sess).label == "Bash… (1m 22s · ↓ 1.2k tokens · thought for 2s)"
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "usage": {}})
        assert sess.turno_inicio is None and adapter._evento(sess).label is None
        await sess.drenador
    _run(fluxo())


def test_rotulo_da_tool_mostra_o_alvo_enquanto_o_input_escreve(adapter):
    sess = adapter._sessions["s1"]

    def stream(ev):
        return adapter._on_event(sess, {"type": "stream_event", "event": ev})

    def pedaco(txt):
        return stream({"type": "content_block_delta", "index": 1,
                       "delta": {"type": "input_json_delta", "partial_json": txt}})

    async def fluxo():
        await stream({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "name": "Bash"}})
        assert sess.label == "Bash…"
        await pedaco('{"comm')
        assert sess.label == "Bash…"
        await pedaco('and": "uv run py')
        assert sess.label == "Bash: uv run py"   # string ainda sem aspa final
        await pedaco('test -k \\"x\\"\\nsegunda linha", "description": "roda"}')
        assert sess.label == 'Bash: uv run pytest -k "x"'
        await stream({"type": "content_block_stop", "index": 1})
        assert sess.label == 'Bash: uv run pytest -k "x"' and sess.tool_json == ""
        # A mensagem inteira chega depois e mantém o alvo (antes voltava a "Bash…").
        await adapter._on_event(sess, {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "C:\\repo\\backend\\adapter.py"}}]}})
        assert sess.label == "Edit: adapter.py"
    _run(fluxo())
    assert A._rotulo_tool("Bash", {"command": "x" * 200}) == "Bash: " + "x" * 80 + "…"
    assert A._rotulo_tool("Grep", A._input_parcial('{"pattern": "def ')) == "Grep: def"


def test_pensamento_em_voo_vai_pra_fonte_propria_e_sai_quando_o_bloco_cai_no_jsonl(adapter):
    from app.adapters.preview_push import fonte_pensamento
    sess = adapter._sessions["s1"]

    def stream(ev):
        return adapter._on_event(sess, {"type": "stream_event", "event": ev})

    async def fluxo():
        await stream({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}})
        for p in ("Vou ", "conferir o teste."):
            await stream({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": p}})
        await stream({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "abc"}})
        assert fonte_pensamento("s1").text == "Vou conferir o teste."
        assert PushPreviewSource.get("s1").text == ""   # nunca vira bolha de resposta
        await adapter._on_event(sess, {"type": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "Vou conferir o teste.", "signature": "abc"}]}})
        assert fonte_pensamento("s1").text == "" and sess.pensamento == ""
    _run(fluxo())


def test_flag_de_exibicao_do_pensamento_segue_a_chave_do_settings(adapter, monkeypatch):
    from app import pensamento
    monkeypatch.setattr(pensamento, "ler", lambda: True)
    argv = adapter._argv("sid", resume=True)
    assert argv[argv.index("--thinking-display") + 1] == "summarized"
    monkeypatch.setattr(pensamento, "ler", lambda: False)
    assert "--thinking-display" not in adapter._argv("sid", resume=False)


def test_sessao_parada_aceita_na_hora_e_sobe_em_segundo_plano(sidecar, monkeypatch):
    # O POST não pode esperar os hooks de SessionStart: parada = fila + acordar, sem bloquear.
    ad = ClaudeHeadlessAdapter()
    chamadas = []

    async def ensure_falso(name, **kw):
        chamadas.append(kw)
        return None
    monkeypatch.setattr(ad, "ensure_running", ensure_falso)

    async def fluxo():
        assert await ad.deliverable("s1") is False
        ad.acordar("s1")
        await asyncio.sleep(0)
        await asyncio.gather(*ad._tarefas)
    _run(fluxo())
    assert chamadas == [{"esperar_pronta": False}]


def test_subida_em_segundo_plano_que_falha_aparece_no_chat_ja_aberto(sidecar, monkeypatch):
    ad = ClaudeHeadlessAdapter()

    async def spawn_quebra(sess, **kw):
        raise RuntimeError("binário não encontrado: claude")
    monkeypatch.setattr(ad, "_spawn", spawn_quebra)

    async def fluxo():
        gen = ad.state_monitor("s1", lambda: None)
        ev = await gen.__anext__()
        assert ev.state == "idle" and ev.problema is None and ev.headless
        ad.acordar("s1")
        await asyncio.gather(*ad._tarefas)
        ev = await asyncio.wait_for(gen.__anext__(), 3)
        assert ev.problema == "headless_nao_subiu" and "binário" in (ev.problema_detalhe or "")
        await gen.aclose()
    _run(fluxo())


def test_initialize_lento_mostra_iniciando_e_limpa_o_aviso_quando_responde(adapter, monkeypatch):
    sess = adapter._sessions["s1"]
    monkeypatch.setattr(A, "_AVISO_INIT_S", 0.01)
    liberar = asyncio.Event
    drenou = []

    async def fluxo():
        solta = liberar()

        async def ctrl_lento(s, subtype, **kw):
            await solta.wait()
            return {}
        monkeypatch.setattr(adapter, "_ctrl", ctrl_lento)
        monkeypatch.setattr(adapter, "_agendar_cota", lambda s: None)

        async def drenar(s):
            drenou.append(s.name)
        monkeypatch.setattr(adapter, "_drenar_fim_de_turno", drenar)
        sess.iniciando = True
        sess.iniciar_turno()
        tarefa = asyncio.create_task(adapter._esperar_initialize(sess))
        await asyncio.sleep(0)
        ev = adapter._evento(sess)
        assert ev.state == "working" and ev.label.startswith("Iniciando sessão… (") and ev.headless
        assert await adapter.deliverable("s1") is False       # prompt vai pra fila, não pro stdin
        await asyncio.sleep(0.05)
        assert sess.problema == "headless_sem_resposta"        # passou do aviso: fica à vista
        solta.set()
        await tarefa
        assert not sess.iniciando and sess.initialized.is_set() and sess.problema is None
        assert adapter._evento(sess).state == "idle" and drenou == ["s1"]
    _run(fluxo())


def test_contexto_vem_da_ultima_chamada_nao_da_soma_do_turno(adapter):
    # Turno com 3 chamadas de ~70k: o `usage` do result soma as três (210k) e pintava o anel cheio.
    sess = adapter._sessions["s1"]
    sess.model = "claude-opus-5[1m]"

    async def fluxo():
        for cache in (69000, 70000, 71000):
            await adapter._on_event(sess, {"type": "assistant", "message": {
                "content": [{"type": "tool_use", "name": "Bash"}],
                "usage": {"input_tokens": 2, "cache_read_input_tokens": cache, "output_tokens": 100}}})
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "total_cost_usd": 0.5,
                                       "usage": {"input_tokens": 6, "cache_read_input_tokens": 210000, "output_tokens": 300},
                                       "modelUsage": {"claude-opus-5[1m]": {"contextWindow": 1000000}}})
        # Interrupt: uso zerado não apaga o contexto que valia.
        await adapter._on_event(sess, {"type": "assistant", "message": {"content": [], "usage": {"input_tokens": 0}}})
    _run(fluxo())
    assert adapter.status_line(sess) == "🤖 Opus5·1M │ 💬 71k/100 71k/1M │ 💵 $0.50"


def test_contexto_apos_religar_le_a_ultima_chamada_do_transcript(adapter):
    sess = adapter._sessions["s1"]
    caminho = adapter.transcript_path_de(sess.meta)
    A.Path(caminho).parent.mkdir(parents=True, exist_ok=True)
    linhas = [
        {"type": "assistant", "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 50000}}},
        {"type": "assistant", "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 80000}}},
        {"type": "assistant", "isSidechain": True, "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 3000}}},
        {"type": "user", "message": {"content": "ok"}},
    ]
    A.Path(caminho).write_text("\n".join(json.dumps(x) for x in linhas) + "\n", encoding="utf-8")
    result = json.dumps({"type": "result", "subtype": "success", "total_cost_usd": 1.0,
                         "usage": {"input_tokens": 9, "cache_read_input_tokens": 900000},
                         "modelUsage": {"claude-haiku-4-5": {"contextWindow": 200000}}})
    _run(adapter._aplicar_snapshot(sess, {"ultimo_result": result}))
    assert sess.usage["cache_read_input_tokens"] == 80000


def test_aviso_de_cota_nao_e_limite(adapter):
    sess = adapter._sessions["s1"]

    async def fluxo(status):
        await adapter._on_event(sess, {"type": "rate_limit_event", "rate_limit_info": {
            "status": status, "resetsAt": 1789362000, "rateLimitType": "seven_day"}})
    _run(fluxo("allowed_warning"))
    assert not sess.limited and sess.limit_reset is None
    _run(fluxo("rejected"))
    assert sess.limited and sess.limit_reset
    _run(fluxo("allowed"))
    assert not sess.limited and sess.limit_reset is None


@pytest.mark.parametrize("modelo, rotulo", [
    ("claude-opus-5[1m]", "Opus5·1M"),
    ("claude-opus-5", "Opus5"),
    ("claude-sonnet-5", "Sonnet 5"),
    ("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ("claude-fable-5-1", "Fable 5.1"),
    ("opus", "Opus"),
    ("kimi-k3", "kimi-k3"),
])
def test_rotulo_do_modelo_na_grafia_da_statusline(modelo, rotulo):
    assert A._rotulo_modelo(modelo) == rotulo


def test_sessao_parada_mostra_modelo_e_esforco_da_abertura(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_EFFORT_LEVEL", raising=False)
    meta = {"model": "claude-opus-5[1m]", "effort": "high", "config_dir": str(tmp_path)}
    assert A._linha_parada(meta) == "🤖 Opus5·1M (high)"
    assert A._linha_parada({**meta, "model": None}) is None


def test_esforco_cai_no_padrao_da_conta(adapter, tmp_path, monkeypatch):
    monkeypatch.setattr(A, "_esforco_padrao", _ESFORCO_PADRAO_REAL)   # tira o stub da fixture
    monkeypatch.delenv("CLAUDE_CODE_EFFORT_LEVEL", raising=False)
    (tmp_path / "conta").mkdir()
    (tmp_path / "conta" / "settings.json").write_text('{"effortLevel": "high"}', encoding="utf-8")
    assert A._esforco_padrao(str(tmp_path / "conta")) == "high"
    assert A._esforco_padrao(str(tmp_path / "sem-conta")) is None
    monkeypatch.setenv("CLAUDE_CODE_EFFORT_LEVEL", "max")
    assert A._esforco_padrao(str(tmp_path / "conta")) == "max"
    sess = adapter._sessions["s1"]
    sess.meta = {**sess.meta, "config_dir": str(tmp_path / "conta")}
    assert adapter.status_line(sess) == "🤖 Haiku (max)"
    sess.effort = "low"   # escolhido na sessão vence o padrão
    assert adapter.status_line(sess) == "🤖 Haiku (low)"


def test_permissao_vira_awaiting_e_opcao_responde(adapter):
    sess = adapter._sessions["s1"]
    req = {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "curl x"}, "description": "Baixa x"}

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r1", "request": req})
        ev = adapter._evento(sess)
        assert ev.state == "awaiting_input" and ev.options == ["Permitir", "Negar"]
        assert ev.question == "Permitir Bash? Baixa x"
        assert await adapter.select("s1", 2) is True
        assert sess.state == "working" and not sess.pending
        assert await adapter.select("s1", 1) is False   # nada pendente
    _run(fluxo())
    resp = adapter.escritos[-1]
    assert resp["type"] == "control_response"
    assert resp["response"]["request_id"] == "r1"
    assert resp["response"]["response"]["behavior"] == "deny"


def test_sempre_permitir_so_com_sugestao_e_leva_as_regras(adapter):
    sess = adapter._sessions["s1"]
    regras = [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "curl *"}],
               "behavior": "allow", "destination": "localSettings"}]

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r1",
                                       "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                                                   "input": {"command": "curl x"}, "permission_suggestions": regras}})
        assert adapter._evento(sess).options == ["Permitir", "Negar", "Sempre permitir"]
        assert await adapter.select("s1", 3) is True
        # Sem sugestão, a 3ª opção não existe e o 3 cai em negar.
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r2",
                                       "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {}}})
        assert adapter._evento(sess).options == ["Permitir", "Negar"]
        await adapter.select("s1", 3)
    _run(fluxo())
    r1, r2 = [e["response"]["response"] for e in adapter.escritos if e["type"] == "control_response"]
    assert r1["behavior"] == "allow" and r1["updatedPermissions"] == regras
    assert r2["behavior"] == "deny"


def test_steer_queue_so_com_turno_em_voo_e_sem_pendencia(adapter, tmp_path, monkeypatch):
    from app import pqueue
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    sess = adapter._sessions["s1"]
    q = pqueue.PromptQueue("s1"); q.clear()
    entrada = q.append("agora", delivered=False)

    async def fluxo():
        with pytest.raises(RuntimeError):
            await adapter.steer_queue("s1")            # ociosa: nada a orientar
        sess.in_progress = True
        sess.pending["r1"] = {"subtype": "can_use_tool", "tool_name": "Bash", "input": {}}
        with pytest.raises(RuntimeError):
            await adapter.steer_queue("s1")            # parada em permissão
        sess.pending.clear()
        assert await adapter.steer_queue("s1") == [entrada["id"]]
    _run(fluxo())
    assert adapter.escritos[-1]["message"]["content"][0]["text"] == "agora"
    assert all(e.get("delivered") for e in q.load())
    q.clear()


def test_ask_user_question_vira_pergunta_nativa_e_resposta_leva_rotulos(adapter):
    sess = adapter._sessions["s1"]
    perguntas = [{"question": "A ou B?", "header": "Escolha", "multiSelect": False,
                  "options": [{"label": "A", "description": ""}, {"label": "B", "description": ""}]}]

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "control_request", "request_id": "q1",
                                       "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion",
                                                   "input": {"questions": perguntas}}})
        ev = adapter._evento(sess)
        assert ev.state == "awaiting_input" and ev.options is None
        assert ev.codex_question == {"provider": "claude", "request_id": "q1", "questions": perguntas}
        with pytest.raises(ValueError):
            await adapter.answer_questions("s1", "outra", [{"kind": "option", "indices": [1]}])
        await adapter.answer_questions("s1", "q1", [{"kind": "option", "indices": [1]}])
        assert sess.question is None and sess.state == "working"
    _run(fluxo())
    resp = adapter.escritos[-1]["response"]["response"]
    assert resp["behavior"] == "allow"
    assert resp["updatedInput"] == {"questions": perguntas, "answers": {"A ou B?": "B"}}


def test_clear_troca_o_sid_no_sidecar(adapter, sidecar):
    sess = adapter._sessions["s1"]
    _run(adapter._on_event(sess, {"type": "system", "subtype": "init", "session_id": "22222222-2222-2222-2222-222222222222",
                                  "model": "claude-sonnet-5", "permissionMode": "acceptEdits"}))
    assert S.load("s1")["session_id"] == "22222222-2222-2222-2222-222222222222"
    assert sess.model == "claude-sonnet-5" and sess.permission_mode == "acceptEdits"


def test_interrupt_nega_pendencias_antes(adapter):
    sess = adapter._sessions["s1"]

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r1",
                                       "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {}}})
        assert await adapter.interrupt("s1") is True
    _run(fluxo())
    tipos = [(e["type"], e.get("request", {}).get("subtype")) for e in adapter.escritos]
    assert tipos == [("control_response", None), ("control_request", "interrupt")]


def test_sessao_parada_fica_ociosa_sem_subir_processo(sidecar, monkeypatch):
    ad = ClaudeHeadlessAdapter()
    monkeypatch.setattr(ad, "_spawn", lambda sess: (_ for _ in ()).throw(AssertionError("não devia subir")))

    async def fluxo():
        gen = ad.state_monitor("s1", lambda: None)
        ev = await gen.__anext__()
        assert ev.state == "idle" and ev.claude_permission_mode == "manual"
        await gen.aclose()
    _run(fluxo())


def test_registry_cria_lista_e_mata_sem_tmux(tmp_path, monkeypatch):
    from app import registry as R
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(R.tmux, "has_session", lambda n: False)
    monkeypatch.setattr(R.tmux, "list_panes_all", lambda: {})
    monkeypatch.setattr(R, "_pretrust_cwd", lambda cwd, cfg: None)
    reg = R.SessionRegistry(str(tmp_path / "projects"))
    info = reg.create("hl", str(tmp_path), provider="claude", headless=True, model="haiku", permission_mode="manual")
    assert info.headless and info.provider == "claude" and info.jsonl.endswith(".jsonl")
    assert S.load("hl")["cwd"] == str(tmp_path)
    with pytest.raises(ValueError):
        reg.create("hl", str(tmp_path), provider="claude")          # nome ocupado pelo sidecar
    with pytest.raises(ValueError):
        reg.create("x", str(tmp_path), provider="pi", headless=True)  # só claude
    listadas = [i for i in reg.list() if i.name == "hl"]
    assert len(listadas) == 1 and listadas[0].headless and listadas[0].tracked
    reg.kill("hl")
    assert not S.exists("hl")


def test_turno_com_erro_vira_problema_e_sucesso_limpa(adapter):
    sess = adapter._sessions["s1"]

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "result", "subtype": "error_max_turns", "is_error": True,
                                       "result": "Reached max turns", "usage": {}})
        ev = adapter._evento(sess)
        assert ev.state == "idle" and ev.problema == "headless_turno_erro"
        assert "Reached max turns" in (ev.problema_detalhe or "")
        assert adapter.problema_de("s1") == (ev.problema, ev.problema_detalhe)
        # Interrupt não é erro: nada muda.
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "result", "subtype": "error_during_execution", "usage": {}})
        assert adapter._evento(sess).problema == "headless_turno_erro"
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "usage": {"input_tokens": 1}})
        assert adapter._evento(sess).problema is None and adapter.problema_de("s1") is None
    _run(fluxo())


class _Escritor:
    def close(self) -> None:
        pass


def _ligacao_com(linhas: list[dict]) -> "A._Ligacao":
    # Conexão com um cano que já mandou estas linhas e fechou.
    reader = asyncio.StreamReader()
    for l in linhas:
        reader.feed_data((json.dumps(l) + "\n").encode())
    reader.feed_eof()
    return A._Ligacao(reader, _Escritor(), 4242)   # type: ignore[arg-type]


def test_processo_caindo_registra_problema_com_stderr(adapter, sidecar):
    sess = adapter._sessions["s1"]

    async def fluxo():
        # O cano entrega o stderr e a saída do claude (rc=3) e fecha: é o caminho da queda.
        sess.proc = _ligacao_com([{"type": "cano_stderr", "linha": "Error: not logged in"},
                                  {"type": "cano_saiu", "rc": 3, "stderr_tail": ["Error: not logged in"]}])
        await adapter._ler(sess)
        assert sess.state == "dead"
        assert adapter.problema_de("s1")[0] == "headless_processo_caiu"
        assert "not logged in" in adapter.problema_de("s1")[1]
        # Parada, a sessão publica o problema da última vida.
        adapter._sessions.pop("s1")
        gen = adapter.state_monitor("s1", lambda: None)
        ev = await gen.__anext__()
        assert ev.state == "idle" and ev.problema == "headless_processo_caiu"
        await gen.aclose()
    _run(fluxo())


def test_conexao_tomada_com_cano_vivo_religa_sem_esquecer_nem_acusar_queda(adapter, sidecar, monkeypatch):
    sess = adapter._sessions["s1"]
    cano = {"pid": 777, "escuta": "tcp:127.0.0.1:1", "token": "t"}
    sess.meta = S.update("s1", cano=cano)
    monkeypatch.setattr(A, "pid_vivo", lambda pid: pid == 777)
    religar = []
    monkeypatch.setattr(adapter, "_agendar_religar", religar.append)

    async def fluxo():
        sess.proc = _ligacao_com([])          # EOF sem `cano_saiu`: outro cliente tomou a conexão
        await adapter._ler(sess)
    _run(fluxo())
    assert religar == ["s1"]
    assert S.load("s1")["cano"] == cano
    assert adapter.problema_de("s1") is None


def test_entrega_agenda_a_confirmacao_da_fila(adapter):
    agendadas = []
    adapter.apos_entrega = agendadas.append
    assert _run(adapter.send_prompt("s1", "oi")) == "sent"
    assert agendadas == ["s1"]


def test_problema_sobrevive_ao_restart_e_limpa_no_turno_bom(adapter, sidecar):
    sess = adapter._sessions["s1"]
    adapter._registrar_problema(sess, "headless_processo_caiu", "rc=143")
    novo = ClaudeHeadlessAdapter()                      # backend reiniciado: memória vazia
    assert novo.problema_de("s1") == ("headless_processo_caiu", "rc=143")

    async def fluxo():
        gen = novo.state_monitor("s1", lambda: None)
        ev = await gen.__anext__()
        assert ev.state == "idle" and ev.problema == "headless_processo_caiu"
        await gen.aclose()
        viva = _Sessao("s1", S.load("s1"))
        viva.proc = _Proc()
        novo._sessions["s1"] = viva
        assert novo._evento(viva).problema == "headless_processo_caiu"
        viva.in_progress = True
        await novo._on_event(viva, {"type": "result", "subtype": "success", "usage": {"input_tokens": 1}})
        await viva.drenador
    _run(fluxo())
    assert S.load("s1").get("problema") is None and ClaudeHeadlessAdapter().problema_de("s1") is None


def test_cano_mudo_e_vivo_nao_e_morto(sidecar, monkeypatch):
    ad = ClaudeHeadlessAdapter()
    S.update("s1", cano={"pid": 777, "escuta": "tcp:127.0.0.1:1", "token": "t"})
    monkeypatch.setattr(A, "pid_vivo", lambda pid: True)

    async def sem_snapshot(cano, **kw):
        return None
    monkeypatch.setattr(ad, "_conectar", sem_snapshot)
    monkeypatch.setattr(A, "_matar_grupo", lambda pid, name: pytest.fail("matou cano vivo"))
    monkeypatch.setattr(ad, "_subir_cano", lambda sess: pytest.fail("subiu segundo claude"))
    with pytest.raises(RuntimeError):
        _run(ad.ensure_running("s1", esperar_pronta=False))
    assert S.load("s1")["cano"]["pid"] == 777
    assert ad.problema_de("s1") is None      # passageiro: não fica na lista


def test_ensure_running_nao_sobe_dois_processos(sidecar, monkeypatch):
    ad = ClaudeHeadlessAdapter()
    subidas = []

    async def spawn_falso(sess, **kw):
        subidas.append(sess.sid)
        await asyncio.sleep(0.05)
        sess.proc = _Proc()
        return True
    monkeypatch.setattr(ad, "_spawn", spawn_falso)

    async def fluxo():
        a, b = await asyncio.gather(ad.ensure_running("s1"), ad.ensure_running("s1"))
        assert a is b and len(subidas) == 1
    _run(fluxo())


def test_registry_renomeia_sem_tmux(tmp_path, monkeypatch):
    from app import registry as R
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(R.tmux, "has_session", lambda n: False)
    monkeypatch.setattr(R.tmux, "list_panes_all", lambda: {})
    monkeypatch.setattr(R, "_pretrust_cwd", lambda cwd, cfg: None)
    reg = R.SessionRegistry(str(tmp_path / "projects"))
    reg.create("hl", str(tmp_path), provider="claude", headless=True)
    reg.rename("hl", "hl2")
    assert not S.exists("hl") and S.load("hl2")["name"] == "hl2"
    reg.kill("hl2")


def test_espera_grava_marcador_do_state_hook_e_desfaz_ao_resolver(adapter, tmp_path):
    # Sem pane não há hook Notification: é o adapter que põe o awaiting_input na esteira de
    # push/loop, e tira quando a permissão é respondida.
    sess = adapter._sessions["s1"]
    marcador = tmp_path / "state" / f"{sess.sid}.json"
    req = {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r1", "request": req})
        assert json.loads(marcador.read_text())["state"] == "awaiting_input"
        await adapter.select("s1", 1)
        assert json.loads(marcador.read_text())["state"] == "working"
    _run(fluxo())


def test_fim_de_turno_drena_a_fila(adapter, tmp_path, monkeypatch):
    from app import pqueue
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    sess = adapter._sessions["s1"]
    q = pqueue.PromptQueue("s1"); q.clear()
    q.append("depois", delivered=False)

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "usage": {}})
        await sess.drenador
        assert all(e.get("delivered") for e in q.load())
    _run(fluxo())
    assert adapter.escritos[-1]["message"]["content"][0]["text"] == "depois"
    q.clear()


def test_comando_local_vira_bolha_na_fila_e_nao_no_transcript(adapter, tmp_path, monkeypatch):
    from app import pqueue
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    sess = adapter._sessions["s1"]
    q = pqueue.PromptQueue("s1"); q.clear()
    comum = q.append("oi", delivered=True)      # prompt comum ainda no prazo do reconcile
    comando = q.append("/cost", delivered=True)
    ev = {"type": "assistant", "local_command_source": "<local-command-stdout>uso: 4%</local-command-stdout>",
          "message": {"model": "<synthetic>", "content": [{"type": "text", "text": "uso: 4%"}]}}

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, ev)
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "local_command": "cost", "usage": {}})
        await sess.drenador
    _run(fluxo())
    rows = q.load()
    assert len(rows) == 3
    # O comando digitado fica confirmado pelo `result` (o .jsonl não o grava como linha `user`,
    # e o reconcile o redigitaria); o prompt comum segue com o reconcile de sempre; a saída vira
    # bolha do assistente.
    assert rows[0]["id"] == comum["id"] and not rows[0].get("confirmed")
    assert rows[1]["id"] == comando["id"] and rows[1]["confirmed"] is True
    assert rows[2]["papel"] == "assistant" and rows[2]["confirmed"] is True
    evento = pqueue._entry_event(rows[2])
    assert evento.kind == "assistant_msg" and evento.id.startswith("local-") and evento.text == "uso: 4%"
    # Nunca é drenada nem reconciliada: já nasce entregue e confirmada.
    assert q.claim_undelivered() == []
    q.clear()


def test_modo_de_permissao_sobrevive_ao_resume_e_ao_nome_da_cli(adapter):
    # A CLI reporta "default" pro que a flag chama de "manual"; sem normalizar, o próximo
    # processo (--resume) nasceria sem flag válida e cairia no defaultMode da conta.
    sess = adapter._sessions["s1"]
    _run(adapter._on_event(sess, {"type": "system", "subtype": "init", "session_id": sess.sid,
                                  "permissionMode": "default", "model": "haiku"}))
    assert sess.permission_mode == "manual"
    argv = adapter._argv(sess.sid, resume=True, permission_mode=sess.permission_mode)
    assert "--resume" in argv and argv[argv.index("--permission-mode") + 1] == "manual"


def test_modo_plan_lembra_o_modo_anterior_para_o_botao_implementar(adapter):
    sess = adapter._sessions["s1"]
    ctrl_calls = []

    async def ctrl(s, subtype, **req):
        ctrl_calls.append((subtype, req))
        return {"mode": req.get("mode")}
    adapter._ctrl = ctrl   # type: ignore[method-assign]

    async def fluxo():
        await adapter._on_event(sess, {"type": "system", "subtype": "init", "session_id": sess.sid,
                                       "permissionMode": "acceptEdits", "model": "haiku"})
        assert await adapter.set_permission_mode("s1", "plan") == "plan"
        ev = adapter._evento(sess)
        assert ev.claude_permission_mode == "plan" and ev.claude_previous_non_plan == "acceptEdits"
        # Voltar pro modo anterior (o que o card faz ao implementar) atualiza o "anterior".
        await adapter.set_permission_mode("s1", "acceptEdits")
        await adapter._on_event(sess, {"type": "system", "subtype": "status", "permissionMode": "default"})
        assert adapter._evento(sess).claude_previous_non_plan == "manual"
    _run(fluxo())
    assert [c[1]["mode"] for c in ctrl_calls] == ["plan", "acceptEdits"]
    meta = S.load("s1")
    assert meta["permission_mode"] == "acceptEdits" and meta["previous_non_plan"] == "manual"


def test_anexo_de_imagem_vira_bloco_nativo_e_texto_fica_inteiro(adapter, tmp_path, monkeypatch):
    # No terminal a TUI anexa a imagem pelo path; aqui é o adapter, como bloco `image`. O texto
    # segue inteiro (é o que o .jsonl grava e o que a fila confirma). Arquivo que não é imagem
    # fica só como path; imagem que não abre fica só como path E avisa no chat.
    from app import pqueue
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    q = pqueue.PromptQueue("s1"); q.clear()
    (tmp_path / "com espaco").mkdir()
    img = tmp_path / "com espaco" / "foto.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    img2 = tmp_path / "b.jpg"
    img2.write_bytes(b"jpgfake")
    texto = (f"olha isso — 📎 imagem: {img} 📎 arquivo: {tmp_path}/nota.txt "
             f"📎 imagem: {tmp_path}/sumiu.jpg\n📎 imagem: {img2}, viu?")
    _run(adapter.send_prompt("s1", texto))
    blocos = adapter.escritos[-1]["message"]["content"]
    assert blocos[0] == {"type": "text", "text": texto}
    assert [b["type"] for b in blocos] == ["text", "image", "image"]
    assert blocos[1]["source"]["media_type"] == "image/png"
    assert base64.b64decode(blocos[1]["source"]["data"]) == img.read_bytes()
    assert blocos[2]["source"]["media_type"] == "image/jpeg"
    notas = [r["text"] for r in q.load() if r.get("papel") == "assistant"]
    assert len(notas) == 1 and "sumiu.jpg" in notas[0] and notas[0].startswith("⚠️ Imagem não anexada")
    q.clear()


def test_sem_login_vira_problema_com_instrucao(adapter):
    sess = adapter._sessions["s1"]
    sess.in_progress = True
    _run(adapter._on_event(sess, {"type": "result", "subtype": "success", "is_error": True,
                                  "result": "Not logged in · Please run /login", "usage": {}}))
    assert adapter.problema_de("s1")[0] == "headless_sem_login"


def test_subagente_rotula_o_que_faz_e_nao_vaza_na_previa(adapter):
    # Eventos medidos na sonda (docs/research): system/task_* pro andamento do subagente, e a
    # conversa dele chega com parent_tool_use_id — que não pode mexer no rótulo nem na prévia.
    sess = adapter._sessions["s1"]

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "system", "subtype": "task_started", "task_id": "t1",
                                       "subagent_type": "Explore", "description": "Listar arquivos"})
        assert sess.label == "Explore: Listar arquivos"
        await adapter._on_event(sess, {"type": "system", "subtype": "task_progress", "task_id": "t1",
                                       "description": "Running List files", "last_tool_name": "Bash"})
        assert sess.label == "Explore: List files"
        await adapter._on_event(sess, {"type": "stream_event", "parent_tool_use_id": "toolu_1",
                                       "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "eu sou o filho"}}})
        assert PushPreviewSource.get("s1").text == ""
        await adapter._on_event(sess, {"type": "assistant", "parent_tool_use_id": "toolu_1",
                                       "message": {"content": [{"type": "tool_use", "name": "Grep"}]}})
        assert sess.label == "Explore: List files"
        await adapter._on_event(sess, {"type": "system", "subtype": "task_notification", "task_id": "t1", "status": "completed"})
        assert not sess.tarefas and sess.label is None   # rótulo não fica congelado no filho
    _run(fluxo())


def test_permissao_decidida_por_hook_e_negacao_automatica_viram_nota(adapter, tmp_path, monkeypatch):
    from app import pqueue
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    sess = adapter._sessions["s1"]
    q = pqueue.PromptQueue("s1"); q.clear()
    req = {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}

    async def fluxo():
        sess.in_progress = True
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r1", "request": req})
        assert sess.state == "awaiting_input"
        # Hook PermissionRequest decidiu: a CLI cancela o pedido antes do usuário responder.
        await adapter._on_event(sess, {"type": "control_cancel_request", "request_id": "r1"})
        assert sess.state == "working"
        # Cancelamento de pedido que já não existe (interrupt nosso) não gera nota.
        await adapter._on_event(sess, {"type": "control_cancel_request", "request_id": "r1"})
        # Pergunta nativa cancelada por hook também avisa.
        sess.question = {"provider": "claude", "request_id": "q1", "questions": [{"question": "Qual banco?"}]}
        await adapter._on_event(sess, {"type": "control_cancel_request", "request_id": "q1"})
        assert sess.question is None
        # Interrupt nosso: pendência respondida some antes; o cancel que a CLI manda depois é mudo.
        await adapter._on_event(sess, {"type": "control_request", "request_id": "r2", "request": req})
        await adapter.interrupt("s1")
        await adapter._on_event(sess, {"type": "control_cancel_request", "request_id": "r2"})
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "usage": {},
                                       "permission_denials": [{"tool_name": "Edit", "tool_use_id": "t", "tool_input": {"file_path": "/x.py"}}]})
        await sess.drenador
    _run(fluxo())
    notas = [r["text"] for r in q.load() if r.get("papel") == "assistant"]
    assert notas == ["⚙️ Permitir Bash? ls — decidido por hook, sem você",
                     "⚙️ Pergunta cancelada antes da resposta: Qual banco?"]
    q.clear()


def test_esforco_vai_como_comando_local_e_espera_o_turno(adapter):
    # Medido: `/effort high` pelo stdin responde "Set effort level to high" sem API. Ociosa:
    # sai na hora; com turno em voo: guarda e sai no `result`, antes de drenar a fila.
    sess = adapter._sessions["s1"]

    def confirmacao(nivel: str) -> dict:
        return {"type": "assistant", "local_command_source": "<local-command-stdout>x</local-command-stdout>",
                "message": {"model": "<synthetic>", "content": [{"type": "text", "text": f"Set effort level to {nivel} (this session only): …"}]}}

    async def fluxo():
        assert await adapter.set_model("s1", None, "high") is True
        assert adapter.escritos[-1]["message"]["content"][0]["text"] == "/effort high"
        assert sess.effort != "high"          # só quando a CLI confirmar
        await adapter._on_event(sess, confirmacao("high"))
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "local_command": "effort", "usage": {}})
        assert sess.state == "idle" and sess.effort == "high" and S.load("s1")["effort"] == "high"
        # Em voo: não escreve agora; no result do turno, sai antes de drenar.
        sess.in_progress = True
        n = len(adapter.escritos)
        assert await adapter.set_model("s1", None, "low") is False
        assert len(adapter.escritos) == n and sess.effort_pendente == "low"
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "usage": {}})
        assert adapter.escritos[-1]["message"]["content"][0]["text"] == "/effort low"
        assert sess.effort_pendente is None and sess.in_progress
        # Pedido mais novo enquanto o /effort low ainda espera resposta: sai no result dele.
        assert await adapter.set_model("s1", None, "max") is False
        await adapter._on_event(sess, confirmacao("low"))
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "local_command": "effort", "usage": {}})
        assert adapter.escritos[-1]["message"]["content"][0]["text"] == "/effort max"
        # Recusa da CLI: valor não muda e vira problema visível.
        await adapter._on_event(sess, {"type": "assistant", "local_command_source": "<local-command-stdout>x</local-command-stdout>",
                                       "message": {"content": [{"type": "text", "text": "Usage: /effort <low|medium|high|xhigh|max|auto>"}]}})
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "local_command": "effort", "usage": {}})
        await sess.drenador
        assert sess.state == "idle" and sess.effort == "low"
        assert adapter.problema_de("s1")[0] == "headless_turno_erro" and "max" in adapter.problema_de("s1")[1]
    _run(fluxo())
    assert S.load("s1")["effort"] == "low"


def test_processo_herda_chave_e_nao_o_pane_do_operador(sidecar, monkeypatch):
    monkeypatch.setenv("TMUX_PANE", "%9")
    monkeypatch.setenv("TMUX", "/tmp/x")
    visto = {}

    async def exec_falso(*argv, env, **kw):
        visto["env"] = env
        visto["argv"] = argv

        class _P:
            pid = 1
            returncode = None

            async def wait(self):
                return 0
        return _P()

    async def conectar_falso(cano, **kw):
        visto["cano"] = cano
        return _ligacao_com([]), {"type": "cano_snapshot", "versao": A.cano_mod.VERSAO, "pid": 2,
                                  "init": None, "aberto": False, "pendentes": [], "stderr_tail": []}
    monkeypatch.setattr(asyncio, "create_subprocess_exec", exec_falso)
    monkeypatch.setattr(A.shutil, "which", lambda b: "/usr/bin/claude")
    ad = ClaudeHeadlessAdapter()
    sess = _Sessao("s1", S.update("s1", subagent_model="claude-opus-5"))

    async def ctrl(s, sub, **kw):
        return {}
    ad._conectar = conectar_falso                 # type: ignore[method-assign]
    ad._ler = lambda s: asyncio.sleep(0)          # type: ignore[method-assign]
    ad._ctrl = ctrl                               # type: ignore[method-assign]
    ad._agendar_cota = lambda s: None             # type: ignore[method-assign]
    _run(ad._spawn(sess))
    env = visto["env"]
    assert "TMUX" not in env and "TMUX_PANE" not in env
    assert env["CP_SESSION_NAME"] == "s1" and env["CP_SESSION_KEY"] == S.load("s1")["key"]
    assert env["HANGAR_CANO_KEY"] == S.load("s1")["key"]
    assert env["CLAUDE_CODE_SUBAGENT_MODEL"] == "claude-opus-5"
    # O processo que nasce é o cano, com o comando do claude depois do `--`; o sidecar guarda
    # onde ele escuta, pra o próximo backend religar.
    argv = list(visto["argv"])
    ultimo = len(argv) - 1 - argv[::-1].index("--")   # o escopo do systemd também tem um `--`
    assert argv[ultimo + 1] == "/usr/bin/claude" and str(A._CANO_PY) in argv   # caminho resolvido
    assert S.load("s1")["cano"] == visto["cano"] and visto["cano"]["pid"] == 1
    assert visto["cano"]["escuta"].startswith(("unix:", "tcp:"))


def test_religa_no_cano_vivo_e_recupera_permissao_pendente(sidecar, monkeypatch):
    # Backend novo, cano de antes ainda vivo com turno aberto e permissão sem resposta: o
    # snapshot reconstrói tudo sem subir processo.
    S.update("s1", cano={"pid": 7, "escuta": "unix:/x.sock", "token": None})
    pendente = json.dumps({"type": "control_request", "request_id": "perm-1",
                           "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}})
    init = json.dumps({"type": "system", "subtype": "init", "session_id": "11111111-1111-1111-1111-111111111111",
                       "model": "haiku", "permissionMode": "default"})
    result = json.dumps({"type": "result", "subtype": "success", "total_cost_usd": 0.02,
                         "usage": {"input_tokens": 3, "cache_read_input_tokens": 1000, "output_tokens": 5},
                         "modelUsage": {"claude-haiku-4-5": {"contextWindow": 200000}}})

    async def conectar_falso(cano, **kw):
        assert cano["pid"] == 7
        return _ligacao_com([]), {"type": "cano_snapshot", "versao": A.cano_mod.VERSAO, "pid": 9,
                                  "init": init, "aberto": True, "pendentes": [pendente],
                                  "ultimo_result": result, "stderr_tail": ["x"], "saiu": None}
    subiu = []
    ad = ClaudeHeadlessAdapter()
    ad._conectar = conectar_falso                 # type: ignore[method-assign]
    ad._subir_cano = lambda s: subiu.append(s)    # type: ignore[method-assign]
    ad._ler = lambda s: asyncio.sleep(0)          # type: ignore[method-assign]
    ad._agendar_cota = lambda s: None             # type: ignore[method-assign]

    async def fluxo():
        sess = await ad.ensure_running("s1", so_reconectar=True)
        assert sess is not None and not subiu
        assert sess.initialized.is_set() and sess.permission_mode == "manual"
        assert sess.in_progress and sess.state == "awaiting_input"
        assert list(sess.pending) == ["perm-1"] and sess.cost == 0.02 and sess.context_window == 200000
        ev = ad._evento(sess)
        assert ev.question == "Permitir Bash? ls" and "39k" not in (ev.status_line or "")
    _run(fluxo())


def test_buracos_calados_viram_nota_no_chat(adapter, tmp_path, monkeypatch):
    from app import pqueue
    monkeypatch.setattr(pqueue.settings, "projects_dir", tmp_path / "projects")
    sess = adapter._sessions["s1"]
    q = pqueue.PromptQueue("s1"); q.clear()

    async def fluxo():
        await adapter._on_event(sess, {"type": "control_request", "request_id": "c-1",
                                       "request": {"subtype": "hook_callback", "callback_id": "x"}})
        await adapter._on_event(sess, {"type": "control_request", "request_id": "c-2",
                                       "request": {"subtype": "hook_callback", "callback_id": "y"}})   # repetido
        await adapter._on_event(sess, {"type": "novo_tipo", "x": 1})
        await adapter._on_event(sess, {"type": "novo_tipo", "x": 2})   # repetido: sem 2ª nota
        await adapter._on_event(sess, {"type": "keep_alive"})          # conhecido: nada
    _run(fluxo())
    # A CLI destrava com resposta vazia toda vez; a pessoa vê uma nota por subtype.
    assert [e["response"]["request_id"] for e in adapter.escritos] == ["c-1", "c-2"]
    assert all(e["response"]["response"] == {} for e in adapter.escritos)
    textos = [r["text"] for r in q.load()]
    assert textos == ["⚙️ A CLI pediu `hook_callback`; respondi vazio",
                      "⚙️ Evento desconhecido da CLI: novo_tipo"]
    assert sess.pending == {} and sess.state == "idle"
    q.clear()
