// Relatório de uso (skills, tools, Bash, MCP, agentes, contexto injetado, plugins) do Claude
// Code, lido do transcript pelo backend (`/api/uso`). Irmão do relatório de custos: mesma
// malha de servidores, mesma regra de mescla (soma por chave, servidor antigo tolerado na
// ENTRADA), mesmos avisos de parcial/desatualizado.
import type { Applied } from './types';

export interface UsoBucket {
  key: string;
  label?: string | null;
  plugin?: string;
  sessions: number;
  chamadas: number;
  ctx_chars: number;
  // Estimativa (chars/4) do que entrou no contexto. Nunca vira dólar; a tela rotula "≈".
  ctx_tokens_est: number;
  // Reais só onde há `usage` por trás: skill (respostas da execução) e agente (transcript filho).
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost: number;
}

export type UsoDim = 'by_skill' | 'by_tool' | 'by_bash' | 'by_mcp' | 'by_agente' | 'by_contexto' | 'by_plugin';
export const USO_DIMS: UsoDim[] = ['by_skill', 'by_tool', 'by_bash', 'by_mcp', 'by_agente', 'by_contexto', 'by_plugin'];

export interface UsoReport {
  totals: UsoBucket;
  by_skill: UsoBucket[];
  by_tool: UsoBucket[];
  by_bash: UsoBucket[];
  by_mcp: UsoBucket[];
  by_agente: UsoBucket[];
  by_contexto: UsoBucket[];
  by_plugin: UsoBucket[];
  applied?: Applied | null;
  usd_brl?: number | null;
}

export interface UsoServerResult {
  report: Partial<UsoReport> | null;
  label?: string;
  id?: string;
}

export interface MergedUso {
  report: UsoReport & { by_servidor: UsoBucket[] };
  partial: boolean;
  mismatched: string[];
  failed: string[];
}

export const zeroUso = (key: string): UsoBucket => ({
  key, label: null, plugin: '', sessions: 0, chamadas: 0, ctx_chars: 0, ctx_tokens_est: 0,
  input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0,
});

// `?? 0` em tudo: servidor antigo da malha sem um campo não pode virar NaN na coluna inteira.
function somar(alvo: UsoBucket, b: Partial<UsoBucket>): void {
  alvo.sessions += b.sessions ?? 0;
  alvo.chamadas += b.chamadas ?? 0;
  alvo.ctx_chars += b.ctx_chars ?? 0;
  alvo.ctx_tokens_est += b.ctx_tokens_est ?? 0;
  alvo.input += b.input ?? 0;
  alvo.output += b.output ?? 0;
  alvo.cache_write += b.cache_write ?? 0;
  alvo.cache_read += b.cache_read ?? 0;
  alvo.cost += b.cost ?? 0;
}

function juntar(destino: Map<string, UsoBucket>, lista: UsoBucket[] | undefined): void {
  for (const b of lista ?? []) {
    if (!b || typeof b.key !== 'string') continue;
    let alvo = destino.get(b.key);
    if (!alvo) { alvo = zeroUso(b.key); destino.set(b.key, alvo); }
    alvo.label = alvo.label ?? b.label ?? null;
    alvo.plugin = alvo.plugin || b.plugin || '';
    somar(alvo, b);
  }
}

const ordenar = (m: Map<string, UsoBucket>) =>
  [...m.values()].sort((a, b) =>
    b.cost - a.cost || b.ctx_chars - a.ctx_chars || b.chamadas - a.chamadas || a.key.localeCompare(b.key));

export function mergeUso(results: UsoServerResult[], period: string): MergedUso {
  const totals = zeroUso('totals');
  const dims = Object.fromEntries(USO_DIMS.map((d) => [d, new Map<string, UsoBucket>()])) as Record<UsoDim, Map<string, UsoBucket>>;
  const servidores: UsoBucket[] = [];
  const mismatched: string[] = [];
  const failed: string[] = [];
  let partial = false;
  let usdBrl: number | null = null;

  results.forEach((res, i) => {
    const r = res.report;
    if (!r) { partial = true; failed.push(res.label ?? `#${i + 1}`); return; }
    usdBrl = usdBrl ?? r.usd_brl ?? null;
    if ((r.applied?.period ?? null) !== period) {
      partial = true;
      mismatched.push(res.label ?? `#${i + 1}`);
      return;
    }
    somar(totals, r.totals ?? {});
    const bs = zeroUso(res.id ?? res.label ?? `#${i + 1}`);
    bs.label = res.label ?? null;
    somar(bs, r.totals ?? {});
    servidores.push(bs);
    for (const d of USO_DIMS) juntar(dims[d], r[d]);
  });

  return {
    report: {
      totals,
      by_skill: ordenar(dims.by_skill),
      by_tool: ordenar(dims.by_tool),
      by_bash: ordenar(dims.by_bash),
      by_mcp: ordenar(dims.by_mcp),
      by_agente: ordenar(dims.by_agente),
      by_contexto: ordenar(dims.by_contexto),
      by_plugin: ordenar(dims.by_plugin),
      by_servidor: servidores.sort((a, b) => b.cost - a.cost || b.chamadas - a.chamadas),
      applied: { period },
      usd_brl: usdBrl,
    },
    partial, mismatched, failed,
  };
}
