import { describe, expect, it } from 'vitest';
import type { AggSession } from '@hangar/core';
import { fullPairs, outsideRow } from './groupPairs';

const par = (owner: string, level: 'full' | 'view') => ({ alias: owner.toLowerCase(), owner, session: 'web', address: 'https://x.ts.net:8443', level, pending: false });
const row = (name: string, extra: Partial<AggSession> = {}) => ({ name, state: 'idle', serverId: 's1', serverLabel: 'casa', serverColor: '#000', ...extra }) as AggSession;

describe('fullPairs', () => {
  it('um por par, só os de acesso completo', () => {
    const rows = [row('api', { pair_externals: [par('Ana', 'full'), par('Bia', 'view')] }), row('docs', { pair_externals: [par('Ana', 'full')] })];
    expect(fullPairs(rows).map((p) => p.owner)).toEqual(['Ana']);
  });
});

describe('outsideRow', () => {
  it('acha a linha de fora de um membro alias::sessao', () => {
    const fora = row('web', { serverId: 'p_1', outside: { alias: 'ana', owner: 'Ana', localServerId: 's1', localSession: 'api' } });
    expect(outsideRow([row('api'), fora], 'ana::web')).toBe(fora);
    expect(outsideRow([row('api'), fora], 'docs')).toBeNull();
  });
});
