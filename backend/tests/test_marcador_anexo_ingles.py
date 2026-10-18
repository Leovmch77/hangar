"""O web grava o marcador de anexo no idioma da tela de quem enviou: `image:`/`file:` em inglês."""

from app.adapters.claude_headless.adapter import _IMG_RE
from app.pqueue import _strip_attach


def test_legenda_sai_sem_o_marcador_em_ingles():
    assert _strip_attach("look — 📎 image: /a.png 📎 file: /b.txt") == "look"
    assert _strip_attach("olha — 📎 arquivo: /b.txt") == "olha"


def test_imagem_em_ingles_e_capturada_e_arquivo_nao():
    assert _IMG_RE.findall("look — 📎 image: /a.png 📎 file: /b.txt") == ["/a.png"]
    assert _IMG_RE.findall("olha — 📎 imagem: /a.png") == ["/a.png"]
