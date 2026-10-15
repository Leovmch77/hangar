import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getPane, type Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

export interface PaneSnapshot {
  text: string;
  scrollback: number;
  err: string;
  pending: boolean;
}

type GetPaneFn = typeof getPane;

// Laço do espelho — porte de TerminalMirror.svelte:75-100. Vive FORA do React (uma implementação só,
// a mesma que o hook roda e o teste exercita): setTimeout no finally (não setInterval), diff-gate,
// alive, pending quando não está no fim. `forcar` = leitura pedida pelo usuário (tecla, envio,
// carregar mais): passa por cima do congelamento, como o press()/loadMore() da barra.
export function criarPanePoller(
  getPaneFn: GetPaneFn,
  name: string,
  lines: number,
  onSnapshot: (s: PaneSnapshot) => void,
  server: Server | null,
) {
  const snap: PaneSnapshot = { text: '', scrollback: 0, err: '', pending: false };
  let alive = true;
  let active = true;
  let generation = 0;
  let atBottom = true;
  let linhas = lines;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publicar = () => onSnapshot({ ...snap });

  // Publica SÓ quando algum campo mudou: com `onSnapshot` chamado a cada tick o React re-renderiza
  // de 450 em 450ms e o diff-gate deixa de valer pra quem consome o hook.
  async function ler(forcar: boolean, g: number) {
    if (!alive || !active || g !== generation) return;
    if (!server) throw new Error(m.servidor_nao_existe());
    const requestedLines = linhas;
    const p = await getPaneFn(name, requestedLines, server).catch((e: unknown) => {
      if (requestedLines !== linhas) return null;
      throw e;
    });
    if (!p || !alive || !active || g !== generation || requestedLines !== linhas) return;
    let mudou = false;
    if (snap.err !== '') { snap.err = ''; mudou = true; }
    if (snap.scrollback !== p.scrollback) { snap.scrollback = p.scrollback; mudou = true; }
    const t = p.text;
    if (t === snap.text) { if (mudou) publicar(); return; }   // diff-gate
    if (!atBottom && !forcar) {
      if (!snap.pending) { snap.pending = true; mudou = true; }
      if (mudou) publicar();
      return;
    }
    snap.text = t;
    if (forcar && snap.pending) snap.pending = false;
    publicar();
  }

  function erro(e: unknown, g: number) {
    if (!alive || !active || g !== generation) return;
    snap.err = e instanceof Error ? e.message : m.term_erro();
    publicar();
  }

  async function tick() {
    const g = generation;
    try {
      await ler(false, g);
    } catch (e) {
      erro(e, g);
    } finally {
      if (alive && active && g === generation) timer = setTimeout(tick, 450);
    }
  }

  function start() {
    if (!alive || !active) return;
    if (!server) erro(new Error(m.servidor_nao_existe()), generation);
    else void tick();
  }

  return {
    estado: () => ({ ...snap }),
    start,
    stop: () => { alive = false; clearTimeout(timer); },
    setActive: (v: boolean) => {
      if (!alive || v === active) return;
      active = v;
      generation++;
      clearTimeout(timer);
      if (active) start();
    },
    setAtBottom: (v: boolean) => {
      atBottom = v;
      if (v && snap.pending) { snap.pending = false; publicar(); }
    },
    setLines: (v: number) => { linhas = v; },
    refresh: async () => {
      const g = generation;
      try { await ler(true, g); } catch (e) { erro(e, g); }
    },
  };
}

export function usePanePoll(name: string, server: Server | null, lines = 200) {
  const [snap, setSnap] = useState<PaneSnapshot>({ text: '', scrollback: 0, err: '', pending: false });
  const poller = useRef<ReturnType<typeof criarPanePoller> | undefined>(undefined);

  useEffect(() => {
    const p = criarPanePoller(getPane, name, lines, setSnap, server);
    p.setActive((AppState.currentState ?? 'active') === 'active');
    setSnap(p.estado());
    poller.current = p;
    const subscription = AppState.addEventListener('change', (state) => p.setActive(state === 'active'));
    p.start();
    return () => { p.stop(); subscription.remove(); poller.current = undefined; };
    // `lines` não reinicia o laço de propósito (setLines abaixo) — porte do untrack da barra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, server]);

  useEffect(() => { poller.current?.setLines(lines); }, [lines]);

  const setAtBottom = useCallback((v: boolean) => poller.current?.setAtBottom(v), []);
  const setLines = useCallback((v: number) => poller.current?.setLines(v), []);
  const refresh = useCallback(async () => { await poller.current?.refresh(); }, []);

  return { ...snap, refresh, setAtBottom, setLines };
}
