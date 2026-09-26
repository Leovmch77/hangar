#!/usr/bin/env python3
"""Fixture isolada de branches/worktrees; use apenas token sintético de demonstração."""
import argparse
import json
import logging
import os
import re
import subprocess
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import task70_new_chat_send_fixture as base

CASES = ("success", "no-git", "git-error", "legacy", "delayed-branches", "create-failed", "delayed-create", "lost-response")


class Handler(base.Handler):
    def case(self):
        return self.server.control.read_text().strip()

    def git(self, cwd, *args):
        if not Path(cwd).resolve().is_relative_to(self.server.root):
            raise ValueError("path outside fixture")
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=cwd,
                                env=self.server.git_env, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10)
        if "\ufffd" in result.stdout + result.stderr:
            raise ValueError("git output is not valid UTF-8")
        if result.returncode:
            raise ValueError(result.stderr.strip() or "git failed")
        return result.stdout.strip()

    def branches(self, cwd):
        branches = self.git(cwd, "branch", "--format=%(refname:short)").splitlines()
        remotes = [r.split("/", 1)[1] for r in self.git(cwd, "branch", "-r", "--format=%(refname:short)").splitlines() if "/" in r]
        return {"current": self.git(cwd, "branch", "--show-current"), "branches": branches,
                "remotes": [r for r in remotes if r not in branches and r != "HEAD"],
                "dirty": bool(self.git(cwd, "status", "--porcelain"))}

    def do_GET(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        if path in ("/api/fs/scan", "/api/fs/branches"):
            root = query.get("root", [""])[0]
            folder = Path(query.get("path", [root])[0]).resolve()
            if root != str(self.server.root) or folder not in (self.server.root, self.server.repo, self.server.no_git):
                return self.error("erro_criacao_sessao", "path outside fixture", 400)
            logging.info("GET %s caso=%s", path, self.case())
            if path.endswith("/scan"):
                entries = [{"name": p.name, "path": str(p), "is_git": p == self.server.repo,
                            "has_claude_md": False, "mtime": 1790438400.0}
                           for p in (self.server.repo, self.server.no_git)] if folder == self.server.root else []
                return self.reply({"entries": entries, "error": None})
            if self.case() == "legacy":
                return self.reply({"detail": "Not Found"}, 404)
            if self.case() == "delayed-branches":
                time.sleep(self.server.delay)
            try:
                if self.case() == "git-error":
                    raise ValueError("fatal: detected dubious ownership in repository")
                return self.reply(self.branches(self.server.no_git if self.case() == "no-git" else folder))
            except (ValueError, subprocess.TimeoutExpired) as exc:
                return self.error("erro_criacao_sessao", str(exc), 409)
        if path.startswith("/api/sessions/") and path.endswith("/events"):
            name = path.split("/")[3]
            with self.server.lock:
                if name not in self.server.sessions:
                    return self.reply({"detail": "Not Found"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            cursor = 0
            try:
                while True:
                    with self.server.lock:
                        tail = self.server.history.get(name, [])[cursor:]
                    for message in tail:
                        self.wfile.write(f"event: message\ndata: {json.dumps(message)}\n\n".encode())
                    cursor += len(tail)
                    state = {"session": name, "state": "idle", "headless": True, "claude_permission_mode": "acceptEdits"}
                    self.wfile.write(f"event: state\ndata: {json.dumps(state)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(.5)
            except (BrokenPipeError, ConnectionResetError):
                return
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        key = "/api/sessions" if path == "/api/sessions" else "/api/sessions/:name/input"
        with self.server.lock:
            self.server.counts[key] = self.server.counts.get(key, 0) + 1
            self.server.count_file.write_text(json.dumps(self.server.counts) + "\n")
        logging.info("POST %s caso=%s", key, self.case())
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if path.startswith("/api/sessions/") and path.endswith("/input"):
                name = path.split("/")[3]
                with self.server.lock:
                    if name not in self.server.sessions:
                        return self.error("erro_sessao_recado_nao_enfileirado", "sessão não encontrada", 404)
                    history = self.server.history.setdefault(name, [])
                    history.append({"id": f"input-{name}-{len(history)}", "kind": "user_msg",
                                    "text": body["text"], "ts": time.time()})
                return self.reply({"ok": True, "delivered": True})
            if path != "/api/sessions":
                return self.reply({"detail": "Method Not Allowed"}, 405)
            name, cwd = body["name"], Path(body["cwd"]).resolve()
            if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or cwd not in (self.server.root, self.server.repo, self.server.no_git):
                raise ValueError("invalid name or path outside fixture")
            if self.case() == "delayed-create":
                time.sleep(self.server.delay)
            if self.case() == "create-failed":
                raise ValueError("falha ao criar sessao no tmux")
            with self.server.lock:
                if name in self.server.sessions:
                    return self.error("erro_nome_em_uso", "ja existe uma sessao com esse nome", 409)
                branch, worktree = body.get("branch"), False
                if branch is not None:
                    info = self.branches(cwd)
                    if branch not in info["branches"] + info["remotes"]:
                        raise ValueError("branch inexistente")
                    if branch != info["current"]:
                        target = self.server.root / f"hangar-{name}"
                        if target.exists() or target.is_symlink():
                            raise ValueError("destino da worktree já existe")
                        args = (str(target), branch) if branch in info["branches"] else ("--track", "-b", branch, str(target), f"origin/{branch}")
                        self.git(cwd, "worktree", "add", *args)
                        cwd, worktree = target, True
                elif cwd == self.server.repo:
                    branch = self.git(cwd, "branch", "--show-current")
                session = {**base.SESSION, "name": name, "cwd": str(cwd), "branch": branch,
                           "worktree": worktree, "jsonl": str(self.server.root / f"{name}.jsonl")}
                self.server.sessions[name] = session
            return self.reply({} if self.case() == "lost-response" else session)
        except (ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
            return self.error("erro_criacao_sessao", str(exc), 409)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=CASES, default="success")
    parser.add_argument("--delay", type=float, default=8)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    prefix = output / f"fixture-{server.server_port}"
    server.root = output / f"projects-{server.server_port}"
    server.root.mkdir()
    server.repo, server.no_git = server.root / "hangar", server.root / "website"
    server.repo.mkdir()
    server.no_git.mkdir()
    server.git_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                      "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                      "GIT_CEILING_DIRECTORIES": str(server.root)}
    runner = object.__new__(Handler)
    runner.server = server
    runner.git(server.repo, "init", "-b", "main")
    runner.git(server.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
    runner.git(server.repo, "branch", "feature")
    runner.git(server.repo, "remote", "add", "origin", str(server.repo))
    runner.git(server.repo, "update-ref", "refs/remotes/origin/remote-feature", "HEAD")
    base.ROOT = str(server.root)
    server.control = prefix.with_suffix(".case")
    server.control.write_text(args.case + "\n")
    server.count_file = prefix.with_suffix(".counts.json")
    server.counts = {}
    server.count_file.write_text("{}\n")
    server.delay = max(0, args.delay)
    server.lock = threading.Lock()
    server.sessions, server.history = {}, {}
    logging.basicConfig(filename=prefix.with_suffix(".log"), level=logging.INFO, format="%(asctime)s %(message)s")
    address = f"http://127.0.0.1:{server.server_port}"
    xdg = output / f"xdg-{server.server_port}"
    xdg.mkdir()
    (xdg / "hangar-native").mkdir()
    (xdg / "hangar-native" / "connection.json").write_text(json.dumps({"address": address, "token": "task81-fixture"}) + "\n")
    print(f"{address} control={server.control} root={server.root} counts={server.count_file} xdg={xdg}", flush=True)
    server.serve_forever()
