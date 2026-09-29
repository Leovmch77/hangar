"""Índice SQLite (FTS5) dos transcripts do Claude, para a busca não varrer GBs a cada tecla.

Transcript é append-only: cada arquivo guarda o byte até onde já foi lido e só as linhas completas
depois dele entram. Arquivo que encolheu ou trocou de inode é relido do zero. O backend é o único
escritor (uma thread em segundo plano); leitores abrem conexão própria, o WAL os deixa ler durante
a escrita. Enquanto a primeira construção não termina, `ready` fica falso e a busca usa o `rg`.

Também guarda o cabeçalho (cwd e 1ª mensagem) de cada arquivo e uma cópia da varredura de
Pi/Kimi/Codex, que é o que o Arquivo relia a cada listagem."""
import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

from app import log_paths
from app.transcript import parse_obj

_log = logging.getLogger("hangar.transcript_index")

SCHEMA_VERSION = 1
# Mesmo teto do `rg -M` da busca antiga: linha maior é saída de ferramenta ou contexto injetado.
_MAX_LINE_BYTES = 40000
_HEAD_LINES = 60        # o que archive._head_info lê
_INTERNAL_LINES = 30    # o que search._interno lê
_PER_FILE = 3
_INTERVAL = 45.0
# Boot já paga sondas de CLI e a coleta de custos; a construção entra depois, e a busca usa o rg até lá.
_START_DELAY = 90.0
# Busca com índice mais velho que isto roda uma passada antes: a conversa de agora tem de aparecer.
_STALE_ON_SEARCH = 5.0

_SCHEMA = """
CREATE TABLE files(
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ns INTEGER NOT NULL DEFAULT 0,
    ino INTEGER NOT NULL DEFAULT 0,
    offset INTEGER NOT NULL DEFAULT 0,
    lines INTEGER NOT NULL DEFAULT 0,
    cwd TEXT,
    preview TEXT NOT NULL DEFAULT '',
    head_done INTEGER NOT NULL DEFAULT 0,
    internal INTEGER
);
CREATE TABLE msg(
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    role TEXT NOT NULL,
    ts REAL,
    text TEXT NOT NULL
);
CREATE INDEX msg_file ON msg(file_id);
CREATE VIRTUAL TABLE msg_fts USING fts5(
    text, content='msg', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER msg_ai AFTER INSERT ON msg BEGIN
    INSERT INTO msg_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER msg_ad AFTER DELETE ON msg BEGIN
    INSERT INTO msg_fts(msg_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
"""


def default_path() -> Optional[Path]:
    # Sob pytest nunca o índice real: a suíte não pode varrer nem gravar os transcripts da máquina.
    if "PYTEST_CURRENT_TEST" in os.environ:
        return None
    return log_paths.base().parent / "transcript-index.sqlite3"


def fts_query(terms: list[str]) -> Optional[str]:
    """Cada termo vira uma frase com prefixo (`"pm 17785"*`): o texto do usuário nunca é sintaxe do
    FTS5. Termo sem letra nem dígito não gera token e sai; sem nenhum, None (quem chama usa o rg)."""
    parts = ['"' + t.replace('"', '""') + '"*' for t in terms if re.search(r"[^\W_]", t)]
    return " AND ".join(parts) or None


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=10, check_same_thread=False)
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _open(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    for tentativa in (1, 2):
        try:
            conn = _connect(path)
            if conn.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                for (tipo, nome) in conn.execute(
                        "SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger') "
                        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'msg_fts_%'").fetchall():
                    conn.execute(f'DROP {tipo.upper()} IF EXISTS "{nome}"')
                conn.executescript(_SCHEMA)
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                conn.commit()
            return conn
        except sqlite3.DatabaseError:
            # Índice é cache: arquivo corrompido se apaga e se reconstrói.
            if tentativa == 2:
                raise
            _log.warning("índice de transcripts ilegível, reconstruindo %s", path, exc_info=True)
            for suf in ("", "-wal", "-shm"):
                try:
                    os.unlink(f"{path}{suf}")
                except OSError:
                    pass
    raise AssertionError("inalcançável")


class Index:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._conn = _open(path)
        row = self._conn.execute("SELECT v FROM meta WHERE k='built'").fetchone()
        self.ready = row is not None
        self.last_pass = 0.0
        # Cópia da última varredura de Pi/Kimi/Codex (archive_providers.conversas()).
        self.providers: Optional[list] = None

    # ── escrita ──────────────────────────────────────────────────────────────────
    def update(self, providers: bool = True) -> None:
        with self._lock:
            self._update(providers)

    def update_if_stale(self) -> None:
        # Não espera a passada em segundo plano: se ela está rodando, o índice já está quase em dia.
        if time.monotonic() - self.last_pass < _STALE_ON_SEARCH or not self._lock.acquire(blocking=False):
            return
        try:
            self._update(providers=False)
        except Exception:
            _log.warning("passada do índice na busca falhou", exc_info=True)
        finally:
            self._lock.release()

    def _update(self, providers: bool) -> None:
        if providers:
            from app import archive_providers
            self.providers = archive_providers.conversas()
        from app.archive import _contas
        atuais: dict[str, tuple[str, str, os.stat_result]] = {}
        for _cfg, _rot, base in _contas():
            try:
                projetos = [d for d in base.iterdir() if d.is_dir()]
            except OSError:
                continue
            for proj in projetos:
                for f in proj.glob("*.jsonl"):
                    try:
                        atuais[str(f)] = (proj.name, f.stem, f.stat())
                    except OSError:
                        continue
        conn = self._conn
        conhecidos = {p: (fid, size, mtime, ino, off) for fid, p, size, mtime, ino, off in conn.execute(
            "SELECT id, path, size, mtime_ns, ino, offset FROM files")}
        for p in conhecidos.keys() - atuais.keys():
            fid = conhecidos[p][0]
            conn.execute("DELETE FROM msg WHERE file_id=?", (fid,))
            conn.execute("DELETE FROM files WHERE id=?", (fid,))
        conn.commit()
        prefixos = _internal_prefixes()
        # Mais recente primeiro: numa construção interrompida, o que falta é o mais velho.
        for p, (proj, sid, st) in sorted(atuais.items(), key=lambda kv: kv[1][2].st_mtime_ns, reverse=True):
            antigo = conhecidos.get(p)
            if antigo and (antigo[1], antigo[2], antigo[3]) == (st.st_size, st.st_mtime_ns, st.st_ino):
                continue
            try:
                self._ingest(p, proj, sid, st, antigo, prefixos)
            except OSError:
                conn.rollback()
                _log.debug("índice: não consegui ler %s", p, exc_info=True)
        if not self.ready:
            conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES ('built', ?)", (str(time.time()),))
            conn.commit()
            self.ready = True
        self.last_pass = time.monotonic()

    def _ingest(self, path: str, project: str, sid: str, st: os.stat_result,
                antigo: Optional[tuple], prefixos: tuple[str, ...]) -> None:
        conn = self._conn
        if antigo is None:
            fid = conn.execute("INSERT INTO files(path, project, session_id, ino) VALUES (?,?,?,?)",
                               (path, project, sid, st.st_ino)).lastrowid
        else:
            fid = antigo[0]
            if antigo[3] != st.st_ino or st.st_size < antigo[4]:
                conn.execute("DELETE FROM msg WHERE file_id=?", (fid,))
                conn.execute("UPDATE files SET offset=0, lines=0, cwd=NULL, preview='', head_done=0, "
                             "internal=NULL, ino=? WHERE id=?", (st.st_ino, fid))
        offset, lines, cwd, preview, head_done, internal = conn.execute(
            "SELECT offset, lines, cwd, preview, head_done, internal FROM files WHERE id=?", (fid,)).fetchone()
        from app.archive import _cortar, _texto_simples
        linhas: list[tuple] = []
        with open(path, "rb") as fh:
            fh.seek(offset)
            for raw in fh:
                if not raw.endswith(b"\n"):
                    break   # linha ainda sendo escrita: entra na próxima passada
                offset += len(raw)
                lines += 1
                na_cabeca = not head_done or (internal is None and lines <= _INTERNAL_LINES)
                if len(raw) > _MAX_LINE_BYTES and not na_cabeca:
                    continue
                try:
                    obj = json.loads(raw)
                    evs = parse_obj(obj) if isinstance(obj, dict) else []
                except Exception:
                    # Linha que o parser não entende não pode travar o arquivo inteiro para sempre.
                    evs, obj = [], None
                msgs = [ev for ev in evs if ev.kind in ("user_msg", "assistant_msg") and ev.text]
                if not head_done:
                    c = obj.get("cwd") if isinstance(obj, dict) else None
                    if cwd is None and isinstance(c, str) and c:
                        cwd = c
                    if not preview:
                        u = next((ev for ev in msgs if ev.kind == "user_msg"), None)
                        if u is not None:
                            preview = _cortar(_texto_simples(u.text or ""))
                    head_done = int(bool(cwd and preview) or lines >= _HEAD_LINES)
                if internal is None:
                    u = next((ev for ev in msgs if ev.kind == "user_msg"), None)
                    if u is not None:
                        internal = int((u.text or "").lstrip().startswith(prefixos))
                    elif lines >= _INTERNAL_LINES:
                        internal = 0
                if len(raw) <= _MAX_LINE_BYTES:
                    linhas += [(fid, ev.id, "user" if ev.kind == "user_msg" else "assistant", ev.ts, ev.text)
                               for ev in msgs]
                if len(linhas) >= 5000:
                    conn.executemany("INSERT INTO msg(file_id, event_id, role, ts, text) VALUES (?,?,?,?,?)",
                                     linhas)
                    linhas = []
        conn.executemany("INSERT INTO msg(file_id, event_id, role, ts, text) VALUES (?,?,?,?,?)", linhas)
        # size/mtime da stat de antes da leitura: se o arquivo cresceu no meio, a próxima passada relê.
        conn.execute("UPDATE files SET size=?, mtime_ns=?, offset=?, lines=?, cwd=?, preview=?, "
                     "head_done=?, internal=? WHERE id=?",
                     (st.st_size, st.st_mtime_ns, offset, lines, cwd, preview, head_done, internal, fid))
        conn.commit()
        time.sleep(0)   # cede o GIL entre arquivos durante a construção

    # ── leitura ──────────────────────────────────────────────────────────────────
    def _reader(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=10)
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def search(self, terms: list[str], limit: int) -> Optional[list[tuple]]:
        """(path, project, session_id, cwd, text, role, event_id, ts), arquivo mais recente primeiro,
        até 3 por arquivo. None = consulta não expressável no FTS (quem chama usa o rg)."""
        q = fts_query(terms)
        if q is None:
            return None
        self.update_if_stale()
        conn = self._reader()
        try:
            return conn.execute("""
                WITH h AS (
                    SELECT m.id, f.mtime_ns,
                           ROW_NUMBER() OVER (PARTITION BY m.file_id ORDER BY m.id) AS rn
                    FROM msg_fts JOIN msg m ON m.id = msg_fts.rowid JOIN files f ON f.id = m.file_id
                    WHERE msg_fts MATCH ? AND COALESCE(f.internal, 0) = 0)
                SELECT f.path, f.project, f.session_id, f.cwd, m.text, m.role, m.event_id, m.ts
                FROM h JOIN msg m ON m.id = h.id JOIN files f ON f.id = m.file_id
                WHERE h.rn <= ? ORDER BY h.mtime_ns DESC, m.id LIMIT ?""",
                (q, _PER_FILE, limit)).fetchall()
        finally:
            conn.close()

    def heads(self) -> dict[str, tuple[str, Optional[str]]]:
        """path -> (preview, cwd) dos arquivos cujo cabeçalho já está completo no índice."""
        conn = self._reader()
        try:
            return {p: (pv, cwd) for p, pv, cwd in
                    conn.execute("SELECT path, preview, cwd FROM files WHERE head_done=1")}
        finally:
            conn.close()


_current: Optional[Index] = None


def current() -> Optional[Index]:
    return _current


def _internal_prefixes() -> tuple[str, ...]:
    from app.search import _prefixos_internos
    return _prefixos_internos()


def _loop(idx: Index) -> None:
    time.sleep(_START_DELAY)
    while True:
        inicio = time.monotonic()
        try:
            idx.update()
            gasto = time.monotonic() - inicio
            # Passada normal leva milissegundos a cada 45 s: só a lenta merece linha no journal.
            (_log.info if gasto > 1.0 else _log.debug)("índice de transcripts atualizado em %.1fs", gasto)
        except Exception:
            _log.warning("passada do índice de transcripts falhou", exc_info=True)
        time.sleep(_INTERVAL)


def start_background() -> None:
    """Thread daemon, não task: a primeira construção leva quase um minuto e não pode segurar o
    encerramento do backend nem o loop de eventos."""
    global _current
    path = default_path()
    if path is None or _current is not None:
        return
    try:
        _current = Index(path)
    except Exception:
        _log.warning("índice de transcripts indisponível; a busca segue no rg", exc_info=True)
        return
    threading.Thread(target=_loop, args=(_current,), name="transcript-index", daemon=True).start()
