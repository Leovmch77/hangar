import pytest

from app.terminal_prompt import parse_prompt


@pytest.mark.parametrize("line,expected", [
    ("Pasta do PSS na VM [C:\\Sistemas\\PServer\\PSS]: ",
     {"text": "Pasta do PSS na VM", "default": "C:\\Sistemas\\PServer\\PSS"}),
    ("Destino SSH da VM (usuario@host ou alias do ~/.ssh/config) [Administrator@delphi-02]:",
     {"text": "Destino SSH da VM (usuario@host ou alias do ~/.ssh/config)", "default": "Administrator@delphi-02"}),
    ("Porta [3000]: ", {"text": "Porta", "default": "3000"}),
    ("Senha: ", {"text": "Senha", "default": ""}),
    ("Continuar? ", {"text": "Continuar?", "default": ""}),
])
def test_prompt_lines(line, expected):
    assert parse_prompt(line) == expected


@pytest.mark.parametrize("line", [
    "", "   ", ":",
    "[12:00:01] ATIVO: VM 127.0.0.1:3000 -> esta máquina 127.0.0.1:3000. Ctrl+C para parar.",
    "[12:00:01] Não consegui ler a porta do PMW na VM (SSH ou appsettings). Tentando de novo em 15s.",
    "~/projeto-web $ ", "usuario@maquina:~$ ", "PS C:\\Users\\Administrator> ",
])
def test_not_a_prompt(line):
    assert parse_prompt(line) is None
