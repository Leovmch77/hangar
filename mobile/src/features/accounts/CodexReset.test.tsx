// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credencial, CodexResetOutcome, Server } from '@hangar/core';
import { overwriteGetLocale } from '../../paraglide/runtime';
import { AccountReset, ResetFeedback } from './CodexReset';

const calls = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock('@hangar/core', async original => ({ ...await original<typeof import('@hangar/core')>(), consumeCodexRateLimitResetForServer: calls.consume }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
overwriteGetLocale(() => 'pt');
let serial = 0;
let server: Server;
const roots: Array<ReturnType<typeof createRoot>> = [];
const credential = (id = 'work'): Credencial => ({
  id: `codex:/${id}`, tipo: 'codex', codex_account: id, nome: id, nome_natural: id, ativa: true, usos: [],
  cota: { estado: 'lida', janelas: [{ rotulo: '7d', pct: 100 }], reset_credits: {
    available_count: 1, credits: [{ id: 'credit1', status: 'available', expires_at: 2_500_000_000, title: 'Crédito semanal', description: 'Uma redefinição' }],
  } },
});
beforeEach(() => {
  server = { id: `reset-${++serial}`, baseUrl: 'https://b.local', token: 'token-b', label: 'B' };
  calls.consume.mockReset();
});
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); vi.restoreAllMocks(); });
function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)!;
}
async function click(container: HTMLElement, label: string) {
  const target = button(container, label);
  expect(target, `botão ${label}`).toBeTruthy();
  await act(async () => target.click());
}
async function show(list: Credencial[], onDefinitive = vi.fn(), s = server) {
  const container = document.createElement('div');
  const root = createRoot(container); roots.push(root);
  const render = (next: Credencial[], target = s) => act(async () => root.render(createElement(Fragment, null,
    createElement(ResetFeedback, { key: `${target.id}:${target.token}`, server: target, credentialIds: next.map(c => c.id), onDefinitive }),
    ...next.map(c => createElement(AccountReset, { key: `${target.id}:${target.token}:${c.id}`, server: target, credential: c })),
  )));
  await render(list);
  return { container, root, render };
}

describe('redefinição da cota Codex', () => {
  it('só libera a janela 7d lida em 100%, nunca a de 5h ou por modelo', async () => {
    const c = credential();
    c.cota!.janelas = [{ rotulo: '5h', pct: 100 }, { rotulo: 'sonnet', pct: 100, por_modelo: true }];
    const view = await show([c]);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    expect(view.container.textContent).toContain('janela de 7 dias');
    c.cota!.janelas.push({ rotulo: '7d', pct: 99 });
    await view.render([c]);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    c.cota!.janelas[2].pct = 100;
    await view.render([c]);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(false);
    expect(view.container.textContent).toContain('Crédito semanal');
    c.cota!.estado = 'indisponivel';
    await view.render([c]);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled ?? true).toBe(true);
    await view.render([{ ...credential(), tipo: 'claude' }]);
    expect(button(view.container, 'Usar redefinição guardada')).toBeUndefined();
  });

  it('confirma antes de consumir e trava dois toques síncronos com UUID v4', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let done!: (value: { outcome: CodexResetOutcome }) => void;
    calls.consume.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const view = await show([credential()]);
    await click(view.container, 'Usar redefinição guardada');
    expect(calls.consume).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Gastar uma redefinição');
    const confirm = button(view.container, 'Confirmar redefinição');
    await act(async () => { confirm.click(); confirm.click(); });
    expect(calls.consume).toHaveBeenCalledTimes(1);
    expect(calls.consume).toHaveBeenCalledWith(server, 'work', 'credit1', '00000000-0000-4000-8000-000000000000');
    await act(async () => done({ outcome: 'reset' }));
  });

  it('repete a mesma tentativa após erro, oferta removida e desmontagem, bloqueando outra conta', async () => {
    calls.consume.mockRejectedValue(new Error('resposta perdida'));
    const c = credential();
    const view = await show([c, credential('other')]);
    await click(view.container, 'Usar redefinição guardada');
    await click(view.container, 'Confirmar redefinição');
    const uuid = calls.consume.mock.calls[0][3];
    expect(view.container.textContent).toContain('resposta perdida');
    expect(button(view.container, 'Cancelar')).toBeUndefined();
    await act(async () => view.root.unmount()); roots.splice(roots.indexOf(view.root), 1);
    c.cota!.reset_credits = { available_count: 0, credits: [] };
    const next = await show([c, credential('other')]);
    expect(button(next.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    await click(next.container, 'Repetir a mesma tentativa');
    expect(calls.consume).toHaveBeenLastCalledWith(server, 'work', 'credit1', uuid);
    await next.render([credential('other')]);
    expect(next.container.textContent).toContain('work');
    expect(button(next.container, 'Repetir a mesma tentativa')).toBeTruthy();
    calls.consume.mockResolvedValue({ outcome: 'alreadyRedeemed' });
    await click(next.container, 'Repetir a mesma tentativa');
    expect(next.container.textContent).toContain('já foi usada');
  });

  it.each([409, 422])('recusa %s inicial mantém a causa e permite cancelar para escolher outra conta', async status => {
    const message = `${status}: codex_reset_weekly_not_exhausted`;
    calls.consume.mockRejectedValueOnce(Object.assign(new Error(message), { status }));
    const view = await show([credential(), credential('other')]);
    await click(view.container, 'Usar redefinição guardada'); await click(view.container, 'Confirmar redefinição');
    expect(view.container.textContent).toContain(message);
    expect(button(view.container, 'Cancelar')).toBeTruthy();
    expect(button(view.container, 'Repetir a mesma tentativa')).toBeUndefined();
    await click(view.container, 'Cancelar');
    const offers = [...view.container.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === 'Usar redefinição guardada');
    expect(offers[1].disabled).toBe(false);
    await act(async () => offers[1].click());
    calls.consume.mockResolvedValue({ outcome: 'noCredit' });
    await click(view.container, 'Confirmar redefinição');
    expect(calls.consume).toHaveBeenLastCalledWith(server, 'other', 'credit1', expect.any(String));
  });

  it.each([409, 422])('timeout seguido de %s conserva pendência sem Cancelar e repete o mesmo UUID', async status => {
    const message = `${status}: codex_reset_weekly_not_exhausted`;
    calls.consume.mockRejectedValueOnce(new Error('request timeout'))
      .mockRejectedValueOnce(Object.assign(new Error(message), { status }));
    const view = await show([credential(), credential('other')]);
    await click(view.container, 'Usar redefinição guardada'); await click(view.container, 'Confirmar redefinição');
    const uuid = calls.consume.mock.calls[0][3];
    await click(view.container, 'Repetir a mesma tentativa');
    expect(view.container.textContent).toContain(message);
    expect(button(view.container, 'Cancelar')).toBeUndefined();
    expect(button(view.container, 'Repetir a mesma tentativa')).toBeTruthy();
    expect(calls.consume).toHaveBeenLastCalledWith(server, 'work', 'credit1', uuid);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    calls.consume.mockResolvedValue({ outcome: 'alreadyRedeemed' });
    await click(view.container, 'Repetir a mesma tentativa');
    expect(calls.consume).toHaveBeenLastCalledWith(server, 'work', 'credit1', uuid);
  });

  it.each([408, 429, 401, 400])('HTTP %s mantém incerteza, mesma UUID e bloqueio das outras contas', async status => {
    calls.consume.mockRejectedValue(Object.assign(new Error(`${status}: proxy refused`), { status }));
    const view = await show([credential(), credential('other')]);
    await click(view.container, 'Usar redefinição guardada'); await click(view.container, 'Confirmar redefinição');
    const uuid = calls.consume.mock.calls[0][3];
    expect(button(view.container, 'Cancelar')).toBeUndefined();
    expect(button(view.container, 'Repetir a mesma tentativa')).toBeTruthy();
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    await click(view.container, 'Repetir a mesma tentativa');
    expect(calls.consume).toHaveBeenLastCalledWith(server, 'work', 'credit1', uuid);
  });

  it.each(['http-503', 'invalid-response'])('mantém resultado incerto para %s', async failure => {
    if (failure === 'http-503') calls.consume.mockRejectedValue(Object.assign(new Error('503: unavailable'), { status: 503 }));
    else calls.consume.mockResolvedValue({ outcome: 'invalid' });
    const view = await show([credential()]);
    await click(view.container, 'Usar redefinição guardada'); await click(view.container, 'Confirmar redefinição');
    expect(button(view.container, 'Cancelar')).toBeUndefined();
    expect(button(view.container, 'Repetir a mesma tentativa')).toBeTruthy();
  });

  it('mudar URL/token da mesma máquina conserva pendência e UUID usando o alvo novo no retry', async () => {
    calls.consume.mockRejectedValue(new Error('resposta perdida'));
    const view = await show([credential(), credential('other')]);
    await click(view.container, 'Usar redefinição guardada'); await click(view.container, 'Confirmar redefinição');
    const uuid = calls.consume.mock.calls[0][3];
    const moved = { ...server, baseUrl: 'https://new.local', token: 'new-token' };
    await view.render([credential(), credential('other')], moved);
    expect(button(view.container, 'Repetir a mesma tentativa')).toBeTruthy();
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    calls.consume.mockResolvedValue({ outcome: 'alreadyRedeemed' });
    await click(view.container, 'Repetir a mesma tentativa');
    expect(calls.consume).toHaveBeenLastCalledWith(moved, 'work', 'credit1', uuid);
  });

  it('mudança de endereço com consumo em voo mantém pendência sem aplicar resposta do alvo antigo', async () => {
    let done!: (value: { outcome: CodexResetOutcome }) => void;
    calls.consume.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const reload = vi.fn(); const view = await show([credential()], reload);
    await click(view.container, 'Usar redefinição guardada'); await click(view.container, 'Confirmar redefinição');
    const uuid = calls.consume.mock.calls[0][3];
    const moved = { ...server, baseUrl: 'https://new.local', token: 'new-token' };
    await view.render([credential()], moved);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(true);
    await act(async () => done({ outcome: 'reset' }));
    expect(reload).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain('Cota redefinida');
    calls.consume.mockResolvedValue({ outcome: 'alreadyRedeemed' });
    await click(view.container, 'Repetir a mesma tentativa');
    expect(calls.consume).toHaveBeenLastCalledWith(moved, 'work', 'credit1', uuid);
  });

  it.each([
    ['reset', 'Cota redefinida'], ['nothingToReset', 'Nada a redefinir'],
    ['noCredit', 'Nenhuma redefinição disponível'], ['alreadyRedeemed', 'já foi usada'],
  ] as const)('mostra resultado %s e pede nova leitura definitiva', async (outcome, text) => {
    calls.consume.mockResolvedValue({ outcome });
    const reload = vi.fn();
    const view = await show([credential()], reload);
    await click(view.container, 'Usar redefinição guardada');
    await click(view.container, 'Confirmar redefinição');
    expect(view.container.textContent).toContain(text);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('uma resposta antiga não recarrega outra máquina nem perde a pendência da origem', async () => {
    let done!: (value: { outcome: CodexResetOutcome }) => void;
    calls.consume.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const reload = vi.fn();
    const view = await show([credential()], reload);
    await click(view.container, 'Usar redefinição guardada');
    await click(view.container, 'Confirmar redefinição');
    const other = { ...server, id: `${server.id}-other`, baseUrl: 'https://new.local', token: 'new-token' };
    await view.render([credential()], other);
    expect(button(view.container, 'Usar redefinição guardada')?.disabled).toBe(false);
    await act(async () => done({ outcome: 'reset' }));
    expect(reload).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain('Cota redefinida');
    await view.render([credential()], server);
    expect(view.container.textContent).toContain('Cota redefinida');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
