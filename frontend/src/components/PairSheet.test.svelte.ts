// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import * as m from '../paraglide/messages';

const core = vi.hoisted(() => ({
  getSessions: vi.fn(async () => [{ name: 'eu', state: 'idle', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['lab::x', 'vizinha'] }]),
  getHistory: vi.fn(async () => []),
  getPairContract: vi.fn(async () => ({ path: '/c.md', content: '' })),
}));
const store = vi.hoisted(() => ({
  rows: [] as unknown[],
  identities: new Map<string, string>(),
  identityStatus: new Map<string, 'reading' | 'failed'>(),
  servers: [{ id: 'srv-a', label: 'Casa' }, { id: 'srv-b', label: 'Lab' }, { id: 'srv-off', label: 'Desligada' }],
  requestIdentities: vi.fn(),
  anchoredPairs: () => [],
}));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), ...core }));
vi.mock('../lib/sessionsStore.svelte', () => ({ sessionsStore: store }));
vi.mock('../lib/auth', () => ({
  getActiveId: () => 'srv-a',
  findServer: (id: string) => store.servers.find((s) => s.id === id),
  listServers: () => store.servers,
}));

const PairSheet = (await import('./PairSheet.svelte')).default;

async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await tick(); } }
function montar() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return mount(PairSheet, { target: el, props: { open: true, sessionName: 'eu', pairPeers: ['lab::x', 'vizinha'], serverId: 'srv-a',
    onClose: vi.fn(), onChanged: vi.fn(), onOpenPeerChat: vi.fn(), onOpenSplit: vi.fn() } });
}
const row = (over: Record<string, unknown>) => ({ serverId: 'srv-a', serverLabel: 'Casa', serverColor: '#000', state: 'idle', ...over });
const conversaDe = (nome: string) => document.querySelector(`button[aria-label="${m.ctx_abrir_sessao_modal({ n: nome })}"]`);

beforeEach(() => {
  document.body.innerHTML = '';
  store.rows = [row({ name: 'eu', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['lab::x', 'vizinha'] }),
    row({ name: 'vizinha', pair_gid: 'g', pair_owner: 'casa', pair_peers: ['lab::x', 'eu'] })];
  store.identities = new Map([['srv-a', 'casa']]);
  store.identityStatus = new Map();
});

describe('PairSheet — grupo entre máquinas', () => {
  it('máquina fora do ar não segura o carregando; a que falhou aparece com aviso e o par dela não é local', async () => {
    store.identityStatus = new Map([['srv-b', 'failed']]);
    const c = montar();
    await settle();
    expect(document.body.textContent).not.toContain(m.comum_carregando());
    expect(document.body.textContent).toContain(`⚠ Lab: ${m.grupo_recusa_sem_identificador()}`);
    expect(document.body.textContent).toContain('lab::x');
    expect(conversaDe('lab::x')).toBeNull();
    expect(conversaDe('vizinha')).not.toBeNull();
    unmount(c);
  });

  it('leitura em voo numa máquina conectada: carregando, e o endereço de fora não ganha botão local', async () => {
    store.identityStatus = new Map([['srv-b', 'reading']]);
    const c = montar();
    await settle();
    expect(document.body.textContent).toContain(m.comum_carregando());
    expect(conversaDe('lab::x')).toBeNull();
    unmount(c);
  });
});
