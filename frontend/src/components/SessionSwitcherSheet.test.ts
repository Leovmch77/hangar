// @vitest-environment happy-dom
// Busca de conteúdo: cada servidor entra na lista quando responde, resposta de termo velho é
// descartada, servidor marcado fora do ar é consultado por último e falha pode ser refeita.
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
let own = servers;
type Call = { id: string; q: string; resolve: (h: SearchHit[]) => void; reject: (e: Error) => void };
let calls: Call[] = [];

vi.mock('../lib/auth', () => ({
  listServers: () => servers,
  listOwnServers: () => own,
  selectServer: vi.fn(),
  serverColor: () => '#fff',
  getActiveId: () => 'a',
  servidorDaOrigem: () => null,
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
function setInput(v: string) {
  const input = document.body.querySelector<HTMLInputElement>('input.search')!;
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function digitar(v: string) {
  setInput(v);
  await new Promise((r) => setTimeout(r, 300)); // debounce de 250 ms
  await tick();
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await tick(); };
const text = () => document.body.textContent ?? '';
const nenhum = () => m.busca_nenhum_todas({ termos: 'foo' });

beforeEach(() => {
  calls = [];
  offline.clear();
  own = servers;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    calls.find((c) => c.id === 'c')!.reject(new DOMException('t', 'TimeoutError'));
    await settle();
    const snippets = [...document.body.querySelectorAll('.hit-snippet')].map((e) => e.textContent);
    expect(snippets).toEqual(['recente', 'antigo']); // mais recente primeiro
    expect(text()).toContain(m.busca_servidor_falhou_motivo({ servidor: 'Gama', motivo: m.busca_motivo_timeout() }));
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

  it('apagar e redigitar o mesmo termo descarta as respostas da busca anterior', async () => {
    const { comp } = await montar();
    await digitar('foo');
    const velhas = [...calls];
    setInput('');
    await tick();
    setInput('foo');
    await tick();
    velhas.forEach((c) => c.resolve([hit('v', 1, 'resposta-velha')]));
    await settle();
    expect(text()).not.toContain('resposta-velha');
    unmount(comp);
  });

  it('consulta por último o servidor fora do ar e mostra que está tentando', async () => {
    offline.add('b');
    offline.add('a'); // o ativo não vai para o fim da fila
    const { comp } = await montar();
    await digitar('foo');
    expect(calls.map((c) => c.id)).toEqual(['a', 'c', 'b']);
    calls.find((c) => c.id === 'a')!.resolve([]);
    calls.find((c) => c.id === 'c')!.resolve([]);
    await settle();
    expect(text()).toContain(m.busca_tentando_fora({ servidores: 'Beta' }));
    expect(text()).not.toContain(nenhum());
    calls.find((c) => c.id === 'b')!.resolve([hit('s9', 5, 'voltou')]);
    await settle();
    expect(text()).toContain('voltou');
    expect(text()).not.toContain(m.busca_tentando_fora({ servidores: 'Beta' }));
    unmount(comp);
  });

  it('"nenhum resultado" só quando todos responderam sem falha', async () => {
    const { comp } = await montar();
    await digitar('foo');
    calls.find((c) => c.id === 'a')!.resolve([]);
    calls.find((c) => c.id === 'b')!.reject(new Error('503'));
    calls.find((c) => c.id === 'c')!.resolve([]);
    await settle();
    expect(text()).not.toContain(nenhum());

    await digitar('');
    calls = [];
    await digitar('foo');
    calls.forEach((c) => c.resolve([]));
    await settle();
    expect(text()).toContain(nenhum());
    unmount(comp);
  });

  it('tentar de novo refaz só os servidores que falharam', async () => {
    const { comp } = await montar();
    await digitar('foo');
    calls.find((c) => c.id === 'a')!.resolve([hit('s1', 10, 'primeiro')]);
    calls.find((c) => c.id === 'b')!.reject(new Error('503'));
    calls.find((c) => c.id === 'c')!.resolve([]);
    await settle();
    expect(text()).toContain(m.busca_servidor_falhou_motivo({ servidor: 'Beta', motivo: m.busca_motivo_http({ status: '503' }) }));
    expect(text()).toContain('primeiro');

    calls = [];
    document.body.querySelector<HTMLButtonElement>('.retry-btn')!.click();
    await tick();
    expect(calls.map((c) => [c.id, c.q])).toEqual([['b', 'foo']]);
    expect(document.body.querySelector('.list')!.getAttribute('aria-busy')).toBe('true');
    calls[0].resolve([hit('s2', 20, 'segundo')]);
    await settle();
    expect(text()).toContain('primeiro');
    expect(text()).toContain('segundo');
    expect(document.body.querySelector('.retry-btn')).toBeNull();
    unmount(comp);
  });

  it('só convite: avisa que não há servidor próprio em vez de "nenhum resultado"', async () => {
    own = [];
    const { comp } = await montar();
    await digitar('foo');
    expect(calls).toEqual([]);
    expect(text()).toContain(m.busca_sem_servidores());
    expect(text()).not.toContain(nenhum());
    unmount(comp);
  });

  it('um só role=status, que troca de texto', async () => {
    const { comp } = await montar();
    await digitar('foo');
    expect(document.body.querySelectorAll('.list [role="status"]').length).toBe(1);
    calls.forEach((c) => c.resolve([hit('s1', 1, 'x')]));
    await settle();
    expect(document.body.querySelectorAll('.list [role="status"]').length).toBe(1);
    unmount(comp);
  });
});
