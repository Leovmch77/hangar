"""Conversa sintética longa para conferir vidro, menus e diálogos na porta escolhida pelo sistema."""

import argparse
import contextlib
import json
import os
import pathlib
import struct
import zlib


HERE = pathlib.Path(__file__).resolve().parent
SOURCE = (HERE / "task14_sidebar_fixture.py").read_text(encoding="utf-8")
T14 = {"__name__": "task61_base", "__file__": str(HERE / "task14_sidebar_fixture.py")}
exec(compile(SOURCE[:SOURCE.index("\nserver = BASE[")], "task14_sidebar_fixture.py", "exec"), T14)
BASE = T14["BASE"]

session = BASE["SESSIONS"]["sintetica-parser"]
session["events"] = [
    BASE["msg"]("assistant_msg", f"glass-{n}",
                f"Trecho {n:02}: o texto desta conversa continua visível atrás dos menus e diálogos. "
                "A linha se repete para que letras nítidas e desfocadas possam ser comparadas na mesma captura. "
                "O fundo da janela e a conversa também permanecem separados por uma margem clara.")
    for n in range(48)
]
BASE["bump"]()


def wallpaper(path):
    width, height = 96, 96
    rows = b"".join(b"\0" + bytes(channel for x in range(width)
                                for channel in (40 + x, 55 + y, 100 + (x + y) // 4)) for y in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    server = BASE["ThreadingHTTPServer"](("127.0.0.1", 0), T14["Handler"])
    stage = args.output.resolve() / f"fixture-{server.server_port}"
    config = stage / "config" / "hangar-native"
    config.mkdir(parents=True, mode=0o700)
    wallpaper_file = stage / "desktop.png"
    wallpaper(wallpaper_file)
    BASE["WALLPAPER"].update(status=200, path=str(wallpaper_file))
    connection = config / "connection.json"
    with open(connection, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump({"address": f"http://127.0.0.1:{server.server_port}", "token": BASE["TOKEN"]}, output)
    (config / "appearance.json").write_text(json.dumps({"theme": "dark", "language": "pt", "navigation": "sidebar"}))
    (stage / "fixture.pid").write_text(str(os.getpid()))
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "pid": os.getpid(), "stage": str(stage)}), flush=True)
    with (stage / f"fixture-{server.server_port}.log").open("a", buffering=1) as log:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            try:
                server.serve_forever()
            finally:
                server.server_close()


if __name__ == "__main__":
    main()
