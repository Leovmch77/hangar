---
name: provar-tela
description: Rules to prove a change on a screen — the bar (reference screen), invalidators (viewport, language, edge, framing), blind comparison, capture ceiling, tool choice and the shared-screen lock. Use when a Task's roteiro cites provar-tela, or when the user asks to prove a UI change against a reference. Not for code review.
---

# Provar na tela

Two sides: who captures (`references/executor.md`) and who judges (`references/revisor.md`).
The bar is chosen before the work (`references/barra.md`). A shared screen is taken with
`orq lock take screen --owner <you>` when running under orquestrar, or by agreement otherwise.
Read only the side that is yours.
