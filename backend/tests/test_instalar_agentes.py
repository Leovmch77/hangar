"""instalar-agentes: um .md de agente vira link no Claude e .toml em cada home do Codex."""
import subprocess
import sys
import tomllib
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / "scripts" / "instalar-agentes.py"


def test_instala_nos_dois_e_e_idempotente(tmp_path):
    (tmp_path / ".codex").mkdir(); (tmp_path / ".codex" / "config.toml").write_text("")
    (tmp_path / ".codex-conta2" / "agents").mkdir(parents=True)
    (tmp_path / ".codex-sem-nada").mkdir()
    for _ in range(2):
        subprocess.run([sys.executable, str(SCRIPT), "--home", str(tmp_path)], check=True)
    for nome, marca in (("preparar-plano", "faltam:"), ("revisor-orq", "review package")):
        link = tmp_path / ".claude" / "agents" / f"{nome}.md"
        assert link.is_symlink() and link.resolve() == RAIZ / f"skills/orquestrar/agents/{nome}.md"
        for home in (".codex", ".codex-conta2"):
            t = tomllib.loads((tmp_path / home / "agents" / f"{nome}.toml").read_text())
            assert t["name"] == nome
            assert marca in t["developer_instructions"]
            assert not t["developer_instructions"].startswith("---")
    assert not (tmp_path / ".codex-sem-nada" / "agents").exists()
