"""Pacote limitado de scripts locais; nunca executa o conteúdo para descobrir dependências."""
import os
import re
import shlex
import shutil
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Callable

from app import atomico, cli_probe

MAX_FILES = 32
MAX_FILE_BYTES = 128 * 1024
MAX_TOTAL_BYTES = 1024 * 1024
MAX_WARNINGS = 128
MAX_WARNING_BYTES = 16 * 1024
_IS_LINUX = sys.platform.startswith("linux")
_ROOTS = (".local/bin/", "bin/", ".config/fish/functions/")
_SCRIPT_SUFFIXES = {"", ".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".rb", ".pl"}
_INTERPRETERS = {"sh", "bash", "zsh", "fish", "python", "python3", "node", "ruby", "perl"}
_CONTROL = {"if", "then", "else", "elif", "while", "do", "begin", "and", "or", "not", "!"}


def is_fish(content: str, path: str | None = None) -> bool:
    first_line = content.partition("\n")[0]
    if first_line.startswith("#!"):
        return bool(re.search(r"(?:^|[/\s])fish(?:\s|$)", first_line[2:].strip()))
    if path is not None:
        return path.endswith(".fish")
    return Path(os.environ.get("SHELL") or "/bin/sh").name == "fish"


def is_shell_script(content: str, path: str | None = None) -> bool:
    first_line = content.partition("\n")[0]
    if first_line.startswith("#!"):
        return not bool(re.search(r"(?:^|[/\s])(?:python[\d.]*|node|ruby|perl)(?:\s|$)", first_line[2:].strip()))
    return path is None or PurePosixPath(path).suffix not in {".py", ".js", ".mjs", ".rb", ".pl"}


def credential_path(value: str) -> bool:
    parts = value.lower().replace("\\", "/").split("/")
    return any(p in {".ssh", ".aws", ".gnupg", "credentials", "secrets", "id_rsa", "id_ed25519"}
               or p == ".env" or p.startswith(".env.") or p.endswith((".pw", ".pem", ".key"))
               for p in parts)


def destination(relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative \
            or any(ord(c) < 32 or ord(c) == 127 for c in relative):
        raise ValueError("caminho de script inválido")
    parts = relative.split("/")
    if any(p in {"", ".", ".."} for p in parts) or not relative.startswith(_ROOTS) \
            or credential_path(relative) or PurePosixPath(relative).suffix.lower() not in _SCRIPT_SUFFIXES:
        raise ValueError("script fora das pastas e tipos permitidos")
    if relative.startswith(".config/fish/functions/") and not relative.endswith(".fish"):
        raise ValueError("função fish precisa da extensão .fish")
    home = Path.home()
    target = home / relative
    for path in [target, *target.parents]:
        if path.is_symlink():
            raise ValueError("script ou pasta de destino é um link simbólico")
        if path == home:
            break
    if target.exists() and not target.is_file():
        raise ValueError("destino do script não é um arquivo regular")
    return target


def read_file(path: Path) -> bytes:
    # O_NOFOLLOW fecha a troca do arquivo por link entre a validação e a leitura.
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("script não é um arquivo regular")
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES or b"\0" in data:
        raise ValueError("script binário ou maior que 128 KiB")
    return data


def validate(scripts) -> list[dict]:
    if not isinstance(scripts, list) or len(scripts) > MAX_FILES:
        raise ValueError("pacote deve conter até 32 scripts")
    if scripts and not _IS_LINUX:
        raise ValueError("pacotes com scripts só podem ser importados em Linux")
    out, seen, total = [], set(), 0
    for script in scripts:
        if not isinstance(script, dict):
            raise ValueError("script inválido")
        relative, content = script.get("path"), script.get("content")
        target = destination(relative)
        if relative in seen:
            raise ValueError("caminho de script duplicado")
        seen.add(relative)
        if not isinstance(content, str) or "\0" in content or type(script.get("executable")) is not bool:
            raise ValueError("conteúdo ou permissão de script inválido")
        size = len(content.encode("utf-8"))
        total += size
        if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError("pacote de scripts ultrapassa o limite de tamanho")
        out.append({"path": relative, "content": content, "executable": script["executable"],
                    "target": target})
    return out


def collect(commands: list[str], sanitize: Callable[[str, bool, bool], str]) -> tuple[list[dict], list[str]]:
    if not commands:
        return [], []
    if not _IS_LINUX:
        return [], ["Scripts não incluídos: o empacotamento de scripts locais só está disponível em Linux."]
    home = Path.home()
    path_entries = cli_probe._obter_path().split(os.pathsep)
    for fallback in (str(home / ".local/bin"), str(home / "bin")):
        if fallback not in path_entries:
            path_entries.append(fallback)
    search_path = os.pathsep.join(path_entries)
    scripts, warnings, visited = [], [], set()
    total = 0

    def warn(message: str, token: str = ""):
        # Só caminhos literais entram no aviso; argv e atribuições podem conter uma senha.
        if (len(token) <= 400 and re.fullmatch(r"(?:/|~/|\$HOME/|\$\{HOME\}/)?[\w./-]+", token)
                and ".." not in token.split("/")):
            token = token.replace("${HOME}", str(home)).replace("$HOME", str(home))
            if token.startswith("~/"):
                token = str(home / token[2:])
            detailed = message + f" Caminho: {token}"
            if len(detailed.encode("utf-8")) <= 1024:
                message = detailed
        limit = "Limite de avisos atingido; confira as demais dependências manualmente."
        if message in warnings or limit in warnings:
            return
        if (len(warnings) >= MAX_WARNINGS - 1
                or sum(len(w.encode("utf-8")) for w in warnings) + len(message.encode("utf-8"))
                > MAX_WARNING_BYTES - len(limit.encode("utf-8"))):
            warnings.append(limit)
        else:
            warnings.append(message)

    def include(token: str):
        nonlocal total
        if credential_path(token):
            warn("Arquivo de credencial é dependência externa; não foi lido nem incluído.", token)
            return
        token = token.replace("${HOME}", str(home)).replace("$HOME", str(home))
        if token.startswith("~/"):
            token = str(home / token[2:])
        if any(c in token for c in "$`(){}*?[]"):
            warn("Dependências dinâmicas precisam de conferência manual; nenhum comando foi executado.")
            return
        if "/" in token:
            path = Path(token)
            if not path.is_absolute():
                # Caminho relativo depende do cwd de execução, não da pasta do script.
                warn("Caminho relativo de dependência depende da pasta de execução e não foi incluído.", token)
                return
        else:
            fish = home / ".config/fish/functions" / (token + ".fish")
            found = shutil.which(token, path=search_path)
            path = fish if fish.exists() or fish.is_symlink() else Path(found) if found else None
            if path is None:
                return
        try:
            relative = path.relative_to(home).as_posix()
        except ValueError:
            if not str(path).startswith(("/usr/", "/bin/", "/sbin/")):
                warn("Dependência fora das pastas locais permitidas não foi incluída.", str(path))
            return
        if relative in visited:
            return
        visited.add(relative)
        try:
            path = destination(relative)
            if len(scripts) >= MAX_FILES:
                raise ValueError("limite de 32 scripts atingido")
            raw = read_file(path)
            content = raw.decode("utf-8")
            if total + len(raw) > MAX_TOTAL_BYTES:
                raise ValueError("limite total de 1 MiB atingido")
        except (OSError, ValueError):
            warn("Uma dependência local foi excluída: arquivo ausente, tipo, caminho ou tamanho não permitido.", str(path))
            return
        total += len(raw)
        scripts.append({"path": relative, "content": content,
                        "executable": bool(path.stat().st_mode & 0o111)})
        scan(content, relative)

    def segment(words: list[str]):
        while words and (words[0] in _CONTROL or re.match(r"^[A-Za-z_]\w*=", words[0])):
            words = words[1:]
        while words and words[0] in {"exec", "command", "env"}:
            words = words[1:]
            while words and (words[0].startswith("-") or re.match(r"^[A-Za-z_]\w*=", words[0])):
                words = words[1:]
        if not words or words[0] in {"function", "end", "fi", "done", "for", "case", "esac"}:
            return
        executable = Path(words[0]).name
        if executable in {"source", "."}:
            if len(words) > 1:
                include(words[1])
        elif executable in _INTERPRETERS:
            if len(words) > 1 and not words[1].startswith("-"):
                include(words[1])
            elif len(words) > 1 and words[1] not in {"--version", "-V"}:
                warn("Comando de interpretador com opções precisa de conferência manual das dependências.")
        else:
            include(words[0])

    def scan(content: str, path: str | None = None):
        content = sanitize(content, is_fish(content, path), is_shell_script(content, path))
        if re.search(r"(?:\$\(|`|\(\s*cat\b)", content):
            warn("Dependências dinâmicas precisam de conferência manual; nenhum comando foi executado.")
        for token in re.findall(r"[^\s\"\'();]+", content):
            if credential_path(token):
                warn("Arquivo de credencial é dependência externa; não foi lido nem incluído.", token)
        # ponytail: análise estática por linha; expansão e sintaxe composta exigem conferência manual.
        for line in content.replace("\\\n", "").splitlines():
            try:
                lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|<>()")
                lexer.whitespace_split = True
                words = []
                for word in lexer:
                    if word in {";", "&&", "||", "|", "&"}:
                        segment(words)
                        words = []
                    elif word in {"<", ">", ">>", "<<", "(", ")"}:
                        # Redirecionamento e substituição não são novas chamadas de script.
                        break
                    else:
                        words.append(word)
                segment(words)
            except ValueError:
                warn("Sintaxe de shell não reconhecida; dependências exigem conferência manual.")
    for command in commands:
        scan(command)
    return scripts, warnings


def write_file(target: Path, data: bytes, mode: int):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=target.parent, prefix=".hangar-shortcut-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            os.fchmod(stream.fileno(), mode)
        atomico.substituir(temp, target)
    finally:
        Path(temp).unlink(missing_ok=True)


def apply_files(scripts: list[dict], save):
    backups = []
    try:
        for script in scripts:
            target = destination(script["path"])
            previous = read_file(target) if target.exists() else None
            mode = stat.S_IMODE(target.stat().st_mode) if previous is not None else None
            backups.append((target, previous, mode))
            write_file(target, script["content"].encode("utf-8"), 0o700 if script["executable"] else 0o600)
        save()
    except Exception as error:
        failed = False
        for target, data, mode in reversed(backups):
            try:
                destination(target.relative_to(Path.home()).as_posix())
                if data is None:
                    target.unlink(missing_ok=True)
                else:
                    write_file(target, data, mode)
            except Exception:
                failed = True
        suffix = "; restauração dos arquivos falhou, confira os destinos" if failed else "; arquivos anteriores restaurados"
        raise ValueError("importação falhou" + suffix) from error
