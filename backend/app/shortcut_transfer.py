"""Exportar e importar os atalhos da fileira sem levar credencial junto.

A exportacao troca cada valor de segredo por `⟦SEGREDO:<nome>⟧` antes de sair do backend: quem
recebe o arquivo preenche a propria senha na importacao. E uma funcao so (`scrub`) para os dois
clientes, e ela nunca registra o texto do comando nem o valor encontrado.

A importacao junta ao que ja existe: mesmo `id` substitui, id novo entra no fim, a ordem atual
fica. Marcador que a pessoa deixou em branco continua no atalho, e o backend recusa rodar comando
com marcador (ver `has_placeholder`).
"""
import json
import re

from app import runtime_config as rc
from app.config import _PALAVRAS_DE_SEGREDO

VERSION = 1
PLACEHOLDER_RE = re.compile(r"⟦SEGREDO:([A-Za-z0-9_.-]+)⟧")

# Valor de opcao: entre aspas (o conteudo e o segredo, as aspas ficam) ou ate o proximo espaco.
_VALUE = r"""(?P<q>["'])?(?P<v>(?(q)(?:(?!(?P=q)).)+|[^\s"';|&]+))(?(q)(?P=q))"""

# Referencia a variavel nao e segredo: `/p:$SENHA` continua util e nao revela nada.
def _is_reference(value: str) -> bool:
    return value.startswith("$") or value.startswith("⟦")


_FLAG_NAMES = {"password": "senha", "passwd": "senha", "pass": "senha", "token": "token",
               "access-token": "token", "auth-token": "token", "api-key": "api_key",
               "apikey": "api_key", "secret": "segredo", "client-secret": "segredo"}

_RULES: list[tuple[re.Pattern, str | None]] = [
    # xfreerdp: /p:<senha> e /password:<senha>
    (re.compile(r"(?<![\w/])/(?:p|password):" + _VALUE), "senha"),
    # --password=<x> / --password <x> e parentes (token, api-key, secret)
    (re.compile(r"(?<![\w-])--(?P<flag>" + "|".join(sorted(_FLAG_NAMES, key=len, reverse=True))
                + r")(?:=|\s+)" + _VALUE), None),
    # sshpass -p <senha> (com ou sem espaco)
    (re.compile(r"\bsshpass\s+(?:-\w+\s+)*?-p\s*" + _VALUE), "senha"),
    # mysql e parentes: so -p colado (-p com espaco e o prompt interativo)
    (re.compile(r"\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]*?\s-p" + _VALUE), "senha"),
    # Cabecalho de autorizacao
    (re.compile(r"(?i)\bAuthorization:\s*(?:Bearer|Basic|Token)\s+" + _VALUE), "token"),
    # URL com usuario:senha@
    (re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s:/@]+:(?P<v>[^\s@/]+)@"), "senha"),
]

# NOME=valor e `set -x NOME valor` (fish) quando o nome parece de segredo.
_ENV_RE = re.compile(r"(?<![\w$])(?P<name>[A-Za-z_][A-Za-z0-9_]*)=" + _VALUE)
_FISH_SET_RE = re.compile(r"\bset\s+(?:-[a-zA-Z]+\s+)+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+" + _VALUE)

# Chaves com prefixo conhecido, soltas no texto.
_TOKEN_RE = re.compile(
    r"\b(?:gsk_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})")


def _secret_name(name: str) -> bool:
    return any(p in name.lower() for p in _PALAVRAS_DE_SEGREDO)


def scrub(text: str) -> tuple[str, list[str]]:
    """Troca os segredos de `text` por marcadores. Devolve o texto e os nomes usados, na ordem."""
    names: list[str] = []

    def mark(base: str) -> str:
        # Dois segredos do mesmo tipo no mesmo comando ganham nomes distintos (senha, senha_2).
        count = sum(1 for n in names if n == base or n.startswith(base + "_"))
        name = base if count == 0 else f"{base}_{count + 1}"
        names.append(name)
        return f"⟦SEGREDO:{name}⟧"

    def replacer(fixed: str | None):
        def run(m: re.Match) -> str:
            value = m.group("v")
            if _is_reference(value):
                return m.group(0)
            if fixed is None:
                base = _FLAG_NAMES.get(m.group("flag").lower(), "segredo")
            elif fixed == "@env":
                if not _secret_name(m.group("name")):
                    return m.group(0)
                base = m.group("name")
            else:
                base = fixed
            start, end = m.span("v")
            whole = m.group(0)
            offset = m.start()
            return whole[:start - offset] + mark(base) + whole[end - offset:]
        return run

    for rule, fixed in _RULES:
        text = rule.sub(replacer(fixed), text)
    text = _ENV_RE.sub(replacer("@env"), text)
    text = _FISH_SET_RE.sub(replacer("@env"), text)
    text = _TOKEN_RE.sub(lambda m: mark("token"), text)
    return text, names


def has_placeholder(text: str) -> str | None:
    """Nome do primeiro marcador ainda sem valor no texto, ou None."""
    m = PLACEHOLDER_RE.search(text or "")
    return m.group(1) if m else None


def _current() -> list[dict]:
    raw = rc.get("shortcuts") or ""
    try:
        items = json.loads(raw) if raw else []
    except ValueError:
        return []
    return items if isinstance(items, list) else []


def _field(item: dict) -> str | None:
    return {"shell": "command", "send_text": "text"}.get(item.get("type"))


def export_payload() -> dict:
    """Os atalhos como estao gravados, sem os valores de segredo. `removed` = quantos saíram."""
    out, removed = [], 0
    for item in _current():
        item = dict(item)
        field = _field(item)
        if field and isinstance(item.get(field), str):
            item[field], names = scrub(item[field])
            removed += len(names)
        out.append(item)
    return {"version": VERSION, "shortcuts": out, "removed": removed}


MAX_IMPORT_CHARS = 1_000_000


def _parse(data) -> list[dict]:
    items = data.get("shortcuts") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ValueError("arquivo sem lista de atalhos")
    raw = json.dumps(items)
    # Vai inteiro pra config e pra resposta da prévia; um arquivo errado de MBs travaria as duas.
    if len(raw) > MAX_IMPORT_CHARS:
        raise ValueError("arquivo grande demais para uma lista de atalhos")
    rc._validate_shortcuts(raw)
    return items


def _placeholders(items: list[dict]) -> list[dict]:
    found = []
    for item in items:
        field = _field(item)
        names = PLACEHOLDER_RE.findall(item.get(field) or "") if field else []
        if names:
            found.append({"id": item["id"], "label": item.get("label") or item["id"],
                          "names": list(dict.fromkeys(names))})
    return found


def _fill(items: list[dict], secrets: dict) -> list[dict]:
    out = []
    for item in items:
        item = dict(item)
        field = _field(item)
        values = secrets.get(item["id"]) if isinstance(secrets, dict) else None
        if field and isinstance(values, dict):
            def put(m: re.Match) -> str:
                value = values.get(m.group(1))
                return value if isinstance(value, str) and value != "" else m.group(0)
            item[field] = PLACEHOLDER_RE.sub(put, item[field])
        out.append(item)
    return out


def _merge(current: list[dict], incoming: list[dict]) -> tuple[list[dict], int, int]:
    by_id = {item["id"]: item for item in incoming}
    replaced = sum(1 for item in current if item.get("id") in by_id)
    merged = [by_id.get(item.get("id"), item) for item in current]
    known = {item.get("id") for item in current}
    added = [item for item in incoming if item["id"] not in known]
    return merged + added, len(added), replaced


def import_shortcuts(data, apply: bool = False, secrets: dict | None = None) -> dict:
    """Confere o arquivo e diz o que muda; com `apply`, preenche os segredos dados e grava.
    ValueError = arquivo invalido, nada muda."""
    incoming = _parse(data)
    if apply:
        incoming = _fill(incoming, secrets or {})
    merged, added, replaced = _merge(_current(), incoming)
    result = {"added": added, "replaced": replaced, "placeholders": _placeholders(incoming)}
    if apply:
        rc.aplicar({"shortcuts": json.dumps(merged, ensure_ascii=False)})
    return result
