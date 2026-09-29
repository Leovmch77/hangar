"""Atalhos por projeto: listas guardadas nesta maquina, fora do repositorio.

Mesmo lugar e mesma forma de gravar do `.hangar-runner.json` (app/runner.py). A chave e o repo
git, nao a pasta da sessao: todas as worktrees e subpastas de um repo veem a mesma lista.
"""
import json
import os
import threading
from pathlib import Path
from typing import Any

from app import atomico, git_ops
from app.config import settings
from app.runtime_config import validate_shortcut_item

_GIT_TIMEOUT = 3.0

# Serializa o read-modify-write: dois PUT juntos liam o mesmo arquivo e o ultimo apagava o outro.
_LOCK = threading.Lock()


class ProjectError(Exception):
    """Nao da pra saber de qual projeto e a pasta. Nunca cai noutra chave: gravaria num lugar
    que nenhuma sessao do repo le, e a lista pareceria apagada."""


class FileError(Exception):
    """O arquivo existe mas nao le. Nunca vira "sem atalhos": a gravacao seguinte reescreveria o
    arquivo so com este projeto e apagaria a lista de todos os outros."""


def _path() -> Path:
    return Path(settings.projects_dir).parent / ".hangar-project-shortcuts.json"


def _key(path: str) -> str:
    # git devolve `C:/x` e a sessao tem `C:\X`: a chave precisa casar nos dois.
    return os.path.normcase(str(Path(path).resolve()))


def project_of(cwd: str) -> dict[str, str]:
    """{"key", "name", "root"}: chave = repo (sem o `/.git`), raiz = a copia da sessao."""
    base = Path(cwd)
    if not base.is_dir():
        raise ProjectError(f"pasta da sessao nao existe: {cwd}")
    try:
        p = git_ops._run(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir",
                         "--show-toplevel", timeout=_GIT_TIMEOUT)
        lines = p.stdout.strip().splitlines() if p.returncode == 0 else []
        failure = p.stderr.strip()
    except git_ops.GitError as e:
        lines, failure = [], e.detail
    if len(lines) == 2:
        common, root = lines
        if common.endswith(("/.git", "\\.git")):
            common = common[:-5]
        resolved = Path(common).resolve()
        return {"key": _key(common), "name": resolved.name or str(resolved),
                "root": str(Path(root).resolve())}
    resolved = base.resolve()
    if any((d / ".git").exists() for d in (resolved, *resolved.parents)):
        raise ProjectError(f"git falhou em {cwd}: {failure or 'sem resposta'}")
    return {"key": _key(cwd), "name": resolved.name or str(resolved), "root": str(resolved)}


def _load() -> dict:
    p = _path()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise FileError(f"{p}: {e}") from e
    if not isinstance(data, dict):
        raise FileError(f"{p}: esperado um objeto JSON")
    return data


def load_items(key: str) -> list:
    entry = _load().get(key)
    items = entry.get("items") if isinstance(entry, dict) else None
    return items if isinstance(items, list) else []


def validate_items(items: Any) -> None:
    """Regras dos globais, mais: sem internos, sem id repetido e `pasta` opcional no shell.
    `pasta` so existe aqui: caminho desta maquina nao pode viajar no export dos globais."""
    if not isinstance(items, list):
        raise ValueError("items: esperado uma lista de atalhos")
    seen = set()
    for i, item in enumerate(items, start=1):
        where = f"item {i}"
        if isinstance(item, dict) and item.get("type") == "internal":
            raise ValueError(f"{where}: atalho interno nao vale por projeto")
        validate_shortcut_item(item, where)
        pasta = item.get("pasta")
        if item["type"] == "shell" and pasta is not None and (
                not isinstance(pasta, str) or not pasta.strip()):
            raise ValueError(f"{where} (shell) com pasta vazia")
        if item["id"] in seen:
            raise ValueError(f"{where}: id '{item['id']}' repetido")
        seen.add(item["id"])


def save_items(key: str, items: list) -> None:
    """Grava a lista INTEIRA do projeto; lista vazia tira a chave do arquivo."""
    validate_items(items)
    with _LOCK:
        p = _path()
        p.parent.mkdir(parents=True, exist_ok=True)
        data = _load()
        if items:
            data[key] = {"items": items}
        else:
            data.pop(key, None)
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        atomico.substituir(tmp, p)


def describe(cwd: str) -> dict:
    project = project_of(cwd)
    return {**project, "items": load_items(project["key"])}


def resolve_folder(cwd: str, pasta: str) -> str:
    """Pasta de um atalho shell: absoluta, ou relativa a raiz da copia da sessao."""
    pasta = pasta.strip()
    path = pasta if os.path.isabs(pasta) else os.path.join(project_of(cwd)["root"], pasta)
    if not os.path.isdir(path):
        raise ValueError(f"pasta nao existe: {path}")
    return path
