import os

import pytest

from app import main


def test_log_preso_abre_com_outro_nome(tmp_path):
    alvo = tmp_path / "hangar-backend.log"
    alvo.mkdir()   # o open falha como no arquivo preso
    arquivo, usado = main._abrir_log(alvo)
    try:
        assert usado == tmp_path / "hangar-backend.1.log"
        arquivo.write("subiu\n")
    finally:
        arquivo.close()
    assert usado.read_text(encoding="utf-8") == "subiu\n"


def test_argumento_log_sai_do_argv(tmp_path):
    argv = ["app.main", "--log", str(tmp_path / "x.log"), "--outro"]
    assert main._tirar_log(argv) == tmp_path / "x.log"
    assert argv == ["app.main", "--outro"]
    assert main._tirar_log(["app.main"]) is None


@pytest.mark.skipif(os.name != "nt", reason="compartilhamento de arquivo do Windows")
def test_neto_com_o_log_aberto_nao_impede_a_proxima_subida(tmp_path):
    alvo = tmp_path / "hangar-backend.log"
    neto, _ = main._abrir_log(alvo)   # a cópia herdada que sobrevive ao backend
    try:
        arquivo, usado = main._abrir_log(alvo)
        arquivo.close()
        assert usado == alvo
    finally:
        neto.close()


@pytest.mark.skipif(os.name != "nt", reason="compartilhamento de arquivo do Windows")
def test_handle_do_cmd_sem_escrita_compartilhada_leva_a_outro_nome(tmp_path):
    import ctypes
    from ctypes import wintypes
    alvo = tmp_path / "hangar-backend.log"
    create = ctypes.windll.kernel32.CreateFileW
    create.restype = wintypes.HANDLE
    # GENERIC_WRITE, só FILE_SHARE_READ, CREATE_ALWAYS: o `>` do cmd.
    handle = create(str(alvo), 0x40000000, 0x1, None, 2, 0x80, None)
    assert handle != wintypes.HANDLE(-1).value
    try:
        arquivo, usado = main._abrir_log(alvo)
        arquivo.close()
        assert usado == tmp_path / "hangar-backend.1.log"
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)
