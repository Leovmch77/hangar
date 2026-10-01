"""claude -p escolhe a conta com cota e mostra o motivo real da falha."""
import subprocess

import pytest

from app import cotas, loop
from app.cotas import CotaConta, JanelaCota

LIMITE = "You've hit your weekly limit · resets Oct 3, 6pm (America/Sao_Paulo)"


def _cota(path, ativa=False, h5=10.0, d7=10.0, estado="lida"):
    return CotaConta(id=f"claude:{path}", label=path, provedor="claude", ativa=ativa, estado=estado,
                     janelas=[JanelaCota(rotulo="5h", pct=h5), JanelaCota(rotulo="7d", pct=d7)])


def _cp(rc=0, out="", err=""):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=out, stderr=err)


@pytest.fixture
def fake(monkeypatch):
    """Registra cada chamada (conta usada) e responde da fila `respostas`."""
    estado = {"lidas": [], "respostas": [], "contas": []}
    monkeypatch.setattr(loop, "_exe_claude", lambda: "claude")
    monkeypatch.setattr(cotas, "cotas_claude", lambda atualizar=False: estado["lidas"])

    def run(*a, **kw):
        env = kw.get("env")
        estado["contas"].append(None if env is None else env["CLAUDE_CONFIG_DIR"])
        return estado["respostas"].pop(0)

    monkeypatch.setattr(loop.subprocess, "run", run)
    return estado


def test_erro_so_no_stdout_aparece_na_mensagem(fake):
    fake["respostas"] = [_cp(1, out=LIMITE)]
    with pytest.raises(loop.ClaudePError, match="hit your weekly limit"):
        loop._claude_p("q")


def test_conta_padrao_nao_define_config_dir(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-b", d7=0)]
    fake["respostas"] = [_cp(0, out="resposta")]
    assert loop._claude_p("q") == "resposta"
    assert fake["contas"] == [None]


def test_padrao_esgotada_vai_para_a_de_mais_folga_semanal(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True, d7=100),
                     _cota("/h/.claude-a", d7=60),
                     _cota("/h/.claude-b", d7=20),
                     _cota("/h/.claude-c", h5=100, d7=0),
                     _cota("/h/.claude-d", d7=0, estado="expirada")]
    fake["respostas"] = [_cp(0, out="ok")]
    assert loop._claude_p("q") == "ok"
    assert fake["contas"] == ["/h/.claude-b"]


def test_limite_tenta_uma_vez_a_proxima(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-a"), _cota("/h/.claude-b")]
    fake["respostas"] = [_cp(1, out=LIMITE), _cp(0, out="ok")]
    assert loop._claude_p("q") == "ok"
    assert fake["contas"] == [None, "/h/.claude-a"]


def test_limite_nas_duas_falha_com_a_mensagem_real(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-a"), _cota("/h/.claude-b")]
    fake["respostas"] = [_cp(1, out=LIMITE), _cp(1, out=LIMITE)]
    with pytest.raises(loop.ClaudePError, match="hit your weekly limit"):
        loop._claude_p("q")
    assert fake["contas"] == [None, "/h/.claude-a"]


def test_falha_comum_nao_troca_de_conta(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-a")]
    fake["respostas"] = [_cp(1, err="boom")]
    with pytest.raises(loop.ClaudePError, match="boom"):
        loop._claude_p("q")
    assert fake["contas"] == [None]


def test_limite_com_exit_zero_troca_de_conta(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-a")]
    fake["respostas"] = [_cp(0, out=LIMITE), _cp(0, out="ok")]
    assert loop._claude_p("q") == "ok"
    assert fake["contas"] == [None, "/h/.claude-a"]


def test_resposta_que_cita_limite_nao_e_limite(fake):
    resposta = "Para evitar o rate limit, you've hit your weekly limit aparece quando a cota acaba."
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-a")]
    fake["respostas"] = [_cp(0, out=resposta)]
    assert loop._claude_p("q") == resposta
    assert fake["contas"] == [None]


def test_erro_final_cita_conta_do_limite_e_segunda_falha(fake):
    fake["lidas"] = [_cota("/h/.claude", ativa=True), _cota("/h/.claude-a")]
    fake["respostas"] = [_cp(1, out=LIMITE), _cp(1, err="boom")]
    with pytest.raises(loop.ClaudePError) as e:
        loop._claude_p("q")
    assert "conta padrão bateu o limite" in str(e.value) and "boom" in str(e.value)


def test_releitura_falha_preserva_erro_de_limite(fake, monkeypatch):
    def cotas_claude(atualizar=False):
        if atualizar:
            raise RuntimeError("rede")
        return [_cota("/h/.claude", ativa=True)]

    monkeypatch.setattr(cotas, "cotas_claude", cotas_claude)
    fake["respostas"] = [_cp(1, out=LIMITE)]
    with pytest.raises(loop.ClaudePError, match="hit your weekly limit"):
        loop._claude_p("q")


def test_sem_leitura_avisa_que_caiu_na_padrao(fake, caplog):
    fake["respostas"] = [_cp(0, out="ok")]
    with caplog.at_level("WARNING", logger="hangar.loop"):
        loop._claude_p("q")
    assert "sem dados" in caplog.text
