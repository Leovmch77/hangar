import { describe, expect, it } from 'vitest';
import type { AggSession } from '@hangar/core';
import { barRows } from './barRows';

const session = (name: string, serverId = 'nb', extra: Partial<AggSession> = {}): AggSession => ({
  name, serverId, serverLabel: serverId, serverColor: '#999', state: 'idle', last_activity: 1, ...extra,
});
const identities = new Map([['nb', 'notebook'], ['vm', 'casa']]);

describe('barRows', () => {
  it('mistura os servidores sem cabeçalhos, na ordem de estado da lista do celular', () => {
    const idle = session('pronta');
    const working = session('trabalhando', 'vm', { state: 'working' });
    const waiting = session('pergunta', 'nb', { state: 'awaiting_input' });
    expect(barRows([idle, working, waiting], identities)).toEqual([
      { kind: 'single', session: waiting }, { kind: 'single', session: working }, { kind: 'single', session: idle },
    ]);
  });

  it('junta mãe e filha ligada, mesmo sem metadados de pareamento', () => {
    const parent = session('mae');
    const child = session('filha', 'nb', { linked_by: 'mae', state: 'working' });
    expect(barRows([parent, child], identities)).toEqual([{ kind: 'group', key: 'mother:nb::mae', label: null, members: [parent, child] }]);
  });

  it('numa cadeia mantém a mãe do topo antes das filhas sem reordenar o resto', () => {
    const parent = session('mae');
    const child = session('filha', 'nb', { linked_by: 'mae', state: 'working' });
    const grandchild = session('neta', 'nb', { linked_by: 'filha', state: 'awaiting_input' });
    const [group] = barRows([child, grandchild, parent], identities);
    expect(group).toEqual({ kind: 'group', key: 'mother:nb::mae', label: null, members: [parent, grandchild, child] });
  });

  it('põe o líder da orquestração primeiro mesmo quando outro membro pede resposta', () => {
    const parent = session('lider', 'nb', { pair_gid: 'g', provider: 'orq' });
    const child = session('executor', 'nb', { pair_gid: 'g', state: 'awaiting_input' });
    expect(barRows([child, parent], identities)).toEqual([
      { kind: 'group', key: 'local:nb/g', label: null, members: [parent, child] },
    ]);
  });

  it('mantém a chave pelo gid quando o estado troca o primeiro membro da lista', () => {
    const a = session('api', 'nb', { pair_gid: 'g', state: 'working' });
    const b = session('web', 'nb', { pair_gid: 'g' });
    const before = barRows([a, b], identities)[0];
    const after = barRows([{ ...a, state: 'idle' }, { ...b, state: 'awaiting_input' }], identities)[0];
    expect(before).toMatchObject({ kind: 'group', key: 'local:nb/g', label: null });
    expect(after).toMatchObject({ kind: 'group', key: 'local:nb/g', label: null });
  });

  it('não confunde mães com o mesmo nome em máquinas diferentes', () => {
    const parent = session('mae');
    const child = session('filha', 'vm', { linked_by: 'mae', state: 'working' });
    expect(barRows([parent, child], identities)).toEqual([
      { kind: 'single', session: child }, { kind: 'single', session: parent },
    ]);
  });

  it('junta pares entre servidores na posição do primeiro membro e conserva o rótulo', () => {
    const pair = { pair_gid: 'g', pair_owner: 'notebook', pair_task: 'PM-123 tela' };
    const a = session('api', 'nb', pair);
    const b = session('web', 'vm', { ...pair, state: 'awaiting_input' });
    const single = session('solta', 'nb', { state: 'working' });
    expect(barRows([single, a, b], identities)).toEqual([
      { kind: 'group', key: 'fed:notebook/g', label: 'PM-123 tela', members: [b, a] }, { kind: 'single', session: single },
    ]);
  });

  it('retira mortos sem criar grupo de um membro', () => {
    const parent = session('mae');
    expect(barRows([parent, session('filha', 'nb', { linked_by: 'mae', state: 'dead' })], identities))
      .toEqual([{ kind: 'single', session: parent }]);
  });
});
