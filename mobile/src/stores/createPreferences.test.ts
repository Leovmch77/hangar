import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from './prefs';
import { readProject, rememberProject } from './createPreferences';

const { memory } = vi.hoisted(() => ({ memory: new Map<string, string>() }));
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => memory.get(key),
    set: (key: string, value: string) => { memory.set(key, value); },
  }),
}));

describe('createPreferences', () => {
  beforeEach(() => { memory.clear(); vi.restoreAllMocks(); });

  it('retorna ausência sem avisar quando a máquina não tem preferência', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readProject('linux')).toBeNull();
    expect(warning).not.toHaveBeenCalled();
  });

  it('persiste caminhos por máquina e conserva caminhos Windows ao reabrir', async () => {
    rememberProject('linux', { root: '/projects', cwd: '/projects/hangar' });
    rememberProject('windows', { root: 'F:\\projects', cwd: 'F:\\projects\\hangar' });
    vi.resetModules();
    const reopened = await import('./createPreferences');
    expect(reopened.readProject('linux')).toEqual({ root: '/projects', cwd: '/projects/hangar' });
    expect(reopened.readProject('windows')).toEqual({ root: 'F:\\projects', cwd: 'F:\\projects\\hangar' });
    expect(reopened.readProject('other')).toBeNull();
  });

  it('grava somente root/cwd e devolve somente caminhos de conteúdo antigo', () => {
    rememberProject('linux', { root: '/projects', cwd: '/projects/hangar', token: 'secret' } as {
      root: string; cwd: string;
    });
    expect(JSON.parse(memory.get('create.project.v1:linux')!)).toEqual({
      root: '/projects', cwd: '/projects/hangar',
    });
    memory.set('create.project.v1:linux', '{"root":"/projects","cwd":"/projects/hangar","token":"secret"}');
    expect(readProject('linux')).toEqual({ root: '/projects', cwd: '/projects/hangar' });
  });

  it.each(['', '{"token":"secret"', 'null', '[]', '{}',
    '{"root":2,"cwd":"/projects"}', '{"root":"/projects","cwd":null}',
    '{"root":" ","cwd":"/projects"}', '{"root":"/projects","cwd":" "}',
  ])('trata preferência inválida como ausente com aviso sem expor conteúdo: %s', (raw) => {
    memory.set('create.project.v1:linux', raw);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readProject('linux')).toBeNull();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]).toEqual([expect.any(String)]);
    expect(warning.mock.calls[0][0]).not.toContain('secret');
  });

  it('propaga falha de gravação e mantém a preferência anterior', () => {
    rememberProject('linux', { root: '/projects', cwd: '/projects/old' });
    vi.spyOn(prefs, 'set').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    expect(() => rememberProject('linux', { root: '/projects', cwd: '/projects/new' }))
      .toThrow('storage unavailable');
    expect(readProject('linux')).toEqual({ root: '/projects', cwd: '/projects/old' });
  });

  it('recusa seleção vazia antes de sobrescrever uma preferência válida', () => {
    rememberProject('linux', { root: '/projects', cwd: '/projects/old' });
    expect(() => rememberProject('linux', { root: '/projects', cwd: ' ' })).toThrow();
    expect(readProject('linux')).toEqual({ root: '/projects', cwd: '/projects/old' });
  });

  it('propaga falha de leitura em vez de fingir preferência ausente', () => {
    vi.spyOn(prefs, 'getString').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    expect(() => readProject('linux')).toThrow('storage unavailable');
  });
});
