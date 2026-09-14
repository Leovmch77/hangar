"""Pergunta lateral (/btw): o overlay da TUI é simulado por uma sequência de telas; o tmux é falso."""
import subprocess

import pytest

import app.btw as btw

RODAPE_ANDANDO = "    ⇧←/→ to browse · x to clear history · Esc to close"
RODAPE_PRONTO = "    ↑/↓ to scroll · c to copy · f to fork · Esc to close"
RODAPE_COPIADO = "    ↑/↓ to scroll · Copied to clipboard · f to fork · Esc to close"


def _tela(*linhas):
    return "conversa\n" + "\n".join(linhas) + "\n"


class TmuxFalso:
    """`modo="tmux"`: buffers do servidor, `-t` é flag desconhecida nos comandos de buffer.
    `modo="psmux"` (medido no 3.3.8): buffers da SESSÃO — sem `-t` o comando fala com outra —,
    `-F '#{buffer_name}'` devolve `buffer000N` em vez do nome real, `show-buffer -b` devolve vazio
    com rc 0 e `delete-buffer -b` não apaga nada; sem `-b`, os dois agem no buffer mais recente."""

    def __init__(self, telas, buffer_apos_c=True, modo="tmux", resposta="1. Apple\n2. Banana\n"):
        self.telas = list(telas)
        self.teclas = []
        self.buffers = []  # [(nome, conteúdo)], mais recente primeiro, como o list-buffers
        self.buffer_apos_c = buffer_apos_c
        self.modo = modo
        self.resposta = resposta

    def capture_pane(self, name, lines=200):
        return self.telas.pop(0) if len(self.telas) > 1 else self.telas[0]

    # O composer como a TUI o mostraria: o que foi digitado, sem espaco, ate o Enter. `perde_barra`
    # = quantas digitacoes chegam SEM a `/` inicial (o que o Windows fez em 13/09/2026).
    perde_barra = 0
    digitado = ""
    falha_enter = False

    def composer(self, name):
        return self.digitado

    def esvaziar(self, name):
        self.teclas.append("C-u")
        self.digitado = ""
        return True

    def send_keys(self, name, keys, literal=False):
        if literal:
            self.tela_ao_digitar = self.telas[0]
            texto = keys
            if texto.startswith("/") and self.perde_barra > 0:
                self.perde_barra -= 1
                texto = texto[1:]
            self.digitado = "".join(texto.split())
        elif keys == "Enter":
            self.teclas.append(keys)
            if self.falha_enter:
                return False
            self.digitado = ""
            return True
        self.teclas.append(keys)
        if keys == "c" and self.buffer_apos_c:
            # O OSC 52 do psmux vira DOIS buffers iguais (medido).
            for _ in range(2 if self.modo == "psmux" else 1):
                self.buffers.insert(0, (f"buffer{7 + len(self.buffers)}", self.resposta))
        return True

    def _run(self, args, input=None):
        sub, resto = args[1], args[2:]
        alvo = "-t" in resto
        nome_b = resto[resto.index("-b") + 1] if "-b" in resto else None
        ok = lambda out="": subprocess.CompletedProcess(args, 0, out, "")
        if self.modo == "tmux" and alvo:
            return subprocess.CompletedProcess(args, 1, "", "command list-buffers: unknown flag -t\n")
        # psmux sem alvo: a sessão padrão é outra, que não tem os buffers desta.
        buffers = self.buffers if (self.modo == "tmux" or alvo) else []
        if sub == "list-buffers":
            if self.modo == "psmux":
                return ok("".join(f"buffer{i:04d}\n" for i in range(len(buffers))))
            return ok("".join(f"{n}\n" for n, _ in buffers))
        if sub == "show-buffer":
            if self.modo == "psmux" and nome_b is not None:
                return ok("")
            achado = next((c for n, c in buffers if nome_b in (None, n)), None)
            return ok(achado or "")
        if sub == "delete-buffer":
            if self.modo == "psmux" and nome_b is not None:
                return ok()
            i = next((i for i, (n, _) in enumerate(buffers) if nome_b in (None, n)), None)
            if i is not None:
                buffers.pop(i)
            return ok()
        raise AssertionError(args)


@pytest.fixture
def falso(monkeypatch):
    def montar(telas, **kw):
        f = TmuxFalso(telas, **kw)
        monkeypatch.setattr(btw.tmux, "capture_pane", f.capture_pane)
        monkeypatch.setattr(btw.tmux, "send_keys", f.send_keys)
        monkeypatch.setattr(btw.tmux, "_run", f._run)
        monkeypatch.setattr(btw, "_esvaziar_composer_claude", f.esvaziar)
        monkeypatch.setattr(btw, "_texto_composer_claude", f.composer)
        monkeypatch.setattr(btw.time, "sleep", lambda s: None)
        monkeypatch.setattr(btw, "_BUFFER_COM_ALVO", None)
        return f
    return montar


def test_le_a_resposta_do_buffer_e_fecha_o_overlay(falso):
    f = falso([
        _tela("❯ "),
        _tela("    /btw list fruits", "      · Answering…", RODAPE_ANDANDO),
        _tela("    /btw list fruits", "      1. Apple", RODAPE_PRONTO),
        _tela("    /btw list fruits", "      1. Apple", RODAPE_COPIADO),
    ])
    r = btw.perguntar("s", "list   fruits")
    assert r["answer"] == "1. Apple\n2. Banana"
    assert r["fonte"] == "buffer"
    assert r["question"] == "list fruits"
    assert f.teclas == ["C-u", "/btw list fruits", "Enter", "c", "Escape"]
    assert f.buffers == []


def test_psmux_le_o_buffer_da_sessao_e_apaga_as_duas_copias(falso):
    # No psmux o buffer é da sessão e o `-b` é ignorado: ler por nome devolvia vazio com rc 0 e o
    # app mostrava "respondeu, mas não consegui ler" com a resposta parada no buffer.
    f = falso([
        _tela("❯ "),
        _tela("    /btw q", "      corte da tela", RODAPE_PRONTO),
        _tela("    /btw q", "      corte da tela", RODAPE_COPIADO),
    ], modo="psmux", resposta="resposta inteira\ncom duas linhas\n")
    r = btw.perguntar("s", "q")
    assert r["answer"] == "resposta inteira\ncom duas linhas"
    assert r["fonte"] == "buffer"
    assert f.buffers == []


def test_buffer_vazio_cai_no_pane(falso):
    f = falso([
        _tela("❯ "),
        _tela("    /btw q", "      4", RODAPE_PRONTO),
        _tela("    /btw q", "      4", RODAPE_COPIADO),
    ], resposta="")
    r = btw.perguntar("s", "q")
    assert r["answer"] == "4"
    assert r["fonte"] == "pane"


def test_sem_buffer_cai_no_pane(falso):
    f = falso([
        _tela("❯ "),
        _tela("    /btw q", "      4", RODAPE_PRONTO),
        _tela("    /btw q", "      4", RODAPE_COPIADO),
    ], buffer_apos_c=False)
    r = btw.perguntar("s", "q")
    assert r["answer"] == "4"
    assert r["fonte"] == "pane"
    assert f.teclas[-1] == "Escape"


def test_overlay_que_nao_abre_e_409(falso, monkeypatch):
    f = falso([_tela("❯ ")])
    relogio = iter([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    monkeypatch.setattr(btw.time, "monotonic", lambda: next(relogio))
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.status == 409
    assert "Escape" not in f.teclas


def test_pergunta_vazia_nao_digita(falso):
    f = falso([_tela("❯ ")])
    with pytest.raises(btw.BtwError):
        btw.perguntar("s", "   ")
    assert f.teclas == []


def test_rascunho_que_sai_com_c_u_nao_impede_a_pergunta(falso):
    # O rascunho é apagado e a pergunta segue (mesma política do envio normal). Recusar aqui era o
    # pior dos dois mundos: o C-u já tinha levado o rascunho e a pergunta não ia.
    f = falso([
        _tela("❯ rascunho"),
        _tela("    /btw q", "      4", RODAPE_PRONTO),
        _tela("    /btw q", "      4", RODAPE_COPIADO),
    ], buffer_apos_c=False)
    f.digitado = "rascunho"
    assert btw.perguntar("s", "q")["answer"] == "4"
    assert "Enter" in f.teclas


def test_residuo_que_resiste_ao_c_u_para_sem_enter(falso, monkeypatch):
    # Texto que não sai com C-u estraga a linha ("<resíduo>/btw q") e o Enter mandaria isso como
    # MENSAGEM da conversa. Para antes do Enter, e o erro diz que o composer é que está sujo.
    f = falso([_tela("❯ lixo")])
    monkeypatch.setattr(btw, "_esvaziar_composer_claude", lambda name: False)
    monkeypatch.setattr(btw, "_texto_composer_claude", lambda name: "lixo/btwq")
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_composer_ocupado"
    assert "Enter" not in f.teclas


def test_overlay_fechado_por_fora_aborta_sem_escape(falso):
    f = falso([
        _tela("❯ "),
        _tela("    /btw q", "      · Answering…", RODAPE_ANDANDO),
        _tela("❯ "),
    ])
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_fechado"
    assert "Escape" not in f.teclas


def test_historico_guarda_so_os_ultimos(tmp_path, monkeypatch):
    monkeypatch.setattr(btw.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(btw, "MAX_HISTORICO", 3)
    for i in range(5):
        btw.registrar("s", {"question": str(i), "answer": "a", "ts": i})
    assert [it["question"] for it in btw.historico("s")] == ["2", "3", "4"]
    assert len(btw._arquivo("s").read_text().splitlines()) == 3


def test_barra_perdida_redigita_sem_mandar_a_pergunta_pra_conversa(falso):
    # No Windows a `/` inicial sumiu e o Enter submeteu "btw <pergunta>" como MENSAGEM normal: a
    # pergunta caiu na conversa principal e o overlay nunca abriu (13/09/2026).
    f = falso([
        _tela("❯ "),
        _tela("    /btw q", "      4", RODAPE_PRONTO),
        _tela("    /btw q", "      4", RODAPE_COPIADO),
    ], buffer_apos_c=False)
    f.perde_barra = 1
    r = btw.perguntar("s", "q")
    assert r["answer"] == "4"
    primeiro_enter = f.teclas.index("Enter")
    assert f.teclas[:primeiro_enter] == ["C-u", "/btw q", "C-u", "/btw q"]


def test_barra_perdida_de_novo_para_sem_enter(falso):
    f = falso([_tela("❯ ")])
    f.perde_barra = 5
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_barra_perdida"
    assert "Enter" not in f.teclas
    assert f.digitado == ""                 # nada ficou parado no composer
    # Limpeza AS CEGAS no fim: com a tela desalinhada a leitura nao ve o resto, e o proximo
    # envio normal sairia grudado nele (medido ao vivo em 13/09/2026).
    assert f.teclas[-3:] == ["C-u", "C-u", "C-u"]


def test_espera_o_overlay_anterior_fechar_antes_de_digitar(falso):
    # Pergunta logo depois de outra: com o overlay ainda fechando, a `/` se perdia e o texto era
    # desenhado em cima da regua.
    f = falso([
        _tela("    /btw antiga", "      x", RODAPE_PRONTO),     # overlay anterior ainda na tela
        _tela("❯ "),                                        # fechou: a espera para aqui
        _tela("❯ "),                                        # a tela no instante de digitar
        _tela("    /btw q", "      4", RODAPE_PRONTO),
        _tela("    /btw q", "      4", RODAPE_COPIADO),
    ], buffer_apos_c=False)
    btw.perguntar("s", "q")
    assert "Esc to close" not in f.tela_ao_digitar


def test_overlay_que_nao_fecha_para_sem_digitar(falso, monkeypatch):
    # Overlay preso aberto (um /btw feito à mão no terminal): digitar agora cairia DENTRO dele.
    f = falso([_tela("    /btw alheia", "      x", RODAPE_PRONTO)])
    relogio = iter(range(0, 100))
    monkeypatch.setattr(btw.time, "monotonic", lambda: next(relogio))
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_overlay_aberto"
    assert f.teclas == []


def test_composer_ilegivel_depois_de_digitar_para_sem_enter(falso, monkeypatch):
    # Ilegível NÃO é "confirmado": com Enter às cegas a pergunta podia cair na conversa (revisão
    # de falhas silenciosas, 13/09/2026).
    f = falso([_tela("❯ ")])
    leituras = iter([None, None])
    monkeypatch.setattr(btw, "_texto_composer_claude", lambda name: next(leituras))
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_composer_ilegivel"
    assert "Enter" not in f.teclas
    assert f.teclas[-3:] == ["C-u", "C-u", "C-u"]


def test_enter_que_nao_chega_diz_isso_na_hora(falso):
    # Sem conferir o retorno, o Enter perdido so aparecia 6s depois como "nao abriu", culpando o
    # overlay, e o /btw digitado ficava parado no composer.
    f = falso([_tela("❯ ")])
    f.falha_enter = True
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_enter_nao_enviado"
    assert f.teclas[-3:] == ["C-u", "C-u", "C-u"]


def test_composer_ilegivel_uma_vez_relê_e_segue(falso, monkeypatch):
    f = falso([
        _tela("❯ "),
        _tela("    /btw q", "      4", RODAPE_PRONTO),
        _tela("    /btw q", "      4", RODAPE_COPIADO),
    ], buffer_apos_c=False)
    leituras = iter([None, "/btwq"])
    monkeypatch.setattr(btw, "_texto_composer_claude", lambda name: next(leituras))
    assert btw.perguntar("s", "q")["answer"] == "4"


def test_sessao_sem_terminal_recusa_antes_de_tocar_no_tmux(monkeypatch):
    # A CLI sem terminal responde "/btw isn't available in this environment": não há pane pra dirigir.
    from fastapi import HTTPException

    from app import api
    monkeypatch.setattr(api, "_headless", lambda name: True)
    monkeypatch.setattr(api, "_pane_info", lambda name: pytest.fail("não devia olhar o pane"))
    with pytest.raises(HTTPException) as e:
        api._exige_claude_de_terminal("s1")
    assert e.value.status_code == 400 and e.value.detail["code"] == "erro_btw_sem_terminal"
