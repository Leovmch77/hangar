# hangar — Design System

Escopo: web/PWA no celular. As referências ao desktop web abaixo descrevem o legado;
novas interfaces desktop são feitas em `desktop-native/`, conforme a
[decisão do projeto](docs/decisoes/frontend.md#desktop-no-rust-web-para-pwamobile).

Source of truth: `frontend/src/app.css` (tokens + shared keyframes). This file summarizes it;
when they disagree, `app.css` wins. Dark is the default (`:root`); light is `[data-theme="light"]`,
resolved by `lib/theme.ts`.

## Theme rationale
Scene: a developer glancing at a phone in a dim room to
check whether a long-running agent is working, idle, or waiting on them. Dark is the default
because the surface is glanced at in low light and must not glare; light is a first-class
opt-in, not an afterthought (full paper palette, not inverted dark).

## Color — strategy: Restrained
Warm-tinted neutrals + one índigo accent used sparingly. Never `#000`/`#fff`; every neutral is
tinted warm.

- Backgrounds (dark): base `#100e11` · surface `#1a171a` · elevated `#221d22` · hover `#2a242a`.
- Text (dark): primary `#eee8e9` · secondary `#a0989b` · muted `#8d8489` (muted kept ≥4.5:1 on base).
- Accent (índigo): `#7c87e8` (dark) / `#5b6ad0` (light). `--accent-dim` for tint fills.
- User bubble: neutral gray `#2b2a2e` (not accent), Claude.ai-style.
- Semantic: success `#34c759` · error `#ff453a` · warning `#ff9f0a`.
- State pills: working (índigo), idle (green), awaiting_input (amber), dead (red) — bg + fg pairs
  in `--pill-*`. These carry session state; keep them the vocabulary for any new state UI.

## Typography
- UI: system stack (`--font-ui`, `-apple-system`…). Mono: `--font-mono` (`SF Mono`…) for cwd,
  code, terminal, numeric badges.
- Scale: `--text-xs` .75 · `--text-sm` .875 · `--text-base` 1 · `--text-lg` 1.125 · `--text-xl` 1.25rem.
- Reading measure: assistant prose historically capped at 80ch; per product decision the desktop
  chat now uses the full message column (`min(1600px, 96vw)`) — text is allowed to run wide there.

## Spacing & radius
- 8pt grid: `--space-1..10` (4→40px). Vary padding for rhythm; don't pad everything equally.
- Radius: sm 6 · md 12 · lg 18 · xl 24 · full. Bubbles use asymmetric radii.

## Elevation / glass
Glass only on chrome (navbar, composer, sidebar). Dark uses a near-opaque solid bg + rim
highlight, **no** `backdrop-filter` on WebKit (iOS black-rectangle repaint bug — see CLAUDE.md).
Real blur is Chromium-only (`html[data-liquid]`). Do not add glass to content surfaces.

## Motion
Shared tokens/keyframes in `app.css`: `--ease-out`, `--spring`, `msg-in`, `bubble-in`, etc.
Default is ease-out; the `--spring` light-overshoot token is a deliberate exception — the
"Respiração" motion family (message entering, sheet rising, queued→accepted). Keep it scoped
to that family; don't spread bounce to new UI. A global `prefers-reduced-motion` rule neutralizes loops, so new
keyframes don't each need a guard. Never animate layout props; the sidebar width transition is a
deliberate, contained exception.

## Desktop web legado (referência do que existe)
- `DesktopShell` mounts the persistent `Sidebar` beside the `Chat` at `min-width: 820px`.
- Collapsed sidebar = an icon/initials rail; hover expands it.
- Esta estrutura permanece durante a transição; trabalho novo na web atende PWA/mobile,
  sem exigir adaptação desktop.

## Bans (inherited from impeccable, enforced here)
No gradient text, no colored side-stripe borders, no decorative glass, no em dashes in UI copy,
no hero-metric template, no modal-as-first-thought (prefer inline / side panel).
