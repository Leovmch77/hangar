#!/usr/bin/env python3
"""Fixture do painel de git: uma sessão num repositório descartável, com as rotas `/git*`, `/branches` e `/checkout`
servidas pelo `git_ops.py` do próprio backend. Nunca encaminha ao backend real; o push vai para um repositório bare
também descartável. Token sintético."""
import argparse
import importlib.util
import json
import logging
import os
import subprocess
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import task70_new_chat_send_fixture as base

NAME = "git-fixture"


def load_git_ops(backend: Path):
    spec = importlib.util.spec_from_file_location("git_ops", backend / "app" / "git_ops.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Handler(base.Handler):
    def ops(self):
        return self.server.ops

    def cwd(self):
        return str(self.server.repo)

    def run(self, fn, *args):
        try:
            return self.reply(fn(*args))
        except self.server.ops.GitError as exc:
            return self.reply({"detail": exc.detail}, exc.status)

    def do_GET(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        prefix = f"/api/sessions/{NAME}/"
        if path.startswith(prefix):
            rest = unquote(path[len(prefix):])
            logging.info("GET %s", rest)
            ops, cwd = self.ops(), self.cwd()
            if rest == "branches":
                return self.run(ops.list_branches, cwd)
            if rest == "git/files":
                return self.run(lambda c: {"files": ops.changed_files(c), "sequencer": ops.sequencer_state(c)}, cwd)
            if rest == "git/log":
                n = int(query.get("n", ["50"])[0])
                q = query.get("q", [None])[0]
                return self.run(lambda c: {"commits": ops.assign_lanes(ops.git_log(c, n=n, grep=q)) if not q else ops.git_log(c, n=n, grep=q),
                                           "ahead": (ops.git_summary(c) or {}).get("ahead"),
                                           "behind": (ops.git_summary(c) or {}).get("behind")}, cwd)
            if rest == "git/last-message":
                return self.run(ops.last_commit_message, cwd)
            parts = rest.split("/")
            if len(parts) == 4 and parts[:2] == ["git", "commit"]:
                sha, what = parts[2], parts[3]
                if what == "files":
                    return self.run(lambda c: {"files": ops.commit_files(c, sha)}, cwd)
                if what == "diff":
                    return self.run(ops.commit_file_diff, cwd, sha, query.get("path", [""])[0])
                if what == "diff-full":
                    return self.run(ops.commit_diff, cwd, sha)
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        prefix = f"/api/sessions/{NAME}/"
        if not path.startswith(prefix):
            return super().do_POST()
        rest = unquote(path[len(prefix):])
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        logging.info("POST %s %s", rest, json.dumps(body, ensure_ascii=False))
        ops, cwd = self.ops(), self.cwd()
        routes = {
            "checkout": lambda: ops.switch_branch(cwd, body["branch"]),
            "git": lambda: ops.git_action(cwd, body["action"]),
            "git/diff": lambda: ops.file_diff(cwd, body["path"]),
            "git/discard": lambda: ops.discard_file(cwd, body["path"]),
            "git/commit": lambda: ops.commit(cwd, body["message"], body.get("paths", []), body.get("amend", False), body.get("new_branch")),
            "git/push": lambda: ops.push(cwd),
            "git/branch": lambda: ops.create_branch_at(cwd, body["name"], body.get("sha"), body.get("switch_after", False)),
        }
        if rest not in routes:
            return self.reply({"detail": "Method Not Allowed"}, 405)
        return self.run(routes[rest])


def git(cwd, *args):
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=cwd, check=True, capture_output=True)


def refresh(server):
    """A lista de sessões acompanha o repositório, como o backend: branch e +/− da working tree."""
    ops = server.ops
    while True:
        cwd = str(server.repo)
        stat = ops.git_diffstat(cwd) or {}
        summary = ops.git_summary(cwd) or {}
        with server.lock:
            session = server.sessions[NAME]
            session.update({"branch": ops.branch_of(cwd), "git_added": stat.get("added"), "git_removed": stat.get("removed"),
                            "git_dirty": summary.get("dirty")})
        time.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--backend", type=Path, default=Path.home() / "hangar" / "backend")
    # Fora do loopback o nativo trata o servidor como remoto e usa as rotas; em 127.0.0.1 ele roda o git no disco.
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.bind, 0), Handler)
    port = server.server_port
    server.ops = load_git_ops(args.backend)
    server.repo = output / f"repo-{port}" / "demo-app"
    remote = output / f"repo-{port}" / "origin.git"
    server.repo.mkdir(parents=True)
    os.environ.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                       "GIT_CEILING_DIRECTORIES": str(output), "LC_ALL": "C"})
    git(output, "init", "--bare", "-b", "main", str(remote))
    git(server.repo, "init", "-b", "main")
    git(server.repo, "config", "user.name", "Fixture")
    git(server.repo, "config", "user.email", "fixture@example.invalid")
    git(server.repo, "remote", "add", "origin", str(remote))
    (server.repo / "README.md").write_text("# demo-app\n\nRepositório descartável do painel de git.\n")
    (server.repo / "src").mkdir()
    (server.repo / "src" / "main.py").write_text("def main():\n    print('olá')\n\n\nif __name__ == '__main__':\n    main()\n")
    git(server.repo, "add", ".")
    git(server.repo, "commit", "-m", "Primeiro commit")
    (server.repo / "src" / "util.py").write_text("def soma(a, b):\n    return a + b\n")
    git(server.repo, "add", ".")
    git(server.repo, "commit", "-m", "Soma em util", "-m", "Corpo do commit com detalhe.")
    git(server.repo, "push", "-u", "origin", "main")
    git(server.repo, "branch", "feature/login")
    git(server.repo, "branch", "fix/typo")
    # Mudanças na árvore: uma staged, uma não staged, um arquivo novo.
    (server.repo / "src" / "main.py").write_text("def main():\n    print('olá, mundo')\n    return 0\n\n\nif __name__ == '__main__':\n    main()\n")
    (server.repo / "README.md").write_text("# demo-app\n\nRepositório descartável do painel de git.\n\nMais uma linha.\n")
    git(server.repo, "add", "README.md")
    (server.repo / "notas.txt").write_text("rascunho\n")
    base.ROOT = str(server.repo.parent)
    server.control = output / f"fixture-{port}.case"
    server.control.write_text("success\n")
    server.delay = 0
    server.lock = threading.Lock()
    server.sessions = {NAME: {**base.SESSION, "name": NAME, "cwd": str(server.repo), "jsonl": str(output / f"{NAME}.jsonl"),
                              "branch": "main"}}
    server.history = {NAME: [{"id": "u1", "kind": "user_msg", "text": "Mostra o git desta pasta.", "ts": 1790445600.0},
                             {"id": "a1", "kind": "assistant_msg", "text": "Abra pela faixa embaixo do compositor.", "ts": 1790445601.0}]}
    threading.Thread(target=refresh, args=(server,), daemon=True).start()
    logging.basicConfig(filename=output / f"fixture-{port}.log", level=logging.INFO, format="%(asctime)s %(message)s")
    address = f"http://{args.bind}:{port}"
    xdg = output / f"xdg-{port}"
    (xdg / "hangar-native").mkdir(parents=True)
    (xdg / "hangar-native" / "connection.json").write_text(json.dumps({"address": address, "token": "git-fixture"}) + "\n")
    print(f"{address} repo={server.repo} xdg={xdg}", flush=True)
    server.serve_forever()
