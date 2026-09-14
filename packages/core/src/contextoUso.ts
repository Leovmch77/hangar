// Saída do `/context` da CLI (markdown com tabelas) lida em dados, pro cartão do app. A CLI não
// oferece forma estruturada; o texto é o contrato, e qualquer desvio devolve null — a bolha de
// markdown continua mostrando o original.

export interface CategoriaContexto { nome: string; tokens: number; pct: number }
export interface FerramentaMcp { nome: string; servidor: string; tokens: number }
export interface LimiteConta { rotulo: string; pct: number; resetTs: number | null }

export interface ContextoUso {
  modelo: string | null;
  usado: number;
  total: number;
  pct: number;
  categorias: CategoriaContexto[];
  mcp: FerramentaMcp[];
  limites: LimiteConta[];
}

export function tokensDeTexto(s: string): number {
  const m = s.trim().match(/^([\d.,]+)\s*([kKmM]?)$/);
  if (!m) return NaN;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(n * mult);
}

function tabelas(texto: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  let titulo = '';
  for (const linha of texto.split('\n')) {
    const h = linha.match(/^###\s+(.+?)\s*$/);
    if (h) { titulo = h[1].toLowerCase(); continue; }
    if (!titulo || !linha.trim().startsWith('|') || /^\|\s*-/.test(linha.trim())) continue;
    const cels = linha.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const rows = out.get(titulo) ?? [];
    rows.push(cels);
    out.set(titulo, rows);
  }
  // A primeira linha de cada tabela é o cabeçalho.
  for (const [k, v] of out) out.set(k, v.slice(1));
  return out;
}

export function parseContextoUso(texto: string | null | undefined): ContextoUso | null {
  if (!texto || !texto.startsWith('## Context Usage')) return null;
  const t = texto.match(/\*\*Tokens:\*\*\s*([\d.,]+[kKmM]?)\s*\/\s*([\d.,]+[kKmM]?)\s*\(([\d.]+)%\)/);
  if (!t) return null;
  const usado = tokensDeTexto(t[1]);
  const total = tokensDeTexto(t[2]);
  if (!Number.isFinite(usado) || !Number.isFinite(total) || total <= 0) return null;

  const tabs = tabelas(texto);
  const cat = [...tabs.entries()].find(([k]) => k.includes('by category'))?.[1] ?? [];
  const categorias = cat
    .map(([nome, tok, pct]) => ({ nome, tokens: tokensDeTexto(tok ?? ''), pct: parseFloat(pct ?? '') }))
    .filter((c) => c.nome && Number.isFinite(c.tokens));
  const mcp = (tabs.get('mcp tools') ?? [])
    .map(([nome, servidor, tok]) => ({ nome, servidor: servidor ?? '', tokens: tokensDeTexto(tok ?? '') }))
    .filter((f) => f.nome && Number.isFinite(f.tokens));
  const limites = (tabs.get('plan limits') ?? [])
    .map(([rotulo, pct, reset]) => ({ rotulo, pct: parseFloat(pct ?? ''), resetTs: reset ? Number(reset) : null }))
    .filter((l) => l.rotulo && Number.isFinite(l.pct));

  return {
    modelo: texto.match(/\*\*Model:\*\*\s*(\S+)/)?.[1] ?? null,
    usado,
    total,
    pct: parseFloat(t[3]),
    categorias,
    mcp,
    limites,
  };
}
