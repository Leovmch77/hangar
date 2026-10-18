import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@hangar/core', async () => {
  const actual = await vi.importActual<typeof import('@hangar/core')>('@hangar/core');
  return {
    ...actual,
    listFiles: vi.fn(),
    readFile: vi.fn(),
    searchFiles: vi.fn(),
    pathDiff: vi.fn(),
    writeFile: vi.fn(),
    discardFile: vi.fn(),
  };
});

const servidores = vi.hoisted(() => ({
  lista: [] as Array<{ id: string; label: string; baseUrl: string; token: string }>,
}));
vi.mock('../../stores/servers', () => ({
  useServers: { getState: () => ({ servers: servidores.lista }) },
}));

import { filesStore, _resetFilesForTests } from './filesStore';
import * as core from '@hangar/core';

const sessao = 'sess-test';
const serverId = 'srv1';
const srv1 = { id: 'srv1', label: 'Casa', baseUrl: 'http://casa:8765', token: 't1' };
const srv2 = { id: 'srv2', label: 'Trabalho', baseUrl: 'http://trab:8765', token: 't2' };

function apis() {
  return filesStore(serverId, sessao);
}

beforeEach(() => {
  _resetFilesForTests();
  vi.clearAllMocks();
  servidores.lista = [srv2, srv1];
  // default mocks: list empty, diff empty
  vi.mocked(core.listFiles).mockResolvedValue({ entries: [], truncated: false });
  vi.mocked(core.pathDiff).mockResolvedValue({
    path: 'a.txt',
    diff: '',
    truncated: false,
    escopo_pedido: 'branch',
    escopo_usado: 'branch',
    base: null,
    motivo: null,
    original: null,
  });
});

describe('filesStore', () => {
  it('descarta resposta atrasada de abrir quando outra abertura vence', async () => {
    const readFile = vi.mocked(core.readFile);
    let resolveA!: (v: { path: string; text: string; size: number; truncated: boolean; digest: string | null }) => void;
    let resolveB!: (v: typeof resolveA extends (v: infer T) => void ? T : never) => void;
    readFile
      .mockReturnValueOnce(new Promise((r) => (resolveA = r)))
      .mockReturnValueOnce(new Promise((r) => (resolveB = r)));

    const api = apis();
    const pA = api.abrir('a.txt');
    const pB = api.abrir('b.txt');

    // resolve B primeiro (mais nova)
    resolveB({ path: 'b.txt', text: 'conteudo b', size: 10, truncated: false, digest: 'd2' });
    await pB;
    // resolve A atrasada (deve ser descartada)
    resolveA({ path: 'a.txt', text: 'conteudo a', size: 10, truncated: false, digest: 'd1' });
    await pA;

    // deve permanecer com b
    expect(api.use.getState().selecionado).toBe('b.txt');
    expect(api.use.getState().conteudo?.text).toBe('conteudo b');
  });

  it('salvar atualiza conteudo com novo digest e chama recarregarDiff', async () => {
    const readFile = vi.mocked(core.readFile);
    const pathDiffMock = vi.mocked(core.pathDiff);
    const writeFile = vi.mocked(core.writeFile);

    readFile.mockResolvedValue({ path: 'a.txt', text: 'old', size: 3, truncated: false, digest: 'd-old' } as never);
    pathDiffMock.mockResolvedValue({
      path: 'a.txt',
      diff: 'diffold',
      truncated: false,
      escopo_pedido: 'branch',
      escopo_usado: 'branch',
      base: null,
      motivo: null,
      original: null,
    } as never);

    const api = apis();
    await api.abrir('a.txt');
    expect(api.use.getState().conteudo?.digest).toBe('d-old');

    writeFile.mockResolvedValue({ path: 'a.txt', size: 3, digest: 'd-new' } as never);
    // pathDiff vai ser chamado por recarregarDiff após salvar
    pathDiffMock.mockResolvedValue({
      path: 'a.txt',
      diff: 'diffnew',
      truncated: false,
      escopo_pedido: 'branch',
      escopo_usado: 'branch',
      base: null,
      motivo: null,
      original: null,
    } as never);

    const err = await api.salvar('a.txt', 'new');
    expect(err).toBeNull();
    expect(api.use.getState().conteudo?.text).toBe('new');
    expect(api.use.getState().conteudo?.digest).toBe('d-new');
    expect(writeFile).toHaveBeenCalledWith(sessao, 'a.txt', 'new', 'd-old', srv1);
    // espera o void recarregarDiff(path) — é fire-and-forget, precisa tick
    await new Promise((r) => setTimeout(r, 20));
    expect(pathDiffMock).toHaveBeenLastCalledWith(sessao, 'a.txt', 'branch', srv1);
    expect(api.use.getState().diff?.diff).toBe('diffnew');
  });

  it('salvar retorna erro quando digest incompatível e não altera conteudo', async () => {
    const readFile = vi.mocked(core.readFile);
    readFile.mockResolvedValue({ path: 'a.txt', text: 'old', size: 3, truncated: false, digest: 'd-old' } as never);
    const api = apis();
    await api.abrir('a.txt');

    vi.mocked(core.writeFile).mockRejectedValue(new Error('409: erro_arq_mudou_no_disco'));

    const msg = await api.salvar('a.txt', 'new');
    expect(msg).toBe('erro_arq_mudou_no_disco');
    // mantém old — e o digest da leitura, que a próxima tentativa precisa mandar
    expect(api.use.getState().conteudo?.text).toBe('old');
    expect(api.use.getState().conteudo?.digest).toBe('d-old');
  });

  it('lê e grava no servidor da sessão, não no primeiro da lista', async () => {
    vi.mocked(core.readFile).mockResolvedValue({ path: 'a.txt', text: 'x', size: 1, truncated: false, digest: 'd' } as never);
    const api = apis();
    await api.abrir('a.txt');
    await api.buscar('a', 'names');
    expect(core.readFile).toHaveBeenCalledWith(sessao, 'a.txt', srv1);
    expect(core.searchFiles).toHaveBeenCalledWith(sessao, 'a', 'names', srv1);
  });

  it.each([
    { q: '', lateError: false },
    { q: ' \t ', lateError: true },
  ])('limpar busca com "$q" ignora resposta ou erro tardio (erro: $lateError)', async ({ q, lateError }) => {
    const searchFiles = vi.mocked(core.searchFiles);
    let resolve!: (value: core.SearchResult) => void;
    let reject!: (reason: Error) => void;
    searchFiles.mockReturnValueOnce(new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    }));
    const api = apis();
    const pending = api.buscar('antiga', 'names');

    await api.buscar(q, 'names');
    expect(searchFiles).toHaveBeenCalledTimes(1);
    expect(api.use.getState().resultados).toEqual([]);
    expect(api.use.getState().buscaCortada).toBe(false);

    if (lateError) reject(new Error('500: busca antiga falhou'));
    else resolve({ hits: [{ path: 'antigo.txt', line: null, text: null }], truncated: true, mode: 'names' });
    await pending;

    expect(api.use.getState().resultados).toEqual([]);
    expect(api.use.getState().buscaCortada).toBe(false);
    expect(api.use.getState().erro).toBeNull();
  });

  it('limpar busca remove resultados, corte e erro sem HTTP nem servidor disponível', async () => {
    vi.mocked(core.searchFiles).mockResolvedValueOnce({
      hits: [{ path: 'a.txt', line: null, text: null }], truncated: true, mode: 'names',
    });
    const api = apis();
    await api.buscar('a', 'names');
    expect(api.use.getState().buscaCortada).toBe(true);
    api.use.setState({ erro: 'busca falhou' });
    servidores.lista = [];

    await api.buscar('   ', 'contents');

    expect(core.searchFiles).toHaveBeenCalledTimes(1);
    expect(api.use.getState().resultados).toEqual([]);
    expect(api.use.getState().buscaCortada).toBe(false);
    expect(api.use.getState().erro).toBeNull();
  });

  it('trocar filtro limpa cache de pasta fechada e relê raiz e abertas antes de reabrir', async () => {
    const listFiles = vi.mocked(core.listFiles);
    const oldEntries: core.TreeEntry[] = [
      { name: 'old.txt', path: 'closed/old.txt', is_dir: false, size: 1, changed: 'M', add: 1, del: 0 },
    ];
    const newEntries: core.TreeEntry[] = [
      { name: 'new.txt', path: 'closed/new.txt', is_dir: false, size: 1, changed: null, add: 0, del: 0 },
    ];
    const api = apis();
    await api.listar('');
    listFiles.mockResolvedValueOnce({ entries: oldEntries, truncated: true });
    await api.alternarPasta('closed');
    await api.alternarPasta('closed');
    await api.alternarPasta('open');
    listFiles.mockClear();

    await api.setOnlyModified(false);

    expect(api.use.getState().soModificados).toBe(false);
    expect(api.use.getState().abertos).toEqual(new Set(['open']));
    expect(listFiles.mock.calls).toEqual([
      [sessao, undefined, false, srv1],
      [sessao, 'open', false, srv1],
    ]);
    expect([...api.use.getState().porPasta.keys()]).toEqual(['', 'open']);
    expect([...api.use.getState().cortePorPasta.keys()]).toEqual(['', 'open']);
    expect(api.listaCortada()).toBe(false);

    listFiles.mockResolvedValueOnce({ entries: newEntries, truncated: false });
    await api.alternarPasta('closed');

    expect(listFiles).toHaveBeenLastCalledWith(sessao, 'closed', false, srv1);
    expect(api.use.getState().porPasta.get('closed')).toEqual(newEntries);
    expect(api.use.getState().cortePorPasta.get('closed')).toBe(false);
  });

  it.each([false, true])('trocar filtro preserva raiz e pasta aberta durante reload e após falha (erro: %s)', async (fail) => {
    const listFiles = vi.mocked(core.listFiles);
    const directory: core.TreeEntry = { name: 'open', path: 'open', is_dir: true, size: 0, changed: null, add: 0, del: 0 };
    const oldFile: core.TreeEntry = { name: 'old.txt', path: 'open/old.txt', is_dir: false, size: 1, changed: 'M', add: 1, del: 0 };
    const newFile: core.TreeEntry = { name: 'new.txt', path: 'open/new.txt', is_dir: false, size: 1, changed: null, add: 0, del: 0 };
    const oldRoot = [directory, { ...oldFile, path: 'old.txt' }];
    const newRoot = [directory, { ...newFile, path: 'new.txt' }];
    listFiles.mockResolvedValueOnce({ entries: oldRoot, truncated: true })
      .mockResolvedValueOnce({ entries: [oldFile], truncated: true });
    const api = apis();
    await api.listar('');
    await api.alternarPasta('open');
    let resolveRoot!: (value: core.TreeListing) => void;
    let resolveOpen!: (value: core.TreeListing) => void;
    let rejectRoot!: (error: Error) => void;
    let rejectOpen!: (error: Error) => void;
    listFiles.mockReturnValueOnce(new Promise((done, reject) => { resolveRoot = done; rejectRoot = reject; }))
      .mockReturnValueOnce(new Promise((done, reject) => { resolveOpen = done; rejectOpen = reject; }));

    const pending = api.setOnlyModified(false);

    expect(api.use.getState().soModificados).toBe(false);
    expect(listFiles.mock.calls.slice(2)).toEqual([
      [sessao, undefined, false, srv1],
      [sessao, 'open', false, srv1],
    ]);
    expect(api.entries()).toEqual([directory, oldFile, oldRoot[1]]);
    expect(api.use.getState().porPasta.get('')).toEqual(oldRoot);
    expect(api.use.getState().porPasta.get('open')).toEqual([oldFile]);
    expect(api.use.getState().cortePorPasta).toEqual(new Map([['', true], ['open', true]]));
    expect(api.listaCortada()).toBe(true);

    if (fail) {
      rejectRoot(new Error('500: root-reload-failed'));
      rejectOpen(new Error('500: open-reload-failed'));
    } else {
      resolveRoot({ entries: newRoot, truncated: false });
      resolveOpen({ entries: [newFile], truncated: false });
    }
    await pending;

    if (fail) {
      expect(api.entries()).toEqual([directory, oldFile, oldRoot[1]]);
      expect(api.use.getState().porPasta.get('')).toEqual(oldRoot);
      expect(api.use.getState().porPasta.get('open')).toEqual([oldFile]);
      expect(api.use.getState().cortePorPasta).toEqual(new Map([['', true], ['open', true]]));
      expect(api.listaCortada()).toBe(true);
      expect(api.use.getState().erro).toBe('open-reload-failed');
    } else {
      expect(api.entries()).toEqual([directory, newFile, newRoot[1]]);
      expect(api.use.getState().porPasta.get('')).toEqual(newRoot);
      expect(api.use.getState().porPasta.get('open')).toEqual([newFile]);
      expect(api.use.getState().cortePorPasta).toEqual(new Map([['', false], ['open', false]]));
      expect(api.listaCortada()).toBe(false);
      expect(api.use.getState().erro).toBeNull();
    }
  });

  it.each(['response', 'error', '404'] as const)('trocar filtro ignora leitura antiga pendente em pasta fechada: %s', async (outcome) => {
    const listFiles = vi.mocked(core.listFiles);
    let resolve!: (value: core.TreeListing) => void;
    let reject!: (reason: Error) => void;
    listFiles.mockReturnValueOnce(new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    }));
    const api = apis();
    const pending = api.alternarPasta('closed');
    await api.alternarPasta('closed');

    await api.setOnlyModified(false);
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(listFiles).toHaveBeenLastCalledWith(sessao, undefined, false, srv1);

    if (outcome === 'response') resolve({ entries: [], truncated: true });
    else reject(Object.assign(new Error('leitura antiga falhou'), { status: outcome === '404' ? 404 : 500 }));
    await pending;

    expect(api.use.getState().porPasta.has('closed')).toBe(false);
    expect(api.use.getState().cortePorPasta.has('closed')).toBe(false);
    expect(api.use.getState().erro).toBeNull();
    await api.alternarPasta('closed');
    expect(listFiles).toHaveBeenCalledTimes(3);
    expect(listFiles).toHaveBeenLastCalledWith(sessao, 'closed', false, srv1);
    expect(api.use.getState().cortePorPasta.get('closed')).toBe(false);
  });

  it('servidor removido vira erro legível, sem chamar a API', async () => {
    servidores.lista = [srv2];
    const api = apis();
    await api.abrir('a.txt');
    expect(core.readFile).not.toHaveBeenCalled();
    expect(api.use.getState().loading).toBe(false);
    expect(api.use.getState().selecionado).toBeNull();
    expect(api.use.getState().erro).toBeTruthy();
  });

  it('PDF recusado como binário (415) continua selecionado para o leitor, sem erro', async () => {
    vi.mocked(core.readFile).mockRejectedValue(Object.assign(new Error('415: binário'), { status: 415 }));
    const api = apis();
    await api.abrir('docs/manual.pdf');
    expect(api.use.getState().selecionado).toBe('docs/manual.pdf');
    expect(api.use.getState().conteudo).toBeNull();
    expect(api.use.getState().erro).toBeNull();
  });

  it('binário que não é documento mostra a causa', async () => {
    vi.mocked(core.readFile).mockRejectedValue(Object.assign(new Error('415: Arquivo binário'), { status: 415 }));
    const api = apis();
    await api.abrir('bin/app.so');
    expect(api.use.getState().selecionado).toBeNull();
    expect(api.use.getState().erro).toBe('Arquivo binário');
  });

  it('fechar a folha com leitura em voo não deixa a próxima abertura em carregando', async () => {
    vi.mocked(core.readFile).mockReturnValue(new Promise(() => {}));
    const api = apis();
    api.retain();
    void api.abrir('a.txt');
    await Promise.resolve();
    expect(api.use.getState().loading).toBe(true);
    api.release();
    expect(api.use.getState().loading).toBe(false);
    expect(api.use.getState().selecionado).toBeNull();
  });

  it('última folha fechada solta texto, diff e busca, preservando pastas abertas', async () => {
    const text = '# retained-file\n'.repeat(4000);
    vi.mocked(core.readFile).mockResolvedValue({ path: 'large.md', text, size: text.length, truncated: false, digest: 'd' });
    vi.mocked(core.pathDiff).mockResolvedValue({
      path: 'large.md', diff: '+retained-file', original: text,
      truncated: false, escopo_pedido: 'branch', escopo_usado: 'branch', base: null, motivo: null,
    });
    vi.mocked(core.searchFiles).mockResolvedValue({ hits: [{ path: 'large.md', line: 1, text }], truncated: false, mode: 'contents' });
    const api = apis();
    api.retain();
    api.retain();
    await api.alternarPasta('docs');
    await api.abrir('large.md');
    await api.buscar('retained', 'contents');
    api.release();
    expect(api.use.getState().conteudo?.text).toBe(text);

    api.release();
    expect(api.use.getState().conteudo).toBeNull();
    expect(api.use.getState().diff).toBeNull();
    expect(api.use.getState().selecionado).toBeNull();
    expect(api.use.getState().resultados).toEqual([]);
    expect(api.use.getState().abertos.has('docs')).toBe(true);
    expect(api.use.getState().porPasta.has('docs')).toBe(true);
  });

  it('404 ao abrir remove hit dos resultados quando busca gravada ainda é a mesma', async () => {
    const api = apis();
    // simula busca prévia
    vi.mocked(core.searchFiles).mockResolvedValue({
      hits: [{ path: 'a.txt', line: 1, text: 'hit' }],
      truncated: false,
      mode: 'names',
    } as never);
    await api.buscar('a', 'names');
    expect(api.use.getState().resultados).toHaveLength(1);

    // abrir a.txt com 404
    const err404 = Object.assign(new Error('404: erro_arq_inexistente'), { status: 404 });
    vi.mocked(core.readFile).mockRejectedValue(err404);
    // pathDiff neve? abrir faz Promise.allSettled de readFile e pathDiff
    // pathDiff pode resolver mas será descartado por conteúdo falhar
    vi.mocked(core.pathDiff).mockResolvedValue({
      path: 'a.txt',
      diff: '',
      truncated: false,
      escopo_pedido: 'branch',
      escopo_usado: 'branch',
      base: null,
      motivo: null,
      original: null,
    } as never);
    // listFiles para recarregar (precisa resolver)
    vi.mocked(core.listFiles).mockResolvedValue({ entries: [], truncated: false });

    await api.abrir('a.txt');

    // deve remover hit
    expect(api.use.getState().resultados).toHaveLength(0);
    // erro deve ser erro_arq_inexistente traduzido? Na implementação mobile usamos m.erro_arq_inexistente() que retorna string traduzida, mas não podemos prever valor exato. Verifica que erro não é null.
    expect(api.use.getState().erro).toBeTruthy();
  });
});
