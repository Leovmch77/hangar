import { describe, it, expect, beforeAll } from 'vitest';
import { overwriteGetLocale } from '../paraglide/runtime';
import { composerStatus, linhaStats, settingsLabel, spacedModel, usageWindows } from './usage';

// O baseLocale do projeto é `en`; os rótulos esperados aqui são os de pt-BR.
beforeAll(() => overwriteGetLocale(() => 'pt'));

describe('linhaStats', () => {
  it('monta as partes na ordem da PWA e omite o que não veio', () => {
    expect(linhaStats({ turns: 1, steps: 3, in_tok: 1200, out_tok: 300 })).toEqual(['1 turno', '3 chamadas', '↓ 1.2K · ↑ 300 tok']);
    expect(linhaStats({ turns: 2, steps: 1, in_tok: 0, out_tok: 0, tok_s: 41.6, cache_pct: 80 })).toContain('~42 tok/s');
    expect(linhaStats({ turns: 2, steps: 1, in_tok: 0, out_tok: 0, cache_pct: 80 })).toContain('cache 80%');
  });
});

describe('usageWindows', () => {
  it('só lista as janelas que vieram, na ordem 5h, 7d, 30d', () => {
    expect(usageWindows(null)).toEqual([]);
    expect(usageWindows({ raw: '', weeklyPct: 74, fiveHourPct: 23, fiveHourReset: '1h55m' }).map((w) => [w.key, w.pct, w.reset]))
      .toEqual([['5h', 23, '1h55m'], ['7d', 74, undefined]]);
  });
});

describe('settingsLabel', () => {
  it('junta modelo e nível; sem modelo usa o nome do campo', () => {
    expect(settingsLabel('Opus5.5·1M', 'high')).toBe('Opus 5.5 · 1M · high');
    expect(settingsLabel('Haiku', null)).toBe('Haiku');
    expect(settingsLabel(null, 'high')).toBe('Modelo');
  });
});

describe('spacedModel', () => {
  it('separa nome, versão e janela sem mexer em nome com hífen', () => {
    expect(spacedModel('Opus5.5·1M')).toBe('Opus 5.5 · 1M');
    expect(spacedModel('Haiku4.5')).toBe('Haiku 4.5');
    expect(spacedModel('gpt-5.1-codex')).toBe('gpt-5.1-codex');
    expect(spacedModel('o3')).toBe('o3');
  });
});

describe('composerStatus', () => {
  it('junta statusline e lista: pasta e branch caem para a sessão, diff zerado some', () => {
    expect(composerStatus(null, null)).toEqual({});
    const s = composerStatus(
      { raw: '', ctxPct: 31, costUsd: 1.5, sessionTime: '1h00', fiveHourPct: 23, weeklyPct: 74 },
      { cwd: '/home/u/hangar', branch: 'fix/mobile', git_added: 256, git_removed: 0 },
    );
    expect(s).toMatchObject({ folder: 'hangar', branch: 'fix/mobile', added: 256, time: '1h00', ctxPct: 31, cost: '$1.50' });
    expect(s.removed).toBeUndefined();
    expect(s.quota?.key).toBe('5h');
  });

  it('a statusline vence a lista para pasta e branch', () => {
    expect(composerStatus({ raw: '', repo: 'outro', branch: 'main' }, { cwd: '/x/hangar', branch: 'dev' }))
      .toMatchObject({ folder: 'outro', branch: 'main' });
  });
});
