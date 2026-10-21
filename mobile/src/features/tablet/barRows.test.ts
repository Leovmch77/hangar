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
    expect(barRows([parent, child], identities)).toEqual([{ kind: 'group', label: null, members: [child, parent] }]);
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
      { kind: 'group', label: 'PM-123 tela', members: [b, a] }, { kind: 'single', session: single },
    ]);
  });

  it('retira mortos sem criar grupo de um membro', () => {
    const parent = session('mae');
    expect(barRows([parent, session('filha', 'nb', { linked_by: 'mae', state: 'dead' })], identities))
      .toEqual([{ kind: 'single', session: parent }]);
  });
});
