import { describe, expect, it } from 'vitest';
import type { AggSession } from '@hangar/core';
import { outsideRow } from './groupPairs';

const row = (name: string, extra: Partial<AggSession> = {}) => ({ name, state: 'idle', serverId: 's1', serverLabel: 'casa', serverColor: '#000', ...extra }) as AggSession;

describe('outsideRow', () => {
  it('acha a linha de fora de um membro alias::sessao', () => {
    const fora = row('web', { serverId: 'p_1', outside: { alias: 'ana', owner: 'Ana', localServerId: 's1', localSession: 'api' } });
    expect(outsideRow([row('api'), fora], 'ana::web')).toBe(fora);
    expect(outsideRow([row('api'), fora], 'docs')).toBeNull();
  });
});
