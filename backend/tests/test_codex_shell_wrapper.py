"""O `codex` do shell: quando o `hangar-codex` não abre sessão nenhuma (sai com 3, ou não existe), o
codex oficial abre no lugar, em vez de o comando parar de funcionar."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

_SHELL = Path(__file__).resolve().parents[2] / "scripts" / "shell"


def _bin(tmp_path: Path, lancador: str | None) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "codex").write_text(f'#!/bin/sh\necho "cru $*" > "{tmp_path}/cru"\n')
    if lancador is not None:
        (bin_dir / "hangar-codex").write_text(lancador)
    for f in bin_dir.iterdir():
        f.chmod(0o755)
    return bin_dir


def _interativo(tmp_path: Path, comando: str) -> None:
    # `script` dá ao shell um terminal de verdade: o wrapper só intercepta o uso interativo.
    env = {"PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin", "HOME": str(tmp_path), "TERM": "dumb"}
    subprocess.run(["script", "-qec", comando, "/dev/null"], env=env, timeout=30, check=False,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


_CASOS = [("#!/bin/sh\nexit 3\n", "cru oi"), (None, "cru oi"), ("#!/bin/sh\nexit 0\n", None)]


@pytest.mark.skipif(not shutil.which("script") or not shutil.which("bash"), reason="precisa de script e bash")
@pytest.mark.parametrize("lancador,esperado", _CASOS)
def test_posix_cai_no_codex_oficial_quando_o_hangar_nao_abre(tmp_path, lancador, esperado):
    _bin(tmp_path, lancador)
    _interativo(tmp_path, f"bash -c '. {_SHELL / 'codex.posix.sh'}; codex oi'")
    cru = tmp_path / "cru"
    assert (cru.read_text().strip() if cru.exists() else None) == esperado


@pytest.mark.skipif(not shutil.which("script") or not shutil.which("fish"), reason="precisa de script e fish")
@pytest.mark.parametrize("lancador,esperado", _CASOS)
def test_fish_cai_no_codex_oficial_quando_o_hangar_nao_abre(tmp_path, lancador, esperado):
    _bin(tmp_path, lancador)
    _interativo(tmp_path, f"fish --no-config -c 'source {_SHELL / 'codex.fish'}; codex oi'")
    cru = tmp_path / "cru"
    assert (cru.read_text().strip() if cru.exists() else None) == esperado


# `.cmd` só executa no Windows: o runner Linux tem pwsh, mas lá o falso nunca roda.
@pytest.mark.skipif(os.name != "nt" or not shutil.which("pwsh"), reason="precisa do Windows com PowerShell (pwsh); conferir na DELPHI-02")
def test_powershell_cai_no_codex_oficial_quando_o_hangar_sai_com_3(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "codex.cmd").write_text(f'@echo cru %* > "{tmp_path}\\cru"\r\n')
    (bin_dir / "hangar-codex.cmd").write_text("@exit /b 3\r\n")
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
    subprocess.run(["pwsh", "-NoProfile", "-Command", f". '{_SHELL / 'codex.ps1'}'; codex oi"], env=env, timeout=60, check=False)
    assert (tmp_path / "cru").read_text().strip() == "cru oi"
