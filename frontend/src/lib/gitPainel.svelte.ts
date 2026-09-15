// Estado compartilhado entre a COLUNA de git (esquerda da conversa) e o PAINEL de contexto
// (direita): a coluna lista e escolhe, o painel abre. Vive fora dos componentes porque os dois
// lados montam e desmontam por caminhos diferentes — passar por props obrigaria o Chat inteiro a
// repassar um estado que não é dele.
import type { GitCommit } from '@hangar/core';
import { createGitStore, type GitStore } from './gitStore.svelte';

// Um store por sessão: trocar de sessão e voltar não recarrega o log do zero, e a coluna e o
// painel leem a MESMA lista (duas cópias divergiriam no primeiro commit).
const stores = new Map<string, GitStore>();

export function gitStoreDaSessao(sessionName: string): GitStore {
  let s = stores.get(sessionName);
  if (!s) {
    s = createGitStore(sessionName);
    stores.set(sessionName, s);
  }
  return s;
}

/** Aba do painel: um arquivo da árvore de trabalho ou um commit inteiro. */
export type AbaGit =
  | { id: string; tipo: 'arquivo'; path: string; rotulo: string }
  | { id: string; tipo: 'commit'; commit: GitCommit; rotulo: string };

export const gitPainel = $state({
  /** Sessão dona das abas: trocar de sessão não pode mostrar o diff do repo anterior. */
  sessao: '' as string,
  abas: [] as AbaGit[],
  ativa: '' as string,
});

function porSessao(sessao: string) {
  if (gitPainel.sessao !== sessao) {
    gitPainel.sessao = sessao;
    gitPainel.abas = [];
    gitPainel.ativa = '';
  }
}

function abrir(sessao: string, aba: AbaGit) {
  porSessao(sessao);
  // Reabrir o mesmo item só reativa a aba — clicar duas vezes no arquivo não cria duas.
  if (!gitPainel.abas.some((a) => a.id === aba.id)) gitPainel.abas = [...gitPainel.abas, aba];
  gitPainel.ativa = aba.id;
}

export function abrirArquivo(sessao: string, path: string): void {
  abrir(sessao, { id: 'arq:' + path, tipo: 'arquivo', path, rotulo: path.split('/').pop() || path });
}

export function abrirCommit(sessao: string, commit: GitCommit): void {
  abrir(sessao, { id: 'cmt:' + commit.hash, tipo: 'commit', commit, rotulo: commit.subject });
}

export function fecharAba(id: string): void {
  const i = gitPainel.abas.findIndex((a) => a.id === id);
  if (i < 0) return;
  gitPainel.abas = gitPainel.abas.filter((a) => a.id !== id);
  // Fechar a ativa cai na vizinha da direita, ou na última — nunca em painel vazio com abas.
  if (gitPainel.ativa === id) gitPainel.ativa = (gitPainel.abas[i] ?? gitPainel.abas.at(-1))?.id ?? '';
}

export function ativarAba(id: string): void {
  gitPainel.ativa = id;
}

export function limparAbas(): void {
  gitPainel.abas = [];
  gitPainel.ativa = '';
}
