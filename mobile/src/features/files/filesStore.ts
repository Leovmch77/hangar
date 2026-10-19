import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { listFiles, readFile, readCitedFile, resolverCitados, searchFiles, pathDiff, writeFile, writeCitedFile, discardFile } from '@hangar/core';
import { fileKind } from '@hangar/core';
import type { FileContent, FileSearchHit, PathDiff, Server, TreeEntry } from '@hangar/core';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';

// limpa prefixo "409: " etc — mesmo que gitStore
const cleanErr = (e: unknown) => (e instanceof Error ? e.message : 'falhou').replace(/^\d+:\s*/, '');

// helpers puros para derivados
export function entriesOf(porPasta: Map<string, TreeEntry[]>, abertos: Set<string>): TreeEntry[] {
  const saida: TreeEntry[] = [];
  const empilha = (dir: string) => {
    for (const en of porPasta.get(dir) ?? []) {
      saida.push(en);
      if (en.is_dir && abertos.has(en.path)) empilha(en.path);
    }
  };
  empilha('');
  return saida;
}

export function listaCortadaOf(cortePorPasta: Map<string, boolean>, abertos: Set<string>): boolean {
  for (const [dir, cortou] of cortePorPasta) {
    if (cortou && (dir === '' || abertos.has(dir))) return true;
  }
  return false;
}

export interface FilesState {
  abertos: Set<string>;
  selecionado: string | null;
  conteudo: FileContent | null;
  diff: PathDiff | null;
  escopo: 'branch' | 'nao_commitado';
  resultados: FileSearchHit[];
  erro: string | null;
  soModificados: boolean;
  buscaCortada: boolean;
  loading: boolean;
  porPasta: Map<string, TreeEntry[]>;
  cortePorPasta: Map<string, boolean>;
}

export interface FilesApi {
  use: UseBoundStore<StoreApi<FilesState>>;
  retain: () => void;
  release: () => void;
  listar: (dir: string) => Promise<void>;
  abrir: (path: string) => Promise<void>;
  abrirCitado: (cru: string) => Promise<void>;
  buscar: (q: string, mode: 'names' | 'contents') => Promise<void>;
  salvar: (path: string, texto: string) => Promise<string | null>;
  recarregar: () => Promise<void>;
  recarregarDiff: (path: string) => Promise<void>;
  descartar: (path: string) => Promise<void>;
  alternarPasta: (path: string) => Promise<void>;
  setOnlyModified: (onlyModified: boolean) => Promise<void>;
  trocarEscopo: (escopo: 'branch' | 'nao_commitado') => Promise<void>;
  // seletores derivados (atalhos)
  entries: () => TreeEntry[];
  listaCortada: () => boolean;
}

function criarFilesStore(serverId: string, sessao: string): FilesApi {
  const useStore = create<FilesState>(() => ({
    abertos: new Set<string>(),
    selecionado: null,
    conteudo: null,
    diff: null,
    escopo: 'branch',
    resultados: [],
    erro: null,
    soModificados: true,
    buscaCortada: false,
    loading: false,
    porPasta: new Map<string, TreeEntry[]>(),
    cortePorPasta: new Map<string, boolean>(),
  }));

  let gArquivo = 0;
  let gBusca = 0;
  const gLista = new Map<string, number>();
  let gErro = 0;
  let gResultados = -1;
  let refs = 0;
  let externo = false;

  // Servidor da sessão, nunca o ativo: trocar de servidor com a folha aberta não desvia leitura nem gravação.
  function destino(): Server | undefined {
    return useServers.getState().servers.find((s) => s.id === serverId);
  }

  function getS() {
    return useStore.getState();
  }

  function setS(p: Partial<FilesState>) {
    useStore.setState(p as FilesState);
  }

  // invalida subárvore (mesma lógica do frontend)
  function _invalidarSubarvore(path: string) {
    const s = getS();
    for (const p of [...s.porPasta.keys(), ...s.cortePorPasta.keys()]) {
      if (p === path || (path !== '' && p.startsWith(path + '/'))) {
        gLista.set(p, (gLista.get(p) ?? 0) + 1);
      }
    }
    // remove do state com novos Maps
    const np = new Map(s.porPasta);
    const nc = new Map(s.cortePorPasta);
    for (const p of [...np.keys(), ...nc.keys()]) {
      if (p === path || (path !== '' && p.startsWith(path + '/'))) {
        np.delete(p);
        nc.delete(p);
      }
    }
    setS({ porPasta: np, cortePorPasta: nc });
  }

  async function _listar(path: string, ge: number) {
    const g = (gLista.get(path) ?? 0) + 1;
    gLista.set(path, g);
    if (path === '' && ge === gErro) setS({ erro: null });
    const srv = destino();
    if (!srv) {
      if (ge === gErro) setS({ erro: m.chat_servidor_removido() });
      return;
    }
    try {
      const r = await listFiles(sessao, path || undefined, getS().soModificados, srv);
      if (g !== gLista.get(path)) return;
      const np = new Map(getS().porPasta);
      const nc = new Map(getS().cortePorPasta);
      np.set(path, r.entries);
      nc.set(path, r.truncated);
      setS({ porPasta: np, cortePorPasta: nc });
    } catch (e) {
      if (g !== gLista.get(path)) return;
      const status = (e as Error & { status?: number }).status;
      if (status === 404) {
        if (path === '') {
          if (ge === gErro) setS({ erro: m.arq_sessao_encerrada() });
        } else {
          const cur = getS();
          const chaves = new Set([...cur.abertos, ...cur.porPasta.keys(), ...cur.cortePorPasta.keys()]);
          // invalida gerações e remove
          for (const p of chaves) {
            if (p === path || p.startsWith(path + '/')) {
              gLista.set(p, (gLista.get(p) ?? 0) + 1);
            }
          }
          const np = new Map(cur.porPasta);
          const nc = new Map(cur.cortePorPasta);
          const na = new Set(cur.abertos);
          for (const p of chaves) {
            if (p === path || p.startsWith(path + '/')) {
              na.delete(p);
              nc.delete(p);
              np.delete(p);
            }
          }
          setS({ abertos: na, porPasta: np, cortePorPasta: nc });
        }
        return;
      }
      if (ge === gErro) setS({ erro: cleanErr(e) });
    }
  }

  async function recarregarInterno(ge?: number) {
    const dona = ge ?? ++gErro;
    const dirs = ['', ...getS().abertos];
    await Promise.all(dirs.map((p) => _listar(p, dona)));
  }

  async function abrir(path: string) {
    externo = false;
    setS({ selecionado: path, erro: null, loading: true });
    const g = ++gArquivo;
    const ge = ++gErro;
    const gr = gResultados;
    const gb = gBusca;
    const podePodar = gb === gr;
    const srv = destino();
    if (!srv) {
      setS({ loading: false, conteudo: null, diff: null, selecionado: null, erro: m.chat_servidor_removido() });
      return;
    }
    const [c, d] = await Promise.allSettled([readFile(sessao, path, srv), pathDiff(sessao, path, getS().escopo, srv)]);
    if (g !== gArquivo) return;
    setS({ loading: false });
    if (c.status === 'rejected') {
      const status = (c.reason as Error & { status?: number })?.status;
      // PDF/imagem não têm texto (415): o leitor mostra pela rota de arquivo, que serve o binário.
      const kind = fileKind(path);
      if (status === 415 && (kind === 'pdf' || kind === 'image')) {
        setS({ conteudo: null, diff: d.status === 'fulfilled' ? d.value : null });
        return;
      }
      setS({ conteudo: null, diff: null, selecionado: null });
      if (status === 404) {
        const pai = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        _invalidarSubarvore(pai);
        await recarregarInterno(ge);
        if (pai !== '') await _listar(pai, ge);
        if (podePodar && gb === gBusca && gr === gResultados) {
          const cur = getS().resultados.filter((h) => h.path !== path);
          setS({ resultados: cur });
        }
        if (ge === gErro && !getS().erro) setS({ erro: m.erro_arq_inexistente() });
      } else if (ge === gErro) {
        setS({ erro: cleanErr(c.reason) });
      }
      return;
    }
    setS({ conteudo: c.value });
    if (d.status === 'fulfilled') setS({ diff: d.value });
    else setS({ diff: null });
  }

  // A citação chega como o modelo escreveu (absoluta, fora da pasta da sessão…); o /files/read só
  // aceita relativo à raiz. O servidor resolve e, fora da raiz, serve pelo /file/text.
  async function abrirCitado(cru: string) {
    setS({ selecionado: cru, conteudo: null, diff: null, erro: null, loading: true });
    const g = ++gArquivo;
    const ge = ++gErro;
    const srv = destino();
    if (!srv) {
      setS({ loading: false, selecionado: null, erro: m.chat_servidor_removido() });
      return;
    }
    let alvo: { relativo: string | null } | undefined;
    try {
      alvo = (await resolverCitados(sessao, [cru], srv)).ok[cru];
    } catch (e) {
      if (g === gArquivo) setS({ loading: false, selecionado: null, erro: cleanErr(e) });
      return;
    }
    if (g !== gArquivo) return;
    if (!alvo) {
      setS({ loading: false, selecionado: null, erro: m.erro_arq_inexistente() });
      return;
    }
    if (alvo.relativo !== null) {
      await abrir(alvo.relativo);
      return;
    }
    externo = true;
    try {
      const c = await readCitedFile(sessao, cru, srv);
      if (g === gArquivo) setS({ loading: false, conteudo: c });
    } catch (e) {
      if (g !== gArquivo) return;
      setS({ loading: false, selecionado: null });
      if (ge === gErro) {
        const status = (e as Error & { status?: number }).status;
        setS({ erro: status === 404 ? m.erro_arq_inexistente() : cleanErr(e) });
      }
    }
  }

  async function buscar(q: string, mode: 'names' | 'contents') {
    const g = ++gBusca;
    const ge = ++gErro;
    setS({ erro: null });
    if (q.trim() === '') {
      setS({ resultados: [], buscaCortada: false });
      gResultados = g;
      return;
    }
    const srv = destino();
    if (!srv) {
      setS({ erro: m.chat_servidor_removido() });
      return;
    }
    try {
      const r = await searchFiles(sessao, q, mode, srv);
      if (g !== gBusca) return;
      setS({ resultados: r.hits, buscaCortada: r.truncated });
      gResultados = g;
    } catch (e) {
      if (g === gBusca && ge === gErro) setS({ erro: cleanErr(e) });
    }
  }

  async function salvar(path: string, texto: string): Promise<string | null> {
    const atual = getS().conteudo;
    if (!atual || atual.path !== path) return m.erro_arq_inexistente();
    const srv = destino();
    if (!srv) return m.chat_servidor_removido();
    try {
      const r = externo
        ? await writeCitedFile(sessao, path, texto, atual.digest, srv)
        : await writeFile(sessao, path, texto, atual.digest, srv);
      if (getS().conteudo?.path === path) {
        setS({ conteudo: { ...getS().conteudo!, text: texto, size: r.size, digest: r.digest } });
      }
      if (!externo) void recarregarDiff(path);
      return null;
    } catch (e) {
      return (e instanceof Error && e.message ? cleanErr(e) : '') || m.erro_arq_salvar_falhou();
    }
  }

  async function recarregarDiff(path: string) {
    const g = gArquivo;
    const srv = destino();
    if (!srv) return;
    try {
      const d = await pathDiff(sessao, path, getS().escopo, srv);
      if (g === gArquivo && getS().selecionado === path) setS({ diff: d });
    } catch {
      // diff em enfeite — falha silenciosa
    }
  }

  async function descartar(path: string) {
    const srv = destino();
    if (!srv) {
      setS({ erro: m.chat_servidor_removido() });
      throw new Error(m.chat_servidor_removido());
    }
    try {
      await discardFile(sessao, path, srv);
      await recarregarInterno();
      // se o arquivo descartado estava aberto, reabre para atualizar diff/conteúdo
      if (getS().selecionado === path) {
        await abrir(path);
      }
    } catch (e) {
      setS({ erro: cleanErr(e) });
      throw e;
    }
  }

  async function listar(dir: string) {
    await _listar(dir, ++gErro);
  }

  async function alternarPasta(path: string) {
    const cur = getS();
    if (cur.abertos.has(path)) {
      const na = new Set(cur.abertos);
      na.delete(path);
      setS({ abertos: na });
      return;
    }
    const na = new Set(cur.abertos);
    na.add(path);
    setS({ abertos: na });
    if (!cur.porPasta.has(path)) await _listar(path, ++gErro);
  }

  async function setOnlyModified(onlyModified: boolean) {
    if (onlyModified === getS().soModificados) return;
    for (const [path, generation] of gLista) gLista.set(path, generation + 1);
    const s = getS();
    setS({
      soModificados: onlyModified,
      porPasta: new Map([...s.porPasta].filter(([path]) => path === '' || s.abertos.has(path))),
      cortePorPasta: new Map([...s.cortePorPasta].filter(([path]) => path === '' || s.abertos.has(path))),
    });
    await recarregarInterno();
  }

  async function trocarEscopo(escopo: 'branch' | 'nao_commitado') {
    if (escopo === getS().escopo) return;
    setS({ escopo });
    // Arquivo de fora da raiz não tem diff: reabrir pelo /files/read o recusaria.
    if (getS().selecionado && !externo) await abrir(getS().selecionado!);
  }

  async function recarregar() {
    await recarregarInterno();
  }

  return {
    use: useStore,
    retain() {
      refs++;
      if (refs === 1) {
        // primeira retenção carrega raiz
        void recarregarInterno();
      }
    },
    release() {
      if (refs === 0) return;
      refs--;
      if (refs > 0) return;
      gArquivo++;
      gBusca++;
      gErro++;
      // O registro vive além da folha; só o estado das pastas precisa sobreviver.
      setS({ conteudo: null, diff: null, selecionado: null, resultados: [], buscaCortada: false, loading: false, erro: null });
    },
    listar,
    abrir,
    abrirCitado,
    buscar,
    salvar,
    recarregar,
    recarregarDiff,
    descartar,
    alternarPasta,
    setOnlyModified,
    trocarEscopo,
    entries() {
      const s = getS();
      return entriesOf(s.porPasta, s.abertos);
    },
    listaCortada() {
      const s = getS();
      return listaCortadaOf(s.cortePorPasta, s.abertos);
    },
  };
}

const filesRegistry = new Map<string, FilesApi>();

export function filesStore(serverId: string, name: string): FilesApi {
  const chave = `${serverId}::${name}`;
  let api = filesRegistry.get(chave);
  if (!api) {
    api = criarFilesStore(serverId, name);
    filesRegistry.set(chave, api);
  }
  return api;
}

export function _resetFilesForTests() {
  for (const api of filesRegistry.values()) api.release();
  filesRegistry.clear();
}
