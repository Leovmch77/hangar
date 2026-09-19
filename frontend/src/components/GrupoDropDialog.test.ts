// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import GrupoDropDialog from './GrupoDropDialog.svelte';
import { arrastarGrupo } from '../lib/arrastarGrupo.svelte';
import * as m from '../paraglide/messages';
import * as apiLib from '@hangar/core';
import { withServer } from '../lib/auth';
import type { AggSession } from '@hangar/core';

const storeState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@hangar/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hangar/core')>()),
  pairSession: vi.fn(),
  unpairSession: vi.fn(),
}));
const api = vi.mocked(apiLib);

vi.mock('../lib/auth', () => ({
  withServer: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../lib/sessionsStore.svelte', () => ({
  sessionsStore: { get rows() { return storeState.rows; } },
}));

function sess(over: Partial<AggSession> = {}): AggSession {
  return {
    name: 'a', serverId: 'srv1', serverLabel: 'srv1', serverColor: '#123',
    state: 'idle', pair_gid: null, pair_peers: null, pair_task: null,
    ...over,
  } as AggSession;
}

function montar() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  // ModalDialog porta o conteúdo pro document.body — as buscas abaixo usam `document`.
  return mount(GrupoDropDialog, { target: el, props: {} });
}

function tarefaInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.gd-tarefa')!;
}
function digitar(texto: string) {
  const input = tarefaInput();
  input.value = texto;
  input.dispatchEvent(new Event('input'));
}
function clicarBotao(rotulo: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === rotulo);
  expect(btn, `botão "${rotulo}" não encontrado`).toBeTruthy();
  btn!.click();
}

// Mesmo helper do CreateSessionSheet.test.ts: o clique dispara uma cadeia de promises
// (withServer -> pairSession/unpairSession mockados) que um `tick()` só não alcança.
function flush(): Promise<void> {
  return (async () => {
    for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); }
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState.rows = [];
  arrastarGrupo.cancelar();
});
afterEach(() => {
  document.body.innerHTML = '';
  arrastarGrupo.cancelar();
});

describe('GrupoDropDialog — modo agrupar', () => {
  it('confirmar chama pairSession com a tarefa digitada e o serverId do ALVO', async () => {
    storeState.rows = [
      sess({ name: 'origem', serverId: 'srv1' }),
      sess({ name: 'alvo', serverId: 'srv1' }),
    ];
    api.pairSession.mockResolvedValue({ ok: true, warning: null });
    const comp = montar();

    arrastarGrupo.comecar({ serverId: 'srv1', name: 'origem' });
    arrastarGrupo.soltar('srv1::alvo');
    await tick();

    digitar('PM-1');
    await tick();
    clicarBotao(m.grupo_drop_confirmar());
    await flush();

    expect(withServer).toHaveBeenCalledWith('srv1', expect.any(Function));
    expect(api.pairSession).toHaveBeenCalledWith('alvo', ['origem'], 'PM-1', false);
    // Sucesso sem warning fecha o diálogo (o pedido volta a null).
    expect(arrastarGrupo.pedido).toBeNull();
    unmount(comp);
  });

  it('grupo com 5 membros lista os 5 (união de origem, alvo e os pares de cada um)', async () => {
    storeState.rows = [
      sess({ name: 'origem', serverId: 'srv1', pair_peers: null }),
      sess({ name: 'alvo', serverId: 'srv1', pair_peers: ['p1', 'p2', 'p3'] }),
    ];
    api.pairSession.mockResolvedValue({ ok: true, warning: null });
    const comp = montar();

    arrastarGrupo.comecar({ serverId: 'srv1', name: 'origem' });
    arrastarGrupo.soltar('srv1::alvo');
    await tick();

    const nomes = [...document.querySelectorAll('.gd-lista li')].map((li) => li.textContent);
    expect(nomes.sort()).toEqual(['alvo', 'origem', 'p1', 'p2', 'p3'].sort());
    unmount(comp);
  });

  it('409 mostra "Substituir a tarefa" e a segunda chamada leva replaceTask = true', async () => {
    storeState.rows = [
      sess({ name: 'origem', serverId: 'srv1' }),
      sess({ name: 'alvo', serverId: 'srv1' }),
    ];
    api.pairSession.mockRejectedValueOnce(
      Object.assign(new Error('o grupo já tem tarefa: PM-9'), { status: 409 }),
    );
    api.pairSession.mockResolvedValueOnce({ ok: true, warning: null });
    const comp = montar();

    arrastarGrupo.comecar({ serverId: 'srv1', name: 'origem' });
    arrastarGrupo.soltar('srv1::alvo');
    await tick();

    digitar('PM-1');
    await tick();
    clicarBotao(m.grupo_drop_confirmar());
    await flush();

    expect(document.body.textContent).toContain('o grupo já tem tarefa: PM-9');
    clicarBotao(m.grupo_drop_substituir_tarefa());
    await flush();

    expect(api.pairSession).toHaveBeenNthCalledWith(2, 'alvo', ['origem'], 'PM-1', true);
    expect(arrastarGrupo.pedido).toBeNull();
    unmount(comp);
  });
});

describe('GrupoDropDialog — modo sair', () => {
  it('confirmar chama unpairSession com o serverId da origem', async () => {
    storeState.rows = [sess({ name: 'eu', serverId: 'srv2', pair_peers: ['outra'] })];
    api.unpairSession.mockResolvedValue({ ok: true, warning: null });
    const comp = montar();

    arrastarGrupo.pedirSaida({ serverId: 'srv2', name: 'eu' });
    await tick();

    const nomes = [...document.querySelectorAll('.gd-lista li')].map((li) => li.textContent);
    expect(nomes).toEqual(['outra']);

    clicarBotao(m.grupo_drop_sair_confirmar());
    await flush();

    expect(withServer).toHaveBeenCalledWith('srv2', expect.any(Function));
    expect(api.unpairSession).toHaveBeenCalledWith('eu');
    expect(arrastarGrupo.pedido).toBeNull();
    unmount(comp);
  });
});
