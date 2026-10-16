// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { createClassComponent } from 'svelte/legacy';
import HomeSessions from './HomeSessions.svelte';
import { overwriteGetLocale } from '../paraglide/runtime';

const store = vi.hoisted(() => ({ rows: [] as unknown[], byServer: [] as unknown[], loading: false }));
const model = vi.hoisted(() => ({ open: vi.fn(), requestDelete: vi.fn(), doDelete: vi.fn(), confirmDel: null, mount: () => () => {} }));
vi.mock('../lib/sessionsStore.svelte', () => ({ sessionsStore: store }));
vi.mock('../lib/sessionListModel.svelte', () => ({ createSessionListModel: () => model }));
vi.mock('./SessionCard.svelte', async () => ({ default: (await import('../screens/ComposerStub.svelte')).default }));

const server = (id: string) => ({ id, label: id, baseUrl: `https://${id}.test`, token: 't' });
const row = (name: string, state: string) => ({ name, state, serverId: 'a', serverLabel: 'a', serverColor: '#fff' });

let target: HTMLElement;
let component: { $destroy(): void } | null = null;
async function mount() {
  component = createClassComponent({ component: HomeSessions, target, props: { onOpenChat: vi.fn() } });
  await tick();
  return target.textContent ?? '';
}
beforeEach(() => {
  overwriteGetLocale(() => 'pt');
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => { component?.$destroy(); component = null; target.remove(); });

it('carregando enquanto nenhuma máquina respondeu', async () => {
  Object.assign(store, { loading: true, rows: [], byServer: [{ server: server('a'), sessions: [], error: null, loaded: false }] });
  expect(await mount()).toContain('Carregando sessões');
});

it('vazio quando as máquinas responderam sem sessão aberta', async () => {
  Object.assign(store, { loading: false, rows: [], byServer: [{ server: server('a'), sessions: [], error: null, loaded: true }] });
  expect(await mount()).toContain('Nenhuma sessão ativa');
});

it('erro por máquina aparece junto das sessões das outras', async () => {
  Object.assign(store, { loading: false, rows: [row('s1', 'working')], byServer: [
    { server: server('a'), sessions: [], error: null, loaded: true },
    { server: server('b'), sessions: [], error: 'offline', loaded: false },
  ] });
  const text = await mount();
  expect(text).toContain('b offline');
  expect(text).toContain('Trabalhando');
});

it('sucesso agrupa e "mais N prontas" expande', async () => {
  Object.assign(store, { loading: false, rows: [row('p1', 'idle'), row('w1', 'awaiting_input'), row('p2', 'idle')],
    byServer: [{ server: server('a'), sessions: [], error: null, loaded: true }] });
  const text = await mount();
  expect(text.indexOf('Esperando você')).toBeLessThan(text.indexOf('Prontas'));
  const more = target.querySelector<HTMLButtonElement>('.more')!;
  expect(more.textContent).toContain('mais 1 prontas');
  more.click(); await tick();
  expect(more.getAttribute('aria-expanded')).toBe('true');
});
