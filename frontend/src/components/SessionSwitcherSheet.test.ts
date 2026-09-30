// @vitest-environment happy-dom
// Busca de conteúdo: cada servidor entra na lista quando responde, resposta de termo velho é
// descartada e servidor já marcado fora do ar não é consultado.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import * as m from '../paraglide/messages';
import type { SearchHit } from '@hangar/core';

const servers = [
  { id: 'a', label: 'Alfa', baseUrl: 'http://a', token: 't' },
  { id: 'b', label: 'Beta', baseUrl: 'http://b', token: 't' },
  { id: 'c', label: 'Gama', baseUrl: 'http://c', token: 't' },
];
const offline = new Set<string>();
type Call = { id: string; q: string; resolve: (h: SearchHit[]) => void; reject: (e: Error) => void };
let calls: Call[] = [];

vi.mock('../lib/auth', () => ({
  listServers: () => servers,
  listOwnServers: () => servers,
  selectServer: vi.fn(),
  serverColor: () => '#fff',
  getActiveId: () => 'a',
}));
vi.mock('@hangar/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hangar/core')>()),
  estaDesligado: (id: string) => offline.has(id),
  searchTranscriptsForServer: (s: { id: string }, q: string) =>
    new Promise<SearchHit[]>((resolve, reject) => { calls.push({ id: s.id, q, resolve, reject }); }),
}));

const { default: Sheet } = await import('./SessionSwitcherSheet.svelte');

const hit = (session_id: string, mtime: number, line = 'x'): SearchHit =>
  ({ session_id, project: 'p', line, mtime, role: 'user', live: false }) as SearchHit;

async function montar() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const comp = mount(Sheet, {
    target: el,
    props: { open: true, sessions: [], currentName: '', onPick: vi.fn(), onNew: vi.fn(), onClose: vi.fn(), searchOnly: true },
  });
  await tick();
  return { comp };
}
async function digitar(v: string) {
  const input = document.body.querySelector<HTMLInputElement>('input.search')!;
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300)); // debounce de 250 ms
  await tick();
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await tick(); };
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  calls = [];
  offline.clear();
  document.body.innerHTML = '';
});

describe('SessionSwitcherSheet: busca de conteúdo', () => {
  it('mostra o primeiro servidor que responde e lista quem ainda falta', async () => {
    const { comp } = await montar();
    await digitar('foo');
    expect(calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(text()).toContain(m.switcher_buscando());

    calls.find((c) => c.id === 'b')!.resolve([hit('s1', 10, 'antigo')]);
    await settle();
    expect(text()).not.toContain(m.switcher_buscando());
    expect(text()).toContain('antigo');
    expect(text()).toContain(m.busca_aguardando({ servidores: 'Alfa, Gama' }));

    calls.find((c) => c.id === 'a')!.resolve([hit('s2', 20, 'recente')]);
    calls.find((c) => c.id === 'c')!.reject(new Error('timeout'));
    await settle();
    const snippets = [...document.body.querySelectorAll('.hit-snippet')].map((e) => e.textContent);
    expect(snippets).toEqual(['recente', 'antigo']); // mais recente primeiro
    expect(text()).toContain(m.busca_servidor_falhou({ servidor: 'Gama' }));
    expect(text()).not.toContain(m.busca_aguardando({ servidores: 'Gama' }));
    unmount(comp);
  });

  it('descarta resposta de um termo antigo', async () => {
    const { comp } = await montar();
    await digitar('velho');
    const velhas = [...calls];
    await digitar('novo');
    velhas.forEach((c) => c.resolve([hit('v', 1, 'resposta-velha')]));
    await settle();
    expect(text()).not.toContain('resposta-velha');
    expect(text()).toContain(m.switcher_buscando());
    unmount(comp);
  });

  it('não consulta servidor marcado fora do ar e avisa que pulou', async () => {
    offline.add('c');
    offline.add('a'); // o ativo nunca é pulado
    const { comp } = await montar();
    await digitar('foo');
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    calls.forEach((c) => c.resolve([]));
    await settle();
    expect(text()).toContain(m.busca_pulados({ servidores: 'Gama' }));
    unmount(comp);
  });
});
