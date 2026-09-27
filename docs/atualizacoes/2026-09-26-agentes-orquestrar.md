---
id: 2026-09-26-agentes-orquestrar
titulo: Os agentes da orquestração passam a ser instalados no Claude e no Codex
comando_posix: ./scripts/install-hangar-send.sh
comando_windows: powershell -ExecutionPolicy Bypass -File install.ps1 -Update
prova: ~/.claude/agents/preparar-plano.md ~/.claude/agents/revisor-orq.md
destrutivo: false
---

A orquestração ganha o agente `preparar-plano`, que prepara o plano num contexto limpo, e ele e o
`revisor-orq` passam a existir tanto nas sessões Claude quanto nas Codex desta máquina.
