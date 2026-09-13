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
    def __init__(self, telas, buffer_apos_c=True):
        self.telas = list(telas)
        self.teclas = []
        self.buffers = []
        self.buffer_apos_c = buffer_apos_c
        self.apagados = []

    def capture_pane(self, name, lines=200):
        return self.telas.pop(0) if len(self.telas) > 1 else self.telas[0]

    def send_keys(self, name, keys, literal=False):
        self.teclas.append(keys)
        if keys == "c" and self.buffer_apos_c:
            self.buffers.append("buffer7")
        return True

    def _run(self, args, input=None):
        if args[1] == "list-buffers":
            return subprocess.CompletedProcess(args, 0, "\n".join(self.buffers) + "\n", "")
        if args[1] == "show-buffer":
            return subprocess.CompletedProcess(args, 0, "1. Apple\n2. Banana\n", "")
        if args[1] == "delete-buffer":
            self.apagados.append(args[3])
            return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError(args)


@pytest.fixture
def falso(monkeypatch):
    def montar(telas, **kw):
        f = TmuxFalso(telas, **kw)
        monkeypatch.setattr(btw.tmux, "capture_pane", f.capture_pane)
        monkeypatch.setattr(btw.tmux, "send_keys", f.send_keys)
        monkeypatch.setattr(btw.tmux, "_run", f._run)
        monkeypatch.setattr(btw, "_esvaziar_composer_claude", lambda name: True)
        monkeypatch.setattr(btw, "_texto_composer_claude", lambda name: "")
        monkeypatch.setattr(btw.time, "sleep", lambda s: None)
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
    assert f.teclas == ["/btw list fruits", "Enter", "c", "Escape"]
    assert f.apagados == ["buffer7"]


def test_sem_buffer_cai_no_pane(falso):
    f = falso([
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


def test_composer_com_texto_parado_nao_digita(falso, monkeypatch):
    f = falso([_tela("❯ rascunho")])
    monkeypatch.setattr(btw, "_texto_composer_claude", lambda name: "rascunho")
    with pytest.raises(btw.BtwError) as e:
        btw.perguntar("s", "q")
    assert e.value.code == "erro_btw_composer_ocupado"
    assert f.teclas == []


def test_overlay_fechado_por_fora_aborta_sem_escape(falso):
    f = falso([
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
