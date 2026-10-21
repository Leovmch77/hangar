import { getAtualizacaoEm, getIdentificadorEm, iniciarAtualizacaoEm } from './api';
import { isOwnMachine } from './machineImport';
import { registrar as registerDiagnostic } from './diag';
import type { Server } from './servers';
import type { Atualizacao, AtualizacaoEstado } from './types';

export type UpdateHoldReason = 'branch' | 'mudancas' | 'rodando' | 'falta';
export type UpdateClassification = 'iniciar' | 'em_dia' | `travado:${UpdateHoldReason}`;
export type UpdateFollow = 'rodando' | 'esperando' | 'atualizado' | 'atualizado_manual' | 'falhou';

type UpdateSnapshot = {
  atualizacao_disponivel?: boolean;
  versoes?: Partial<Atualizacao['versoes']>;
  pre_voo?: Partial<Atualizacao['pre_voo']>;
  estado?: { fase?: string };
};

/** Mesmo pré-voo do nativo; o canal do app local não participa das outras máquinas. */
export function classify(snapshot: UpdateSnapshot): UpdateClassification {
  const clean = (version: string | undefined) => version?.replace(/(?:-dirty)+$/, '');
  const disk = clean(snapshot.versoes?.repo);
  const live = clean(snapshot.versoes?.backend);
  if (snapshot.atualizacao_disponivel !== true && !(disk !== undefined && live !== undefined && disk !== live)) return 'em_dia';
  const pre = snapshot.pre_voo;
  if (pre?.branch_de_trabalho === true) return 'travado:branch';
  if ((pre?.sujo ?? 0) > 0 || (pre?.ahead ?? 0) > 0 || pre?.divergiu === true) return 'travado:mudancas';
  if (snapshot.estado?.fase === 'rodando') return 'travado:rodando';
  if (pre?.pode === false) return 'travado:falta';
  return 'iniciar';
}

function timestamp(value: string): { seconds: number; fraction: string } | null {
  const parts = /^(\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const seconds = Date.parse(`${parts[1]}${parts[3]}`);
  // O estado Python usa microssegundos; Date.parse sozinho perderia essa ordem.
  return Number.isFinite(seconds) ? { seconds, fraction: (parts[2] ?? '').padEnd(9, '0') } : null;
}

function afterBaseline(ts: string | undefined, baseline: string | null | undefined): boolean {
  if (baseline == null) return true;
  if (ts === undefined) return false;
  const current = timestamp(ts);
  const previous = timestamp(baseline);
  if (!current || !previous) return ts !== baseline;
  return current.seconds > previous.seconds || (current.seconds === previous.seconds && current.fraction > previous.fraction);
}

/** O desfecho precisa ser posterior ao GET anterior ao iniciar, independentemente do pid. */
export function follow(state: AtualizacaoEstado, baseTs?: string | null): UpdateFollow {
  if (state.fase === 'rodando') return 'rodando';
  if (state.fase !== 'pronto' || !afterBaseline(state.ts, baseTs)) return 'esperando';
  if (state.ok !== true) return 'falhou';
  return state.reiniciar_manual === true ? 'atualizado_manual' : 'atualizado';
}

export function ownUpdatableServers(list: readonly Server[]): Server[] {
  return list.filter((server) => isOwnMachine(server) && !server.disabled);
}

export interface UpdateAllState {
  status: 'consultando' | 'iniciando' | 'em_dia' | 'travado' | 'fora_do_ar' | UpdateFollow;
  reason?: UpdateHoldReason;
  error?: string;
  /** Campos originais do motor: passo, total, texto, erro e avisos. */
  state?: AtualizacaoEstado;
  preflight?: Atualizacao['pre_voo'];
  warnings: string[];
}

export interface UpdateAllOptions {
  /** Servidor da página PWA: seu reinício só começa depois das outras máquinas. */
  last?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UpdateAllResult { server: Server; state: UpdateAllState }

const POLL_MS = 2000;
const SILENT_READS = 300;
const FOLLOW_CEILING_MS = 30 * 60 * 1000;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Publica só representantes de máquinas distintas e devolve seus desfechos na ordem da lista. */
export async function updateAll(
  servers: readonly Server[],
  onChange: (serverId: string, state: UpdateAllState) => void,
  opts: UpdateAllOptions = {},
): Promise<UpdateAllResult[]> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const candidates = ownUpdatableServers(servers);
  const identities = await Promise.all(candidates.map(async (server) => {
    try {
      const response = await getIdentificadorEm(server, opts.fetch);
      return typeof response.identificador === 'string' ? response.identificador.trim() : '';
    } catch (error) {
      registerDiagnostic({ evento: 'update_all.identity_failed', nivel: 'aviso',
        codigo: error instanceof Error ? error.name : 'erro' }, server.baseUrl);
      return '';
    }
  }));
  const representatives = new Map<string, Server>();
  candidates.forEach((server, index) => {
    const identity = identities[index];
    if (identity && (!representatives.has(identity) || server.id === opts.last)) representatives.set(identity, server);
  });
  const unique = candidates.filter((server, index) => !identities[index] || representatives.get(identities[index]) === server);

  async function run(server: Server): Promise<UpdateAllResult> {
    let previous = '';
    const publish = (value: UpdateAllState): UpdateAllState => {
      const signature = JSON.stringify(value);
      if (signature !== previous) { previous = signature; onChange(server.id, value); }
      return value;
    };
    const finish = (value: UpdateAllState): UpdateAllResult => ({ server, state: publish(value) });
    publish({ status: 'consultando', warnings: [] });
    let snapshot: Atualizacao;
    try {
      snapshot = await getAtualizacaoEm(server, true, opts.fetch);
    } catch (error) {
      const httpError = typeof error === 'object' && error !== null && 'status' in error;
      return finish({ status: httpError ? 'falhou' : 'fora_do_ar', error: errorMessage(error), warnings: [] });
    }
    const classification = classify(snapshot);
    if (classification === 'em_dia') return finish({ status: 'em_dia', warnings: [] });
    if (classification !== 'iniciar') return finish({ status: 'travado', reason: classification.slice(8) as UpdateHoldReason,
      state: snapshot.estado, preflight: snapshot.pre_voo, warnings: [] });

    const baseTs = snapshot.estado.ts;
    const startedAt = now();
    publish({ status: 'iniciando', warnings: [] });
    try {
      await iniciarAtualizacaoEm(server, opts.fetch);
    } catch (error) {
      return finish({ status: 'falhou', error: errorMessage(error), warnings: [] });
    }
    let silent = 0;
    let latest: UpdateAllState = { status: 'esperando', warnings: [] };
    for (;;) {
      await sleep(POLL_MS);
      let value: UpdateAllState;
      try {
        const { estado: state } = await getAtualizacaoEm(server, false, opts.fetch);
        silent = 0;
        const status = follow(state, baseTs);
        value = { status, state, warnings: state.avisos ?? [] };
        if (status === 'falhou') value.error = state.erro?.replace(/\.+$/, '') || '?';
        if (status === 'atualizado' || status === 'atualizado_manual' || status === 'falhou') return finish(value);
      } catch (error) {
        silent++;
        value = { ...latest, status: 'esperando', error: errorMessage(error) };
      }
      if (silent >= SILENT_READS || now() - startedAt >= FOLLOW_CEILING_MS) {
        return finish({ status: 'falhou', error: silent >= SILENT_READS ? 'sem resposta' : 'tempo limite de 30 minutos excedido',
          state: value.state, warnings: value.warnings });
      }
      latest = publish(value);
    }
  }

  // O representante de last também fica para o fim quando outro endereço aponta à mesma máquina.
  const results = await Promise.all(unique.filter((server) => server.id !== opts.last).map(run));
  const last = unique.find((server) => server.id === opts.last);
  if (last) results.push(await run(last));
  return unique.map((server) => results.find((result) => result.server === server)!);
}
