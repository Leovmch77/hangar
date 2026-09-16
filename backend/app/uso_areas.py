"""Área do código (front, back, banco, infra, docs, outros) de um caminho tocado por uma tool.

Mapa editável em `~/.hangar/uso-areas.json` (opcional; sem ele vale `PADRAO`):

    {
      "padrao":   [["banco", ["*.sql"]], ["front", ["web/*"]]],
      "projetos": {"/home/eu/acme-web": [["front", ["src/app/*"]], ["back", ["src/server/*"]]],
                   "acme-api": [["back", ["*.ts"]]]}
    }

- A primeira regra que casa vence: as do projeto antes, depois `padrao` (que substitui `PADRAO`).
- Projeto = caminho absoluto (prefixo do cwd) ou nome de uma pasta do cwd.
- Padrão é `fnmatch` sobre o caminho relativo à raiz do repositório e casa em qualquer nível
  (`migrations/*` pega `backend/migrations/x.sql`). `skill:<nome>` casa a chamada de skill.
- O mapa é lido UMA vez por processo e entra na versão do cache dos transcripts: editou,
  reinicie o backend e a tela relê tudo (mostra "aquecendo").
Só stdlib.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path

OUTROS = "outros"
CONVERSA = "conversa"

PADRAO: list[tuple[str, list[str]]] = [
    ("banco", ["*.sql", "migrations/*", "prisma/*", "skill:*database*"]),
    ("infra", ["Dockerfile*", "*.dockerfile", "docker-compose*", "k8s/*", "helm/*", "charts/*",
               ".github/*", ".gitlab-ci.yml", "Jenkinsfile", "scripts/*", "deploy/*", "install.*",
               "*.sh", "*.ps1"]),
    ("docs", ["docs/*", "*.md"]),
    ("front", ["frontend/*", "packages/core/*", "mobile/*", "messages/*", "locales/*", "*.svelte",
               "*.tsx", "*.jsx", "*.css", "*.scss", "*.html", "*.dart"]),
    ("back", ["backend/*", "*pserver*", "*.py", "*.cs", "*.pas", "*.go"]),
]


def repartir(valor: int, pesos: dict[str, int]) -> dict[str, int]:
    """Divide `valor` na proporção dos pesos por maior resto: a soma fecha exata, sem sobra."""
    total = sum(pesos.values())
    exatos = {a: valor * n / total for a, n in pesos.items()}
    inteiros = {a: int(x) for a, x in exatos.items()}
    for a in sorted(exatos, key=lambda a: inteiros[a] - exatos[a])[:valor - sum(inteiros.values())]:
        inteiros[a] += 1
    return inteiros


def _arquivo() -> Path:
    return Path.home() / ".hangar" / "uso-areas.json"


def _regras(bruto) -> list[tuple[str, list[str]]]:
    out = []
    for item in bruto if isinstance(bruto, list) else []:
        if (isinstance(item, list) and len(item) == 2 and isinstance(item[0], str)
                and isinstance(item[1], list)):
            out.append((item[0], [p for p in item[1] if isinstance(p, str)]))
    return out


@lru_cache(maxsize=1)
def _mapa() -> tuple[str, list, dict[str, list]]:
    # O PADRAO do código entra na assinatura: mudar a regra embutida também relê o cache.
    try:
        texto = _arquivo().read_text(encoding="utf-8")
        bruto = json.loads(texto)
    except (OSError, ValueError):
        texto, bruto = "", None
    assinatura = hashlib.sha256((repr(PADRAO) + texto).encode()).hexdigest()[:12]
    if not isinstance(bruto, dict):
        return assinatura, PADRAO, {}
    padrao = _regras(bruto["padrao"]) if "padrao" in bruto else PADRAO
    projetos = bruto.get("projetos") if isinstance(bruto.get("projetos"), dict) else {}
    return assinatura, padrao, {k: _regras(v) for k, v in projetos.items()}


def assinatura() -> str:
    return _mapa()[0]


def recarregar() -> None:
    _mapa.cache_clear()
    raiz_do_repo.cache_clear()


@lru_cache(maxsize=4096)
def raiz_do_repo(pasta: str) -> str:
    """Pasta com `.git` acima de `pasta`; "" quando não há repositório."""
    p = Path(pasta)
    for d in (p, *p.parents):
        if (d / ".git").exists():
            return str(d)
    return ""


def regras_de(cwd: str) -> list[tuple[str, list[str]]]:
    _, padrao, projetos = _mapa()
    partes = Path(cwd).parts
    do_projeto = []
    for chave, regras in projetos.items():
        if "/" in chave or os.sep in chave:
            if cwd == chave or cwd.startswith(chave.rstrip("/\\") + os.sep):
                do_projeto += regras
        elif chave in partes:
            do_projeto += regras
    return do_projeto + padrao


def _casa(alvo: str, padrao: str) -> bool:
    return fnmatch.fnmatchcase(alvo, padrao) or fnmatch.fnmatchcase("/" + alvo, "*/" + padrao)


def area_do_alvo(alvo: str, regras: list[tuple[str, list[str]]]) -> str | None:
    for area, padroes in regras:
        if any(_casa(alvo, p) for p in padroes):
            return area
    return None


def _dentro(p: str, raiz: str) -> bool:
    return bool(raiz) and (p == raiz or p.startswith(raiz.rstrip(os.sep) + os.sep))


def area_do_caminho(caminho: str, cwd: str, regras: list[tuple[str, list[str]]]) -> str:
    """A raiz é a do repositório do PRÓPRIO arquivo (worktree, repo vizinho), com as regras
    dele; sem repositório, a do cwd. Fora dos dois é `outros` — um Read em /tmp não é o front."""
    p = os.path.normpath(caminho if os.path.isabs(caminho) or not cwd else os.path.join(cwd, caminho))
    raiz = raiz_do_repo(os.path.dirname(p))
    if raiz and raiz != raiz_do_repo(cwd):
        regras = regras_de(raiz)
    elif not raiz:
        raiz = (raiz_do_repo(cwd) or cwd) if cwd else ""
    if not _dentro(p, raiz):
        return OUTROS
    return area_do_alvo(os.path.relpath(p, raiz).replace(os.sep, "/"), regras) or OUTROS


def areas_do_comando(cmd: str, cwd: str, regras: list[tuple[str, list[str]]]) -> set[str]:
    """Áreas dos caminhos citados num comando Bash. Palavra que não parece caminho (sem `/` nem
    extensão) é ignorada, e o que cai em `outros` também: `2>/dev/null` não é área."""
    out = set()
    for tok in cmd.replace("=", " ").split():
        t = tok.strip("'\"();&|<>")
        if not t or t.startswith("-") or "://" in t or "$" in t:
            continue
        if "/" not in t and "." not in t.lstrip("."):
            continue
        a = area_do_caminho(t, cwd, regras)
        if a != OUTROS:
            out.add(a)
    return out
