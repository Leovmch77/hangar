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
from app.adapters.codex.preview import CodexPreviewSource


class _Proc:
    returncode = None
    pid = 4242


@pytest.fixture
def sidecar(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_dir", lambda: tmp_path / "hl")
    monkeypatch.setattr(CodexPreviewSource, "_sources", {})
    monkeypatch.setattr(A, "_dir_marcadores", lambda meta: tmp_path / "state")
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
        assert CodexPreviewSource.get("s1").text == "ok"
        await adapter._on_event(sess, {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}})
        assert CodexPreviewSource.get("s1").text == ""
        await adapter._on_event(sess, {"type": "result", "subtype": "success", "num_turns": 1, "total_cost_usd": 0.04,
                                       "usage": {"input_tokens": 2, "cache_read_input_tokens": 39000, "output_tokens": 4},
                                       "modelUsage": {"claude-haiku-4-5": {"contextWindow": 200000}}})
        assert sess.state == "idle" and await adapter.deliverable("s1")
        assert adapter.status_line(sess) == "🤖 haiku │ 💬 39k/4 39k/200k │ 💵 $0.04"
    _run(fluxo())
    msg = adapter.escritos[0]
    assert msg["type"] == "user" and msg["message"]["content"] == [{"type": "text", "text": "oi"}]


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
        assert CodexPreviewSource.get("s1").text == ""
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
                     "⚙️ Pergunta cancelada antes da resposta: Qual banco?",
                     "⛔ Negado sem perguntar (1): Edit /x.py"]
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
    sess = _Sessao("s1", sidecar)

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
    # O processo que nasce é o cano, com o comando do claude depois do `--`; o sidecar guarda
    # onde ele escuta, pra o próximo backend religar.
    argv = list(visto["argv"])
    ultimo = len(argv) - 1 - argv[::-1].index("--")   # o escopo do systemd também tem um `--`
    assert argv[ultimo + 1] == "claude" and str(A._CANO_PY) in argv
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
