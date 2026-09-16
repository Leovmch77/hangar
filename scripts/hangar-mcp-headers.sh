#!/usr/bin/env bash
# headersHelper do MCP `hangar` no Claude Code: roda a cada conexão, herda o ambiente do `claude`
# e imprime os cabeçalhos em JSON. O token sai do backend/.env — nunca do ambiente da sessão.
set -euo pipefail
ENV_FILE="$(dirname "$(realpath "$0")")/../backend/.env"
TOKEN=$(grep '^CP_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
python3 - "$TOKEN" <<'PYEOF'
import json, os, sys
h = {"Authorization": f"Bearer {sys.argv[1]}"}
for cab, var in (("X-Hangar-Key", "CP_SESSION_KEY"), ("X-Hangar-Key", "HANGAR_CANO_KEY"),
                 ("X-Hangar-Pane", "TMUX_PANE"), ("X-Hangar-Session", "CP_SESSION_NAME")):
    if os.environ.get(var) and cab not in h:
        h[cab] = os.environ[var]
print(json.dumps(h))
PYEOF
