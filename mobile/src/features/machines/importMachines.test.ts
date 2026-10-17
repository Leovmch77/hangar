import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureApi, _resetRotasForTests, decidirRota, baseOf, type Server } from '@hangar/core';
import { hmacSha256Hex } from '../../../../packages/core/src/hmac';
import { importMachines, discoverSavedMachines } from './importMachines';
import { useServers } from '../../stores/servers';

const mocks = vi.hoisted(() => ({ vault: new Map<string, string>(), fetch: vi.fn(), warning: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mocks.vault.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.vault.set(key, value); },
}));
vi.mock('sonner-native', () => ({ toast: mocks.warning, Toaster: () => null }));

const owner: Server = { id: 'local-owner', label: 'fixture-owner', baseUrl: 'https://owner.test', token: 'owner-secret' };
const other: Server = { id: 'local-other', label: 'fixture-other', baseUrl: 'https://other.test', token: 'other-secret' };
const remote: Server = { id: 'remote', label: 'fixture-remote', baseUrl: 'https://remote.test', token: 'remote-secret%25' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const paths = () => mocks.fetch.mock.calls.map(([url]) => String(url));
const stored = () => JSON.parse(mocks.vault.get('cp_servers_v1')!);
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const settle = () => new Promise<void>((r) => setImmediate(r));

beforeEach(async () => {
  mocks.vault.clear(); mocks.fetch.mockReset(); mocks.warning.mockClear(); _resetRotasForTests();
  mocks.vault.set('cp_servers_v1', JSON.stringify({ servers: [owner, other], activeId: other.id }));
  useServers.setState({ servers: [], activeId: null });
  await useServers.getState().load();
  configureApi({ getBaseUrl: () => 'https://wrong-active.test', getToken: () => 'wrong-token', origin: null,
    onUnauthorized: () => { throw new Error('unexpected_active_reset'); }, createEventSource: () => { throw new Error('unexpected_stream'); } });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(async () => { await useServers.getState().load(); vi.unstubAllGlobals(); _resetRotasForTests(); });

function network(extra: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const value = extra(url, init);
    if (value !== undefined) return value;
    if (url.endsWith('/api/peers')) return json([]);
    if (url.endsWith('/api/peers/app-list')) return json({ rev: 'r1', servers: [] });
    if (url.endsWith('/api/sessions')) return json([]);
    if (url.endsWith('/api/peers/identificador')) return json({ identificador: url.startsWith(owner.baseUrl) ? 'owner-machine' : url.startsWith(other.baseUrl) ? 'other-machine' : 'real-machine', lan_url: '' });
    return json({}, 404);
  });
}

describe('política de redirecionamento da candidata', () => {
  test.each(['/api/sessions', '/api/peers/identificador'])('fetch recusando redirect em %s retorna falha sem guardar candidata', async (path) => {
    network((url, init) => {
      if (url === `${owner.baseUrl}/api/peers`) return json([{ id: remote.id, base_url: remote.baseUrl, token: '••••mask' }]);
      if (url === `${owner.baseUrl}/api/peers/remote/token`) return json({ token: remote.token });
      if (url === `${remote.baseUrl}${path}` && init.redirect === 'error') throw new TypeError('fixture-redirect-refused');
      return undefined;
    });
    const result = await discoverSavedMachines([owner]);
    await settle();
    expect(result.added).toEqual([]);
    expect(result.issues).toEqual([{ stage: 'candidate', machine: 'remote.test' }]);
    expect(useServers.getState().servers.some((s) => s.baseUrl === remote.baseUrl)).toBe(false);
    expect(stored().servers.some((s: Server) => s.baseUrl === remote.baseUrl)).toBe(false);
    expect(useServers.getState().activeId).toBe(other.id);
    for (const [url, init] of mocks.fetch.mock.calls) {
      if (String(url).startsWith(remote.baseUrl)) expect(init.redirect).toBe('error');
      else expect(init).not.toHaveProperty('redirect');
    }
    expect(paths()).toContain(`${owner.baseUrl}/api/peers/identificador`);
    expect(paths()).toContain(`${owner.baseUrl}/api/peers/remote/token`);
  });
});

describe('identidades confirmadas das máquinas', () => {
  test.each([
    { host: 'owner-empty.test', identifier: '' },
    { host: 'owner-blank.test', identifier: '   ' },
  ])('identificador salvo vazio preserva lan e impede alias duplicado: $host', async ({ host, identifier }) => {
    const learned = { ...owner, baseUrl: `https://${host}`, label: 'fixture-custom-owner',
      lan: { id: 'owner-machine', url: 'http://192.168.0.5:8765' } };
    useServers.setState({ servers: [learned, other], activeId: other.id });
    network((url) => {
      if (url === `${learned.baseUrl}/api/peers/app-list`) return json({ rev: 'r1', servers: [
        { id: 'owner-alias', label: 'fixture-alias', address: 'https://owner-alias.test', token: 'alias-token', disabled: false, invite: false },
      ] });
      if (url === `${learned.baseUrl}/api/peers/identificador`) return json({ identificador: identifier, lan_url: '' });
      if (url === 'https://owner-alias.test/api/peers/identificador') return json({ identificador: 'owner-machine', lan_url: '' });
      return undefined;
    });
    const result = await discoverSavedMachines([learned]);
    await useServers.getState().load();
    expect(result.added).toEqual([]);
    expect(result.issues).toEqual([{ stage: 'saved_identity', machine: host }]);
    expect(useServers.getState().servers[0]).toEqual(learned);
    expect(stored().servers[0].lan).toEqual({ id: 'owner-machine', url: 'http://192.168.0.5:8765' });
    expect(useServers.getState().servers).toHaveLength(2);
    expect(useServers.getState().activeId).toBe(other.id);
    expect(JSON.stringify(mocks.warning.mock.calls)).toContain(host);
    expect(JSON.stringify(mocks.warning.mock.calls)).not.toContain(owner.token);
  });
  test('origem retornando por alias é identificada antes da candidata e sobrevive a nova hidratação sem duplicar', async () => {
    const original = { ...owner, label: 'fixture-custom-owner', disabled: true };
    useServers.setState({ servers: [original, other], activeId: other.id });
    network((url) => url === `${owner.baseUrl}/api/peers/identificador` || url === 'https://owner-alias.test/api/peers/identificador'
      ? json({ identificador: 'owner-machine', lan_url: 'http://192.168.0.5:8765' }) : undefined);
    const alias = { ...remote, baseUrl: 'https://owner-alias.test', label: 'fixture-alias' };
    const first = await importMachines([alias]);
    expect(first.added).toEqual([]);
    expect(first.issues).toEqual([]);
    expect(useServers.getState().servers).toHaveLength(2);
    expect(useServers.getState().servers[0]).toEqual({ ...original, lan: { id: 'owner-machine', url: 'http://192.168.0.5:8765' } });
    expect(useServers.getState().activeId).toBe(other.id);
    expect(paths()).toContain(`${owner.baseUrl}/api/peers/identificador`);
    expect(paths()).not.toContain(`${owner.baseUrl}/api/sessions`);
    useServers.setState({ servers: [], activeId: null, vaultReadable: false });
    await useServers.getState().load();
    expect(useServers.getState().servers[0].lan?.id).toBe('owner-machine');
    expect((await importMachines([alias])).added).toEqual([]);
    expect(useServers.getState().servers).toHaveLength(2);
    expect(stored().servers).toHaveLength(2);
  });

  test('duas candidatas alias na mesma rodada só salvam uma identidade, com lan confirmado e não alegado', async () => {
    network(() => undefined);
    const result = await importMachines([remote, { ...remote, id: 'alias', baseUrl: 'https://remote-alias.test',
      lan: { id: 'claimed-owner', url: 'https://claimed.test' } }]);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toEqual({ ...remote, label: 'real-machine', lan: { id: 'real-machine', url: '' } });
    expect(useServers.getState().servers).toHaveLength(3);
  });

  test('duas importações concorrentes de aliases revalidam a identidade depois da rede', async () => {
    const pending = deferred<Response>();
    network((url) => url.startsWith('https://remote') && url.endsWith('/identificador') ? pending.promise : undefined);
    const first = importMachines([remote]);
    const second = importMachines([{ ...remote, id: 'alias', baseUrl: 'https://remote-alias.test' }]);
    await settle();
    pending.resolve(json({ identificador: 'real-machine', lan_url: '' }));
    const results = await Promise.all([first, second]);
    expect(results.flatMap((result) => result.added)).toHaveLength(1);
    expect(useServers.getState().servers.filter((s) => s.lan?.id === 'real-machine')).toHaveLength(1);
    expect(useServers.getState().activeId).toBe(other.id);
  });

  test('identidade vazia não junta candidatas de endereços diferentes', async () => {
    network((url) => url.startsWith('https://remote') && url.endsWith('/identificador') ? json({ identificador: '', lan_url: '' }) : undefined);
    const result = await importMachines([remote, { ...remote, id: 'second', baseUrl: 'https://remote-other.test' }]);
    expect(result.added).toHaveLength(2);
    expect(result.added.map((s) => s.lan)).toEqual([{ id: '', url: '' }, { id: '', url: '' }]);
  });

  test('fonte offline conserva identidade aprendida, avisa e ainda importa outra candidata', async () => {
    const learned = { ...owner, label: 'fixture-custom-owner', lan: { id: 'owner-machine', url: 'http://192.168.0.5:8765' } };
    useServers.setState({ servers: [learned, other], activeId: other.id });
    network((url) => {
      if (url === `${owner.baseUrl}/api/peers/identificador`) return json({ detail: 'never-show-secret' }, 503);
      if (url === 'https://owner-alias.test/api/peers/identificador') return json({ identificador: 'owner-machine', lan_url: '' });
      return undefined;
    });
    const result = await importMachines([{ ...remote, id: 'owner-alias', baseUrl: 'https://owner-alias.test' }, remote]);
    expect(result.added.map((s) => s.baseUrl)).toEqual([remote.baseUrl]);
    expect(result.issues).toContainEqual({ stage: 'saved_identity', status: 503, machine: 'owner.test' });
    expect(useServers.getState().servers[0]).toEqual(learned);
    expect(useServers.getState().activeId).toBe(other.id);
  });

  test.each(['baseUrl', 'token'] as const)('resposta antiga da identidade não atualiza cadastro cujo %s mudou', async (field) => {
    const pending = deferred<Response>();
    network((url) => url === `${owner.baseUrl}/api/peers/identificador` ? pending.promise : undefined);
    const importing = importMachines([remote]); await settle();
    if (field === 'baseUrl') useServers.getState().update(owner.id, { baseUrl: 'https://owner-changed.test' });
    else useServers.getState().add({ ...owner, token: 'fixture-new-token' });
    const changed = useServers.getState().servers.find((s) => s.id === owner.id)!;
    pending.resolve(json({ identificador: 'stale-owner', lan_url: 'http://192.168.0.9:8765' }));
    await importing;
    expect(useServers.getState().servers.find((s) => s.id === owner.id)).toEqual(changed);
    expect(useServers.getState().servers.find((s) => s.id === owner.id)?.lan).toBeUndefined();
  });

  test('avisos automáticos iguais aparecem uma vez sem retirar issues, e outra máquina ou status avisa', async () => {
    let status = 502;
    network((url) => url.endsWith('/api/peers') ? json({ detail: 'never-show-secret' }, status) : undefined);
    const first = await discoverSavedMachines([owner]);
    const second = await discoverSavedMachines([owner]);
    expect(first.issues).toEqual([{ stage: 'source_peers', status: 502, machine: 'owner.test' }]);
    expect(second.issues).toEqual(first.issues);
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    await discoverSavedMachines([other]);
    expect(mocks.warning).toHaveBeenCalledTimes(2);
    status = 504;
    await discoverSavedMachines([owner]);
    expect(mocks.warning).toHaveBeenCalledTimes(3);
  });
});

describe('descoberta autenticada só acrescenta', () => {
  test('busca automática avisa brevemente em canal separado sem perder detalhes da falha', async () => {
    const source = { ...owner, baseUrl: 'https://automatic-warning.test' };
    network((url) => url === `${source.baseUrl}/api/peers` ? json({}, 503) : undefined);

    const result = await discoverSavedMachines([source]);

    expect(result.issues).toEqual([{ stage: 'source_peers', status: 503, machine: 'automatic-warning.test' }]);
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    const [message, options] = mocks.warning.mock.calls[0];
    expect(message).toContain('automatic-warning.test');
    expect(options.duration).toBeLessThanOrEqual(3_500);
    expect(options.toasterId).toBe('passive');
  });

  test.each(['source', 'peer', 'candidate'] as const)('identifica duas falhas 403 distintas no aviso de %s sem corpo, caminho ou token', async (kind) => {
    network((url) => {
      if (kind === 'source' && url.endsWith('/api/peers')) return json({ detail: `leaked:${owner.token}:${remote.token}` }, 403);
      if (kind === 'peer' && url === `${owner.baseUrl}/api/peers`) return json([
        { id: 'one', base_url: 'https://one.test/private-path', token: '••••mask' },
        { id: 'two', base_url: 'https://two.test/private-path', token: '••••mask' },
      ]);
      if (kind === 'peer' && url.endsWith('/token')) return json({ detail: `leaked:${owner.token}` }, 403);
      if (kind === 'candidate' && url === `${owner.baseUrl}/api/peers/app-list`) return json({ rev: 'r1', servers: [
        { id: 'one', label: 'fixture-one', address: 'https://one.test/private-path', token: 'one-secret', disabled: false, invite: false },
        { id: 'two', label: 'fixture-two', address: 'https://two.test/private-path', token: 'two-secret', disabled: false, invite: false },
      ] });
      if (kind === 'candidate' && (url.startsWith('https://one.test') || url.startsWith('https://two.test'))) return json({ detail: 'leaked:one-secret:two-secret' }, 403);
      return undefined;
    });
    const result = await discoverSavedMachines(kind === 'source' ? [owner, other] : [owner]);
    const expected = kind === 'source' ? ['owner.test', 'other.test'] : ['one.test', 'two.test'];
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(expect.arrayContaining(expected.map((machine) => ({
      stage: kind === 'source' ? 'source_peers' : kind === 'peer' ? 'peer_token' : 'candidate',
      status: 403, machine, ...(kind === 'peer' ? { source: 'owner.test' } : {}),
    }))));
    const warning = JSON.stringify(mocks.warning.mock.calls);
    for (const machine of expected) expect(warning).toContain(machine);
    if (kind === 'peer') expect(warning).toContain('owner.test');
    expect(warning).not.toContain('private-path'); expect(warning).not.toContain('secret'); expect(warning).not.toContain('leaked');
  });
  test('tenta o token do peer quando app-list trouxe uma credencial antiga da mesma máquina', async () => {
    network((url, init) => {
      if (url === `${owner.baseUrl}/api/peers/app-list`) return json({ rev: 'r1', servers: [
        { id: remote.id, label: remote.label, address: remote.baseUrl, token: 'expired-token', disabled: false, invite: false },
      ] });
      if (url === `${owner.baseUrl}/api/peers`) return json([{ id: remote.id, base_url: remote.baseUrl, token: '••••mask' }]);
      if (url === `${owner.baseUrl}/api/peers/remote/token`) return json({ token: remote.token });
      if (url.startsWith(remote.baseUrl) && new Headers(init.headers).get('Authorization') === 'Bearer expired-token') return json({}, 401);
      return undefined;
    });
    const result = await discoverSavedMachines([owner]);
    expect(result.added).toEqual([{ ...remote, label: 'real-machine', lan: { id: 'real-machine', url: '' } }]);
    expect(useServers.getState().servers.filter((s) => s.baseUrl === remote.baseUrl)).toHaveLength(1);
    expect(result.issues).toContainEqual({ stage: 'candidate', status: 401, machine: 'remote.test' });
    expect(mocks.warning).toHaveBeenCalled();
  });

  test('duas fontes com tokens diferentes para a mesma máquina não perdem a credencial válida', async () => {
    network((url, init) => {
      if (url.endsWith('/api/peers/app-list')) return json({ rev: 'r1', servers: [
        { id: remote.id, label: remote.label, address: remote.baseUrl,
          token: url.startsWith(owner.baseUrl) ? 'expired-token' : remote.token, disabled: false, invite: false },
      ] });
      if (url.startsWith(remote.baseUrl) && new Headers(init.headers).get('Authorization') === 'Bearer expired-token') return json({}, 401);
      return undefined;
    });
    const result = await discoverSavedMachines();
    expect(result.added).toHaveLength(1);
    expect(result.added[0].token).toBe(remote.token);
    expect(useServers.getState().servers.filter((s) => s.baseUrl === remote.baseUrl)).toHaveLength(1);
  });
  test('consulta cada fonte própria, busca token individual, ignora máscara/disabled e confirma nome antes de salvar', async () => {
    const guest = { ...owner, id: 'guest', baseUrl: 'https://guest.test', invite: true };
    useServers.setState({ servers: [owner, other, guest, { ...guest, id: 'temporary', invite: false, ephemeral: true },
      { ...guest, id: 'removed', invite: false, removed: true }], activeId: other.id });
    const pending = deferred<Response>();
    network((url, init) => {
      const auth = new Headers(init.headers).get('Authorization');
      if (url.startsWith(owner.baseUrl)) expect(auth).toBe('Bearer owner-secret');
      if (url.startsWith(other.baseUrl)) expect(auth).toBe('Bearer other-secret');
      if (url === `${owner.baseUrl}/api/peers`) return json([
        { id: remote.id, base_url: remote.baseUrl, token: '••••mask' },
        { id: 'off', base_url: 'https://off.test', enabled: false, token: '••••mask' },
        { id: 'known', base_url: `${other.baseUrl}/`, token: '••••mask' },
        { id: 'loopback', base_url: 'http://127.0.0.1', token: '••••mask' },
      ]);
      if (url === `${owner.baseUrl}/api/peers/remote/token`) return json({ token: remote.token });
      if (url.startsWith(remote.baseUrl)) {
        expect(auth).toBe('Bearer remote-secret%25');
        expect(useServers.getState().servers.some((s) => s.baseUrl === remote.baseUrl)).toBe(false);
        if (url.endsWith('/identificador')) return pending.promise;
      }
      return undefined;
    });
    const importing = discoverSavedMachines();
    await settle();
    expect(paths()).toContain(`${owner.baseUrl}/api/peers/remote/token`);
    expect(paths()).toContain(`${remote.baseUrl}/api/sessions`);
    expect(useServers.getState().servers.some((s) => s.baseUrl === remote.baseUrl)).toBe(false);
    pending.resolve(json({ identificador: 'returned-name', lan_url: '' }));
    const result = await importing; await settle();
    expect(result.added).toEqual([{ ...remote, label: 'returned-name', lan: { id: 'returned-name', url: '' } }]);
    expect(result.issues).toEqual([]);
    expect(stored().servers).toContainEqual({ ...remote, label: 'returned-name', lan: { id: 'returned-name', url: '' } });
    expect(useServers.getState().activeId).toBe(other.id);
    expect(paths()).toContain(`${other.baseUrl}/api/peers`);
    expect(paths()).toContain(`${other.baseUrl}/api/peers/app-list`);
    expect(paths().filter((url) => url.endsWith('/token'))).toEqual([`${owner.baseUrl}/api/peers/remote/token`]);
    expect(paths().some((url) => url.startsWith('https://guest.test') || url.startsWith('https://off.test'))).toBe(false);
    expect(paths().filter((url) => url === `${remote.baseUrl}/api/peers`)).toEqual([]);
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  test('app-list usa address/token completos; convidado/loopback/entrada inválida não escondem a válida', async () => {
    network((url) => url === `${owner.baseUrl}/api/peers/app-list` ? json({ rev: 'r1', servers: [
      { id: 'guest', label: 'fixture-guest', address: 'https://guest.test', token: 'guest', disabled: false, invite: true },
      { id: 'local', label: 'fixture-local', address: 'http://[::1]', token: 'local', disabled: false, invite: false },
      { id: 'bad', label: 'fixture-bad', address: 'ftp://bad.test', token: 'bad', disabled: false, invite: false },
      { id: remote.id, label: remote.label, address: remote.baseUrl, token: remote.token, disabled: true, invite: false,
        lan: { url: 'http://192.168.0.8:8765', id: remote.id } },
    ] }) : undefined);
    const result = await discoverSavedMachines([owner]);
    expect(result.added).toEqual([{ ...remote, label: 'real-machine', disabled: true, lan: { id: 'real-machine', url: '' } }]);
    expect(result.issues).toContainEqual({ stage: 'invalid_item', machine: 'owner.test' });
    expect(paths().some((url) => url.includes('/token') || url.startsWith('https://guest.test') || url.startsWith('http://[::1]'))).toBe(false);
    expect(mocks.warning).toHaveBeenCalled();
  });

  test('falhas independentes de fonte, token e candidata continuam e avisam sem expor corpo/credencial', async () => {
    network((url) => {
      if (url === `${owner.baseUrl}/api/peers`) return json({ detail: `leaked ${owner.token}` }, 503);
      if (url === `${owner.baseUrl}/api/peers/app-list`) return json({ rev: 'r1', servers: [
        { id: 'bad', label: 'fixture-bad', address: 'https://bad.test', token: 'bad-secret', disabled: false, invite: false },
      ] });
      if (url === `${other.baseUrl}/api/peers`) return json([
        { id: remote.id, base_url: remote.baseUrl, token: '••••mask' },
        { id: 'missing', base_url: 'https://missing.test', token: '••••mask' },
      ]);
      if (url === `${other.baseUrl}/api/peers/remote/token`) return json({ token: remote.token });
      if (url === `${other.baseUrl}/api/peers/missing/token`) return json({ detail: 'leaked token' }, 403);
      if (url === 'https://bad.test/api/sessions') return json({ detail: 'bad-secret' }, 401);
      return undefined;
    });
    const result = await discoverSavedMachines();
    expect(result.added).toEqual([{ ...remote, label: 'real-machine', lan: { id: 'real-machine', url: '' } }]);
    expect(result.issues).toEqual(expect.arrayContaining([
      { stage: 'source_peers', status: 503, machine: 'owner.test' },
      { stage: 'peer_token', status: 403, machine: 'missing.test', source: 'other.test' },
      { stage: 'candidate', status: 401, machine: 'bad.test' },
    ]));
    expect(useServers.getState().servers).toHaveLength(3);
    expect(useServers.getState().activeId).toBe(other.id);
    const warnings = JSON.stringify(mocks.warning.mock.calls);
    expect(warnings).not.toContain('secret'); expect(warnings).not.toContain('leaked');
    expect(mocks.warning).toHaveBeenCalled();
  });

  test('lista vazia é somente leitura e nunca apaga nenhuma máquina', async () => {
    network(() => undefined);
    await discoverSavedMachines();
    expect(useServers.getState().servers).toEqual([owner, other]);
    expect(stored()).toEqual({ servers: [owner, other], activeId: other.id });
  });

  test('fonte explícita usa a rota local já confirmada, sem consultar ativo global', async () => {
    const routed = { ...owner, lan: { url: 'http://192.168.0.5:8765', id: 'home' } };
    const principal = deferred<Response>();
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.startsWith(owner.baseUrl)) return principal.promise;
      const challenge = new URL(url).searchParams.get('desafio');
      return json({ identificador: 'home', prova: hmacSha256Hex(owner.token, `${challenge}|home`) });
    });
    await decidirRota(routed); principal.resolve(json({ identificador: 'home', lan_url: routed.lan.url }));
    expect(baseOf(routed)).toBe(routed.lan.url);
    mocks.fetch.mockClear(); network(() => undefined);
    await discoverSavedMachines([routed]);
    expect(paths().sort()).toEqual([`${routed.lan.url}/api/peers`, `${routed.lan.url}/api/peers/app-list`].sort());
  });
});

describe('confirmação reutilizada pelo link', () => {
  test('ID remoto reservado não ocupa a rota temporária nem manda próximo token para a máquina anterior', async () => {
    network(() => undefined);
    const imported = await importMachines([{ ...remote, id: 'candidato' }]);
    await decidirRota(imported.added[0]);
    mocks.fetch.mockClear();
    await importMachines([{ ...remote, id: 'next', baseUrl: 'https://next.test', token: 'next-token' }]);
    expect(imported.added[0].id).not.toBe('candidato');
    expect(paths().filter((url) => url.startsWith('https://next.test'))).toEqual(['https://next.test/api/sessions', 'https://next.test/api/peers/identificador']);
    expect(mocks.fetch.mock.calls.filter(([, init]) => new Headers(init.headers).get('Authorization') === 'Bearer next-token')
      .every(([url]) => String(url).startsWith('https://next.test/'))).toBe(true);
  });
  test('sem ativa escolhe a primeira nova da lista, mesmo quando outra confirma antes', async () => {
    useServers.setState({ servers: [], activeId: null });
    const pending = deferred<Response>();
    network((url) => url === `${remote.baseUrl}/api/peers/identificador` ? pending.promise : undefined);
    const importing = importMachines([remote, other]);
    await settle();
    pending.resolve(json({ identificador: 'first-machine', lan_url: '' }));
    await importing;
    expect(useServers.getState().active()?.baseUrl).toBe(remote.baseUrl);
    expect(useServers.getState().servers.map((s) => s.baseUrl)).toEqual([remote.baseUrl, other.baseUrl]);
  });
  test('duas importações em voo e cadastro concorrente não sobrescrevem nada e não duplicam IDs', async () => {
    const pending = deferred<Response>();
    network((url) => url === `${remote.baseUrl}/api/peers/identificador` ? pending.promise : undefined);
    const first = importMachines([remote]); const second = importMachines([remote]);
    await settle();
    const concurrent = useServers.getState().add({ ...remote, label: 'fixture-manual', token: 'manual-token' });
    useServers.getState().setActive(other.id);
    pending.resolve(json({ identificador: 'remote-name', lan_url: '' }));
    const results = await Promise.all([first, second]);
    expect(results.flatMap((r) => r.added)).toEqual([]);
    expect(useServers.getState().servers).toEqual([
      { ...owner, lan: { id: 'owner-machine', url: '' } },
      { ...other, lan: { id: 'other-machine', url: '' } }, concurrent,
    ]);
    expect(useServers.getState().activeId).toBe(other.id);
  });

  test('já salva só consulta identidade sem receber novo token, e válida entra apesar de falha de outra candidata', async () => {
    network((url) => url === 'https://bad.test/api/sessions' ? json({}, 401) : undefined);
    const result = await importMachines([{ ...owner, token: 'overwrite', label: 'overwrite', disabled: true }, remote,
      { ...remote, id: 'bad', baseUrl: 'https://bad.test' },
    ]);
    expect(result.added).toEqual([{ ...remote, label: 'real-machine', lan: { id: 'real-machine', url: '' } }]);
    expect(result.issues).toEqual([{ stage: 'candidate', status: 401, machine: 'bad.test' }]);
    expect(useServers.getState().servers[0]).toEqual({ ...owner, lan: { id: 'owner-machine', url: '' } });
    expect(paths().filter((url) => url.startsWith(owner.baseUrl))).toEqual([`${owner.baseUrl}/api/peers/identificador`]);
  });

  test('aguarda hidratação antes de decidir se a máquina já existe', async () => {
    useServers.setState({ ready: false, vaultReadable: false, servers: [], activeId: null });
    network(() => undefined);
    const result = await importMachines([{ ...owner, token: 'overwrite' }]);
    expect(result.added).toEqual([]);
    expect(useServers.getState().servers).toEqual([owner, other]);
    expect(paths()).toEqual([]);
  });
});
