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
from app.config_sync_paths import Roots, canonicalize, resolve
from app import shortcut_scripts

VERSION = 2
PLACEHOLDER_RE = re.compile(r"⟦SEGREDO:([A-Za-z0-9_.-]+)⟧")

# Um valor pode concatenar trechos entre aspas, escapados e literais sem espaços entre eles.
_SINGLE = r"'[^']*'"
_FISH_SINGLE = r"'(?:\\.|[^'\\])*'"
_DOUBLE = r'"(?:\\.|[^"\\])*"'
_BACKTICK = r"`(?:\\.|[^`\\])*`"
_PARENS = r"\((?:[^()\\]|\\.|\([^()]*\))*\)"
_BARE = r"[^\s\"'\\;|&()`]+"
_VALUE = (r"(?P<v>(?:" + _SINGLE + "|" + _DOUBLE + r"|\$" + _PARENS + "|"
          + _BACKTICK + "|" + _PARENS + r"|\\.|" + _BARE + r")+)")


def _is_reference(value: str, quote: str | None, fish: bool = False, shell: bool = True) -> bool:
    if PLACEHOLDER_RE.fullmatch(value):
        return True
    if quote == "'" or not shell:
        return False
    return bool(re.fullmatch(r"\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}", value)
                or re.fullmatch(r"\$" + _PARENS + "|" + _BACKTICK, value)
                or (fish and quote is None and re.fullmatch(_PARENS, value)))


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
_ENV_RE = re.compile(r"(?<![\w$])(?P<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?![=>])[ \t]*" + _VALUE)
_FISH_SET_RE = re.compile(r"\bset\s+(?:-[a-zA-Z]+\s+)*(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+" + _VALUE.replace(_SINGLE, _FISH_SINGLE))

# Chaves com prefixo conhecido, soltas no texto.
_TOKEN_RE = re.compile(
    r"\b(?:gsk_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})")


def _secret_name(name: str) -> bool:
    return any(p in name.lower() for p in _PALAVRAS_DE_SEGREDO) or bool(
        re.search(r"(?:^|_)pass(?:$|_)", name, re.IGNORECASE))


def scrub(text: str, *, fish: bool = False, shell: bool = True) -> tuple[str, list[str]]:
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
            token = m.group("v")
            single = _FISH_SINGLE if fish or not shell or fixed == "@fish" else _SINGLE
            quote = token[0] if re.fullmatch(single + "|" + _DOUBLE, token) else None
            value = token[1:-1] if quote else token
            if _is_reference(value, quote, fish or fixed == "@fish", shell):
                return m.group(0)
            if fixed is None:
                base = _FLAG_NAMES.get(m.group("flag").lower(), "segredo")
            elif fixed in {"@env", "@fish"}:
                if not _secret_name(m.group("name")):
                    return m.group(0)
                base = m.group("name")
            else:
                base = fixed
            start, end = m.span("v")
            whole = m.group(0)
            offset = m.start()
            replacement = mark(base)
            if quote:
                replacement = quote + replacement + quote
            elif not shell:
                replacement = "'" + replacement + "'"
            return whole[:start - offset] + replacement + whole[end - offset:]
        return run

    for rule, fixed in [*_RULES, (_ENV_RE, "@env")]:
        pattern = rule.pattern
        if fish or not shell:
            pattern = pattern.replace(_SINGLE, _FISH_SINGLE)
        if not shell:
            pattern = pattern.replace(_BARE, r"[^\s\"'\\;|&()`,\]}]+")
            if fixed == "@env":
                pattern = pattern.replace(r"(?<![\w$])", r"(?<![\w])\$?")
        rule = re.compile(pattern, rule.flags)
        text = rule.sub(replacer(fixed), text)
    if shell:
        text = _FISH_SET_RE.sub(replacer("@fish"), text)
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


def export_payload(ids: list[str] | None = None, include_scripts: bool = True) -> dict:
    """Exporta a seleção; a lista do seletor não abre os scripts locais."""
    current = _current()
    if ids is not None:
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
            raise ValueError("seleção de atalhos inválida")
        if set(ids) - {item.get("id") for item in current}:
            raise ValueError("seleção contém atalho desconhecido")
        current = [item for item in current if item.get("id") in ids]
    if any(item.get("id", "").startswith("script:") for item in current):
        raise ValueError("prefixo script: reservado aos arquivos do pacote")
    roots = Roots.this_machine()
    out, removed = [], 0
    for item in current:
        item = dict(item)
        field = _field(item)
        if field and isinstance(item.get(field), str):
            item[field], names = scrub(item[field], fish=field == "command" and shortcut_scripts.is_fish(item[field]))
            item[field] = canonicalize(item[field], roots)
            removed += len(names)
        if isinstance(item.get("pasta"), str):
            item["pasta"] = canonicalize(item["pasta"], roots)
        out.append(item)
    scripts, warnings = shortcut_scripts.collect([
        item["command"] for item in current if item.get("type") == "shell"
    ], lambda text, fish, shell: scrub(text, fish=fish, shell=shell)[0]) if include_scripts and current else ([], [])
    for script in scripts:
        script["content"], names = scrub(
            script["content"], fish=shortcut_scripts.is_fish(script["content"], script["path"]),
            shell=shortcut_scripts.is_shell_script(script["content"], script["path"]))
        script["content"] = canonicalize(script["content"], roots)
        removed += len(names)
    return {"version": VERSION, "shortcuts": out, "scripts": scripts,
            "warnings": [canonicalize(scrub(w)[0], roots) for w in warnings], "removed": removed}


MAX_IMPORT_CHARS = 1_000_000
MAX_PAYLOAD_BYTES = 4 * 1024 * 1024


def _warnings(data: dict) -> list[str]:
    warnings = data.get("warnings", [])
    if (not isinstance(warnings, list) or len(warnings) > shortcut_scripts.MAX_WARNINGS
            or any(not isinstance(w, str) or len(w.encode("utf-8")) > 1024 for w in warnings)):
        raise ValueError("avisos do pacote inválidos ou grandes demais")
    if sum(len(w.encode("utf-8")) for w in warnings) > shortcut_scripts.MAX_WARNING_BYTES:
        raise ValueError("avisos do pacote grandes demais")
    return warnings


def _parse(data) -> list[dict]:
    if isinstance(data, dict) and (type(data.get("version", 1)) is not int
                                   or data.get("version", 1) not in (1, 2)):
        raise ValueError("versão do pacote de atalhos não suportada")
    items = data.get("shortcuts") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ValueError("arquivo sem lista de atalhos")
    raw = json.dumps(items)
    # Vai inteiro pra config e pra resposta da prévia; um arquivo errado de MBs travaria as duas.
    if len(raw) > MAX_IMPORT_CHARS:
        raise ValueError("arquivo grande demais para uma lista de atalhos")
    rc._validate_shortcuts(raw)
    ids = [item["id"] for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError("id de atalho duplicado")
    if any(i.startswith("script:") for i in ids):
        raise ValueError("prefixo script: reservado aos arquivos do pacote")
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
    """Valida o pacote inteiro antes da escrita; a prévia nunca devolve segredos preenchidos."""
    if len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValueError("pacote de atalhos grande demais")
    incoming = _parse(data)
    bundled = isinstance(data, dict) and data.get("version") == 2
    if isinstance(data, dict) and not bundled and data.get("scripts"):
        raise ValueError("scripts exigem pacote versão 2")
    warnings = _warnings(data) if bundled else []
    scripts = shortcut_scripts.validate(data.get("scripts", [])) if bundled else []
    roots = Roots.this_machine() if bundled else None
    incoming = [dict(item) for item in incoming]
    for item in incoming:
        field = _field(item)
        if field:
            item[field], _ = scrub(item[field], fish=field == "command" and shortcut_scripts.is_fish(item[field]))
            if roots:
                item[field] = resolve(item[field], roots)
        if roots and isinstance(item.get("pasta"), str):
            item["pasta"] = resolve(item["pasta"], roots)
    script_items = []
    for script in scripts:
        content, _ = scrub(resolve(script["content"], roots),
                           fish=shortcut_scripts.is_fish(script["content"], script["path"]),
                           shell=shortcut_scripts.is_shell_script(script["content"], script["path"]))
        script_items.append({"id": "script:" + script["path"], "label": script["path"],
                             "type": "shell", "command": content})
    display_scripts = script_items
    if apply:
        incoming = _fill(incoming, secrets or {})
        script_items = _fill(script_items, secrets or {})
        if _placeholders(script_items):
            raise ValueError("preencha todos os segredos dos scripts antes de importar")
    merged, added, replaced = _merge(_current(), incoming)
    rc._validate_shortcuts(json.dumps(merged, ensure_ascii=False))
    result = {"added": added, "replaced": replaced,
              "placeholders": _placeholders(incoming) + _placeholders(script_items)}
    if bundled:
        files = []
        for script, filled, display in zip(scripts, script_items, display_scripts):
            content = filled["command"]
            script["content"] = content
            target = script["target"]
            exists = target.exists()
            same = (exists and shortcut_scripts.read_file(target) == content.encode("utf-8")
                    and target.stat().st_mode & 0o777 == (0o700 if script["executable"] else 0o600))
            files.append({"path": str(target), "status": "same" if same else "replace" if exists else "create",
                          "content": display["command"]})
        shortcut_scripts.validate(scripts)
        result["files"] = files
        result["warnings"] = list(dict.fromkeys(scrub(resolve(w, roots))[0] for w in warnings))
        if scripts:
            result["warnings"].append("Confira os scripts: importar instala os arquivos; executar um atalho pode executar esse código.")
    if apply:
        serialized = json.dumps(merged, ensure_ascii=False)
        previous = None

        def save():
            nonlocal previous
            previous = rc._carregar()
            rc.aplicar({"shortcuts": serialized})

        if scripts:
            try:
                shortcut_scripts.apply_files(scripts, save)
            except ValueError as error:
                if previous is not None:
                    try:
                        with rc._LOCK:
                            current = rc._carregar()
                            # Só desfaz nossa gravação; outro campo ou gravação posterior permanece.
                            if (current.get("shortcuts") == serialized
                                    and current.get("shortcuts") != previous.get("shortcuts")):
                                changes = {"shortcuts": previous["shortcuts"]} if "shortcuts" in previous else {}
                                rc._aplicar_travado(changes, set() if changes else {"shortcuts"})
                    except Exception:
                        raise ValueError(f"{error}; restauração dos atalhos na configuração falhou") from error
                raise
        else:
            save()
    return result
