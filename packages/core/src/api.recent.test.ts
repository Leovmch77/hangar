import { describe, expect, it } from 'vitest';
import { buildCreateSessionBody, uniqueSessionName } from './api';

describe('uniqueSessionName', () => {
  it('sanitiza como o backend e desempata com -2', () => {
    expect(uniqueSessionName('Área de trabalho', new Set())).toBe('Area-de-trabalho');
    expect(uniqueSessionName('hangar', new Set(['hangar', 'hangar-2']))).toBe('hangar-3');
    expect(uniqueSessionName('***', new Set())).toBe('sessao');
  });
});

describe('buildCreateSessionBody branch', () => {
  it('repassa a branch só quando preenchida', () => {
    expect(buildCreateSessionBody({ name: 'a', branch: 'dev' }).branch).toBe('dev');
    expect('branch' in buildCreateSessionBody({ name: 'a', branch: '' })).toBe(false);
    expect('branch' in buildCreateSessionBody({ name: 'a', branch: null })).toBe(false);
  });
});
