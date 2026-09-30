// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { configureApi } from '@hangar/core';
import { currentIndex, taskMark, stepMark } from './planPanel';
import type { PlanDetail, Server } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('article', null, markdown),
}));
vi.mock('../../ui/Sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement('section', null, children) : null,
}));
vi.mock('../../paraglide/messages', () => ({
  plano_automatico: () => 'automatic', plano_nenhum: () => 'none', plano_trocar: () => 'choose-plan',
  plano_esconder_inteiro: () => 'hide-markdown', plano_ver_inteiro: () => 'show-markdown',
  plano_tasks: () => 'tasks', plano_carregando: () => 'plan-loading',
  plano_falha_leitura: () => 'plan-error', erro_sem_plano_ativo: () => 'no-plan',
  lista_tentar_novamente: () => 'retry',
  comum_carregando: () => 'picker-loading', comum_nenhum_modelo: () => 'empty', sessao_fechar: () => 'close',
}));

import { PlanPanel } from './PlanPanel';

function fakeDetail(task: number, task_total: number): PlanDetail {
  return {
    name: 'p',
    stem: 'p',
    path: '/tmp/p.md',
    task,
    task_total,
    done: 0,
    total: 10,
    complete: false,
    tasks: [],
    markdown: '',
  };
}

describe('planPanel', () => {
  it('current = detail.task - 1', () => {
    expect(currentIndex(fakeDetail(1, 3))).toBe(0);
    expect(currentIndex(fakeDetail(3, 3))).toBe(2);
    expect(currentIndex(null)).toBe(-1);
  });

  it('taskMark usa ✓ para concluída e ◐ para atual', () => {
    expect(taskMark(5, 5, false)).toBe('✓');
    expect(taskMark(0, 5, true)).toBe('◐');
    expect(taskMark(0, 5, false)).toBe('○');
  });

  it('stepMark distingue concluída', () => {
    expect(stepMark(true)).toBe('✓');
    expect(stepMark(false)).toBe('○');
  });
});

const serverB: Server = { id: 'plan-b', label: 'B', baseUrl: 'http://plan-b:8765', token: 'token-b' };
const serverC: Server = { id: 'plan-c', label: 'C', baseUrl: 'http://plan-c:8765', token: 'token-c' };
const plan: PlanDetail = {
  ...fakeDetail(1, 1), name: 'original-plan', markdown: '# Plano original',
  tasks: [{ title: 'original-task', done: 0, total: 1, steps: [{ title: 'original-step', done: false, manual: false, idx: 0 }] }],
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('PlanPanel — destino e respostas tardias', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let active: string;
  const fetchMock = vi.fn<typeof fetch>();

  async function render(server = serverB) {
    await act(async () => root.render(createElement(PlanPanel, { server, name: 'same-name', session: null })));
  }
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === label || item.textContent?.startsWith(label));
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  beforeEach(() => {
    vi.useFakeTimers();
    active = 'http://active-a:8765';
    configureApi({ getBaseUrl: () => active, getToken: () => 'token-active', onUnauthorized: vi.fn(), origin: null, createEventSource: vi.fn() as any });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) => String(url).endsWith('/plans')
      ? response({ plans: [{ stem: 'manual', name: 'manual-plan', done: 0, total: 1, complete: false }], pinned: null })
      : response(plan));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('detalhe, seletor e pin continuam em B quando o servidor ativo muda', async () => {
    await render();
    active = 'http://active-c:8765';
    await click('choose-plan');
    expect(container.textContent).toContain('manual-plan');
    fetchMock.mockImplementation(async (url, init) => init?.method === 'POST' ? response({ pinned: 'manual' }) : response(plan));
    await click('manual-plan');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://plan-b:8765/api/sessions/same-name/plan',
      'http://plan-b:8765/api/sessions/same-name/plans',
      'http://plan-b:8765/api/sessions/same-name/plan-pin',
      'http://plan-b:8765/api/sessions/same-name/plan',
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-b');
    expect(fetchMock.mock.calls[2][1]?.body).toBe('{"stem":"manual"}');
    await click('show-markdown');
    expect(container.querySelector('article')?.textContent).toBe('# Plano original');
  });

  it('trocar o destino descarta detalhe e seletor tardios da sessão de mesmo nome', async () => {
    const oldPlan = deferred();
    const oldPlans = deferred();
    fetchMock.mockImplementation((url) => String(url).startsWith('http://plan-b:')
      ? String(url).endsWith('/plans') ? oldPlans.promise : oldPlan.promise
      : Promise.resolve(response({ ...plan, tasks: [{ ...plan.tasks[0], title: 'new-task' }] })));
    await render();
    expect(container.textContent).toContain('plan-loading');
    await click('choose-plan');
    expect(container.textContent).toContain('picker-loading');
    await render(serverC);
    await act(async () => {
      oldPlan.resolve(response(plan));
      oldPlans.resolve(response({ plans: [{ stem: 'stale', name: 'stale-plan', done: 0, total: 1, complete: false }], pinned: 'stale' }));
    });
    expect(container.textContent).toContain('new-task');
    expect(container.textContent).not.toContain('original-task');
    expect(container.textContent).not.toContain('stale-plan');
    expect(container.textContent).not.toContain('picker-loading');
  });

  it('leitura que leva 6 segundos termina sem ser invalidada pelo poll de 5 segundos', async () => {
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(response(plan)), 6000);
    }));
    await render();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(container.textContent).toContain('plan-loading');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toContain('original-task');
    expect(container.textContent).not.toContain('plan-loading');
  });

  it('pin enviado a B não atualiza C nem repete o POST depois da troca', async () => {
    await render();
    await click('choose-plan');
    const oldPin = deferred();
    fetchMock.mockImplementation((url, init) => init?.method === 'POST' ? oldPin.promise : Promise.resolve(response(plan)));
    await click('manual-plan');
    expect(container.textContent).toContain('picker-loading');
    await render(serverC);
    const count = fetchMock.mock.calls.length;
    await act(async () => oldPin.resolve(response({ pinned: 'manual' })));
    expect(fetchMock.mock.calls).toHaveLength(count);
    expect(container.querySelector('button[aria-label="choose-plan"]')?.textContent).toContain('automatic');
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toBe('http://plan-b:8765/api/sessions/same-name/plan-pin');
  });

  it('404 termina o carregamento e falha de refresh com detalhe oferece nova leitura', async () => {
    fetchMock.mockResolvedValueOnce(response(null, 404));
    await render();
    expect(container.textContent).toContain('no-plan');
    expect(container.textContent).not.toContain('plan-loading');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(container.textContent).toContain('original-task');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(container.textContent).toContain('plan-error');
    await click('retry');
    expect(container.textContent).toContain('original-task');
    expect(container.textContent).not.toContain('plan-error');
  });

  it('seletor mostra erro da leitura e permite tentar de novo sem mudar destino', async () => {
    await render();
    fetchMock.mockResolvedValueOnce(response({ detail: 'unavailable' }, 503));
    await click('choose-plan');
    expect(container.textContent).toContain('unavailable');
    expect(container.textContent).not.toContain('picker-loading');
    await click('retry');
    expect(container.textContent).toContain('manual-plan');
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('http://plan-b:8765/api/sessions/same-name/plans');
  });
});
