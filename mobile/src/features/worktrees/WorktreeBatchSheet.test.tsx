// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreeBatchProgress, WorktreeStatus } from '@hangar/core';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ deleteWorktreeBatchForServer: vi.fn() }));
const status = vi.hoisted(() => ({ dropWorktreeStatus: vi.fn() }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../../ui/Toast', () => ({ toast: { ok: vi.fn(), erro: vi.fn() } }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('../../stores/sessions', () => ({ useSessions: () => undefined }));
vi.mock('./worktreeStatus', () => status);
// Cada mensagem vira "chave:params", para o teste conferir qual frase saiu e com o quê.
vi.mock('../../paraglide/messages', () => Object.fromEntries([
  'comum_cancelar', 'worktree_lote_titulo', 'worktree_libera', 'worktree_apagar_perde', 'worktree_lote_nada_perde',
  'worktree_nao_commitados', 'worktree_lote_com_arquivos', 'worktree_lote_ficam', 'worktree_sessao_aberta',
  'worktree_lote_leitura_falhou', 'worktree_lote_apagar_n', 'worktree_tamanho_parcial',
  'worktree_lote_apagando_titulo', 'worktree_lote_fim_titulo', 'worktree_lote_apagando', 'worktree_lote_progresso',
  'worktree_lote_falhas', 'worktree_lote_mudou', 'worktree_lote_erro_item', 'worktree_lote_fechar',
].map((k) => [k, (p?: Record<string, unknown>) => (p ? `${k}:${Object.values(p).join(',')}` : k)])));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...api }));
import { WorktreeBatchSheet } from './WorktreeBatchSheet';

const wt = (nome: string, size: number) => ({ path: `/r/${nome}`, repo: '/r/hangar', exists: true, branch: nome, base: 'main',
  merged: true, ahead: 0, dirty: 0, ignored: [], sessions: [], closed: 0, size }) as unknown as WorktreeStatus;
const [a, b, c] = [wt('a', 2048), wt('b', 1024), wt('c', 1024)];
const prog = (p: Partial<WorktreeBatchProgress>): WorktreeBatchProgress =>
  ({ total: 3, done: 0, current: null, removed: [], failed: [], freed: { bytes: 0, partial: false }, ...p });

const botao = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')]
  .find((x) => x.getAttribute('aria-label') === label || x.textContent === label) ?? null;

describe('WorktreeBatchSheet', () => {
  it('mostra o progresso real e só oferece fechar no fim', async () => {
    let terminar = () => {};
    let avisar: (p: WorktreeBatchProgress) => void = () => {};
    const fim = prog({ done: 3, removed: [a], failed: [{ worktree: b, error: null }, { worktree: c, error: 'boom' }] });
    api.deleteWorktreeBatchForServer.mockImplementation((_s, _r, _ws, onProgress) => {
      avisar = onProgress;
      onProgress(prog({ current: a }));
      return new Promise((res) => { terminar = () => { onProgress(fim); res(fim); }; });
    });
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    const el = document.createElement('div');
    const root = createRoot(el);
    const render = (batch: unknown) => root.render(createElement(WorktreeBatchSheet,
      { server: { id: 's' } as never, batch: batch as never, onClose, onDeleted }));
    await act(async () => { render({ repo: '/r/hangar', deletable: [a, b, c], blocked: [] }); });

    await act(async () => { botao(el, 'worktree_lote_apagar_n:3')!.click(); });
    expect(api.deleteWorktreeBatchForServer).toHaveBeenCalledWith(expect.anything(), '/r/hangar', [a, b, c], expect.any(Function));
    expect(el.textContent).toContain('worktree_lote_apagando_titulo');
    expect(el.textContent).toContain('worktree_lote_apagando:a');
    expect(el.textContent).toContain('worktree_lote_progresso:0,3,0 B');
    expect(el.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(botao(el, 'worktree_lote_fechar')).toBeNull();
    expect(el.textContent).not.toContain('comum_cancelar');

    await act(async () => { avisar(prog({ done: 1, current: b, removed: [a] })); });
    expect(el.textContent).toContain('worktree_lote_progresso:1,3,2 KB');
    expect(el.textContent).toContain('worktree_lote_apagando:b');
    expect(botao(el, 'worktree_lote_fechar')).toBeNull();

    await act(async () => { terminar(); });
    expect(el.textContent).toContain('worktree_lote_fim_titulo');
    expect(el.textContent).not.toContain('worktree_lote_apagando:');
    expect(el.textContent).toContain('worktree_lote_falhas:2');
    expect(el.textContent).toContain('worktree_lote_mudou:b');
    expect(el.textContent).toContain('worktree_lote_erro_item:c,boom');
    expect(status.dropWorktreeStatus).toHaveBeenCalledWith('s', '/r/a');
    expect(status.dropWorktreeStatus).not.toHaveBeenCalledWith('s', '/r/b');
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { botao(el, 'worktree_lote_fechar')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('falha inesperada do lote aparece e deixa fechar', async () => {
    api.deleteWorktreeBatchForServer.mockImplementation((_s, _r, _ws, onProgress) => {
      onProgress(prog({ current: a }));
      return Promise.reject(new Error('caiu'));
    });
    const onDeleted = vi.fn();
    const el = document.createElement('div');
    await act(async () => { createRoot(el).render(createElement(WorktreeBatchSheet,
      { server: { id: 's' } as never, batch: { repo: '/r/hangar', deletable: [a], blocked: [] }, onClose: () => {}, onDeleted })); });
    await act(async () => { botao(el, 'worktree_lote_apagar_n:1')!.click(); });
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('caiu');
    expect(botao(el, 'worktree_lote_fechar')).not.toBeNull();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});
