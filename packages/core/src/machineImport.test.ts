import { describe, expect, test } from 'vitest';
import {
  createMachineImportLink, isLocalMachineUrl, machineImportIssue, mergeImportedMachines, normalizeMachineUrl, parseMachineImportPayload,
} from './machineImport';
import type { Server } from './servers';

const machine: Server = { id: 'home', label: 'fixture-home', baseUrl: 'https://home.test', token: 'secret%25/#?+' };
const credentialUrl = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.username = 'fixture-user';
  url.password = 'fixture-password';
  return url;
};

test('contexto seguro guarda somente host validado, sem corpo, caminho, token ou URL com credencial', () => {
  const error = Object.assign(new Error('leaked:secret-token'), { status: 403 });
  expect(machineImportIssue('peer_token', error, 'https://REMOTE.test:8765/private-path', 'https://source.test/private-path'))
    .toEqual({ stage: 'peer_token', status: 403, machine: 'remote.test:8765', source: 'source.test' });
  const url = credentialUrl('https://remote.test');
  url.searchParams.set('token', 'fixture-token');
  url.hash = 'fixture-fragment';
  expect(machineImportIssue('candidate', error, url.toString()))
    .toEqual({ stage: 'candidate', status: 403 });
});

describe('payload de importação de máquinas', () => {
  test('lê JSON já decodificado, normaliza endereço e não decodifica o token outra vez', () => {
    expect(parseMachineImportPayload(JSON.stringify([{ ...machine, baseUrl: 'HTTPS://HOME.TEST:443///' }])))
      .toEqual([machine]);
  });

  test.each(['', '{', 'null', '{}', '[null]', JSON.stringify([{ ...machine, token: '' }]),
    JSON.stringify([{ ...machine, id: 3 }]), JSON.stringify([{ ...machine, label: null }]),
    JSON.stringify([{ ...machine, token: 'a b' }]), JSON.stringify([{ ...machine, token: 'x'.repeat(8193) }]),
    JSON.stringify(Array.from({ length: 101 }, () => machine)), ' '.repeat(262145),
  ])('recusa payload inválido sem reproduzir credenciais no erro', (raw) => {
    expect(() => parseMachineImportPayload(raw)).toThrow('machine_import_invalid_payload');
    try { parseMachineImportPayload(raw); } catch (error) { expect(String(error)).not.toContain(machine.token); }
  });

  test.each(['ftp://home.test', credentialUrl('https://home.test').toString(), 'https://home.test?token=fixture-token',
    'https://home.test#fixture-fragment', '//home.test', 'https://home.test?', 'https://home.test#',
  ])('recusa URL fora do contrato: %s', (baseUrl) => {
    expect(() => parseMachineImportPayload(JSON.stringify([{ ...machine, baseUrl }]))).toThrow();
  });

  test('deixa convites, temporárias, removidas e loopback fora, sem invalidar as próprias', () => {
    expect(parseMachineImportPayload(JSON.stringify([
      { ...machine, invite: true }, { ...machine, ephemeral: true }, { ...machine, removed: true },
      { ...machine, baseUrl: 'http://127.0.0.1:8765' }, machine, { ...machine, token: 'other' },
    ]))).toEqual([machine]);
  });

  test('link usa só fragmento e apenas os quatro campos públicos da transferência', () => {
    const link = createMachineImportLink([
      { ...machine, disabled: true, lan: { url: 'http://10.0.0.3', id: 'home' } },
      { ...machine, id: 'guest', invite: true }, { ...machine, ephemeral: true }, { ...machine, removed: true },
    ]);
    expect(link.startsWith('hangar://importar#')).toBe(true);
    expect(new URL(link).search).toBe('');
    expect(JSON.parse(decodeURIComponent(new URL(link).hash.slice(1)))).toEqual([machine]);
  });
});

describe('endereços de importação', () => {
  test.each(['http://localhost:8765', 'http://a.localhost.', 'http://127.3.2.1', 'http://127.1',
    'http://2130706433', 'http://0x7f000001', 'http://0.0.0.0', 'http://0', 'http://[::1]',
    'http://[0:0:0:0:0:0:0:1]', 'http://[::]', 'http://[::ffff:127.0.0.1]',
    'http://[::ffff:7f01:203]', 'http://[::ffff:0:0]', 'http://*', 'http://+', 'http://[::127.0.0.1]',
  ])('reconhece endereço desta máquina: %s', (url) => expect(isLocalMachineUrl(normalizeMachineUrl(url))).toBe(true));
  test.each(['http://192.168.0.3:8765', 'https://home.ts.net', 'http://[fd00::1]:8765'])
    ('permite máquina alcançável: %s', (url) => expect(isLocalMachineUrl(normalizeMachineUrl(url))).toBe(false));
});

describe('merge só acrescenta', () => {
  test('preserva lista, token, apelido, flags e ativa; não colide IDs locais', () => {
    const saved = { ...machine, disabled: true, lan: { url: '', id: 'home' } };
    const next = { ...machine, id: 'home', baseUrl: 'https://work.test', label: 'fixture-work', token: 'work' };
    const result = mergeImportedMachines({ servers: [saved], activeId: saved.id }, [
      { ...machine, label: 'overwrite', token: 'overwrite', baseUrl: 'https://HOME.test/' }, next, next,
    ]);
    expect(result.servers[0]).toBe(saved);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[1]).toMatchObject({ baseUrl: next.baseUrl, token: 'work' });
    expect(result.servers[1].id).not.toBe('home');
    expect(result.activeId).toBe('home');
    expect(result.added).toEqual([result.servers[1]]);
  });

  test('primeira nova vira ativa sem escolher uma entrada antiga nem substituir convidado no mesmo endereço', () => {
    const guest = { ...machine, id: 'guest', invite: true };
    const result = mergeImportedMachines({ servers: [guest], activeId: null }, [machine,
      { ...machine, id: 'work', baseUrl: 'https://work.test' },
    ]);
    expect(result.servers).toEqual([guest, { ...machine, id: 'work', baseUrl: 'https://work.test' }]);
    expect(result.activeId).toBe('work');
  });

  test('não altera a lista nem o ativo quando tudo já está salvo', () => {
    const list = [machine];
    const result = mergeImportedMachines({ servers: list, activeId: machine.id }, [machine]);
    expect(result.servers).toBe(list);
    expect(result.added).toEqual([]);
    expect(result.activeId).toBe('home');
  });
});
