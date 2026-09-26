#!/usr/bin/env python3
"""Arquivos sintéticos da T75; --dir isolado, porta aleatória."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys
import time
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
import task45_files_fixture as base


FILES = {
    "sample.rs": 'fn main() { println!("Rust"); }\n',
    "sample.ts": 'const language: string = "TypeScript";\n',
    "sample.tsx": 'export const View = () => <span>TSX</span>;\n',
    "sample.js": 'const language = "JavaScript";\n',
    "sample.py": 'def greet():\n    return "Python"\n',
    "sample.json": '{"language": "JSON", "enabled": true}\n',
    "sample.toml": '[demo]\nlanguage = "TOML"\n',
    "sample.yaml": 'language: YAML\nenabled: true\n',
    "sample.md": '# Markdown\n\n**realce** no texto.\n',
    "sample.sh": 'language="Bash"\necho "$language"\n',
    "sample.css": '.sample { color: rebeccapurple; }\n',
    "sample.html": '<main class="sample">HTML</main>\n',
    "sample.svelte": '<script lang="ts">let language = "Svelte";</script>\n<h1>{language}</h1>\n',
    "sample.sql": "SELECT language FROM demo WHERE enabled = true;\n",
    "sample.c": 'int main(void) { return 0; }\n',
    "sample.cpp": '#include <string>\nint main() { auto language = std::string("C++"); }\n',
    "sample.java": 'class Demo { String language = "Java"; }\n',
    "sample.cs": 'class Demo { string Language = "C#"; }\n',
    "sample.kt": 'val language: String = "Kotlin"\n',
    "sample.go": 'package main\nfunc main() { println("Go") }\n',
    "sample.rb": 'language = "Ruby"\nputs language\n',
    "sample.lua": 'local language = "Lua"\nprint(language)\n',
    "sample.swift": 'let language: String = "Swift"\n',
    "sample.php": '<?php $language = "PHP"; echo $language;\n',
    "sample.pas": 'program Demo; begin Writeln("Pascal sem gramática"); end.\n',
    "sample.unknown": 'Texto puro sem gramática.\n',
}

FENCE = chr(96) * 3
CODE_RUST = f"{FENCE}rust\nfn main() {{}}\n{FENCE}"
CODE_JSON = f"{FENCE}json\n{{\"enabled\": true}}\n{FENCE}"
REPORT = "Relatório\n\n" + CODE_RUST

base.FILES = FILES
base.SESSIONS[:] = [
    {"name": name, "cwd": "/fixture/project", "jsonl": f"/fixture/{name}.jsonl",
     "provider": "claude", "headless": True, "state": state, "tracked": True,
     "branch": "fixture", "git_dirty": 0}
    for name, state in (("t75-realce", "idle"), ("t75-plano", "awaiting_input"))
]


class Handler(base.Handler):
    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/api/sessions/t75-plano/events":
            if not self.allowed():
                return
            self.record(200)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            state = {"state": "awaiting_input", "session": "t75-plano", "question": "Aprovar plano?",
                     "options": ["Sim", "Não"],
                     "claude_plan_pending": {"plan": CODE_RUST, "path": "/fixture/plan.md"}}
            try:
                while True:
                    self.wfile.write(f"event: state\ndata: {json.dumps(state)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(2)
            except (BrokenPipeError, ConnectionResetError):
                return
        if route == "/api/archive/fixture/archive-t75/history":
            if not self.allowed():
                return
            return self.respond([{"kind": "assistant_msg", "id": "archive-t75-history", "text": CODE_RUST}])
        if route.endswith("/history"):
            if not self.allowed():
                return
            links = "\n".join(f"[{name}](hangar-file:?path={name}&line=0)" if name == "sample.html"
                              else f"[{name}]({name})" for name in FILES)
            code = (CODE_RUST + "\n\n" + CODE_JSON + "\n\n"
                    f"{FENCE}foo\nsem gramática\n{FENCE}\n\n"
                    f"{FENCE}\nbloco sem linguagem\n{FENCE}")
            notice = {"agent_path": "/fixture/reviewer", "status": {"completed": REPORT}}
            return self.respond([
                {"kind": "assistant_msg", "id": "task75-files", "text": "Arquivos para conferir o realce:\n\n" + links},
                {"kind": "assistant_msg", "id": "task75-code", "text": code},
                {"kind": "user_msg", "id": "task75-report", "text": "<subagent_notification>" + json.dumps(notice) + "</subagent_notification>"},
            ])
        if route.endswith("/bastao"):
            if not self.allowed():
                return
            body = ("Dossiê da sessão\n\n" + CODE_RUST).encode()
            self.record(200)
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/api/fs/roots":
            if not self.allowed():
                return
            return self.respond([{"name": "Projeto", "path": "/fixture/project"}])
        if route == "/api/fs/scan":
            if not self.allowed():
                return
            return self.respond({"entries": [{"name": "project", "path": "/fixture/project"}], "error": None})
        if route == "/api/archive-por-cwd":
            if not self.allowed():
                return
            return self.respond([{"project": "fixture", "session_id": "archive-t75", "provider": "claude",
                                  "live": False, "ultima": "Conversa antiga"}])
        super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--theme", choices=("dark", "light"), required=True)
    args = parser.parse_args()
    root = args.dir.resolve()
    os.umask(0o077)
    config = root / "config" / "hangar-native"
    config.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token, server.delay = secrets.token_hex(24), 0
    server.log = root / f"fixture-{server.server_port}.log"
    address = f"http://127.0.0.1:{server.server_port}"
    (config / "connection.json").write_text(json.dumps({"address": address, "token": server.token}))
    (config / "appearance.json").write_text(json.dumps({"theme": args.theme, "language": "pt"}))
    (root / "fixture.json").write_text(json.dumps({"pid": os.getpid(), "port": server.server_port, "address": address}))
    print(json.dumps({"pid": os.getpid(), "address": address, "config": str(config.parent)}), flush=True)
    server.serve_forever()
