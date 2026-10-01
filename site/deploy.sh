#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 build.py
# ponytail: publicação manual; CI com token do Cloudflare só se o ritmo de mudança pedir
npx --yes wrangler pages deploy public --project-name hangar-site --branch "${1:-preview}"
