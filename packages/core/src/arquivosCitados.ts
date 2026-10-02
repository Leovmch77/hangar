// Arquivos CITADOS na conversa, pra visão "Citados" da aba Arquivos. Separado do
// `parseFilePaths` de `format.ts` de propósito: aquele alimenta o chat (só mídia/html/pdf viram
// preview) e não pode ganhar extensão de código sem mudar o que a bolha desenha.
import type { ChatEvent } from './types';
import { fileKind } from './format';

// Lista FECHADA no RELATIVO: regex aberta ("qualquer extensão") casa `repo.git` em URL e some com
// `config.py` solto em prosa — os dois lados errados.
const _EXTS = 'svelte|tsx|ts|jsx|js|mjs|cjs|py|pas|dfm|cs|dart|md|json|yaml|yml|toml|scss|css|html|sql|sh|fish|ps1|env|lock|txt|csv|xml|ini|cfg|conf';
const _ESPECIAIS = 'Dockerfile|Makefile';
// No ABSOLUTO a extensão é aberta: `/` ou `~/` na frente já diz que é caminho, e a lista fechada
// escondia `servidor-smb.auth`, `.log`, `.service` — o arquivo citado não virava link nem entrava
// nos citados. Exige um caractere de nome antes do ponto e letra depois dele, pra `~/.hangar` e
// `/usr/lib/python3.14` (pastas) não virarem arquivo.
const _EXT_ABERTA = `[^/\\s"'\`)\\].]\\.[A-Za-z][A-Za-z0-9_-]{0,11}`;
// Absoluto (/ ou ~/): não exige pasta. Lookbehind tira o "/" de dentro de URL e o "./" do relativo.
const _ABS_RE = new RegExp(`(?<![\\w.~:/*])(~?/[^\\s"'\`)\\]]*?(?:\\.(?:${_EXTS})|${_EXT_ABERTA}|/(?:${_ESPECIAIS})))(?=$|\\.(?=\\s|$)|[\\s)\\]"'\`,;:*])`, 'g');
// Relativo: exige `dir/nome.ext` (mesma regra do _REL_RE do format.ts) — `app.main` não casa.
const _REL_RE = new RegExp(`(?<![\\w/~.:*-])((?:[\\w.-]+/)+(?:[\\w.-]+\\.(?:${_EXTS})|(?:${_ESPECIAIS})))(?=$|\\.(?=\\s|$)|[\\s)\\]"'\`,;:*])`, 'g');

export function parseCodePaths(texto: string): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const re of [_ABS_RE, _REL_RE]) {
    for (const m of texto.matchAll(re)) {
      const p = m[1];
      if (/^https?:/.test(p) || p.includes('://')) continue;
      if (/(^|\/)(\.git|node_modules)\//.test(p)) continue;
      if (!vistos.has(p)) { vistos.add(p); out.push(p); }
    }
  }
  return out;
}

export interface CodeReference {
  path: string;
  line: number | null;
  start: number;
  end: number;
}

// Preserva as ocorrências e posições: a mesma citação pode aparecer duas vezes na frase.
export function parseCodeReferences(text: string): CodeReference[] {
  const paths = new Set(parseCodePaths(text));
  const refs: CodeReference[] = [];
  for (const re of [_ABS_RE, _REL_RE]) {
    for (const match of text.matchAll(re)) {
      const path = match[1];
      if (!paths.has(path)) continue;
      const start = match.index;
      const end = start + path.length;
      const suffix = /^:(\d+)(?::\d+)?/.exec(text.slice(end));
      const line = suffix ? Number(suffix[1]) : null;
      refs.push({ path, line: line && Number.isSafeInteger(line) ? line : null,
        start, end: end + (suffix?.[0].length ?? 0) });
    }
  }
  return refs.sort((a, b) => a.start - b.start)
    .filter((ref, i, all) => i === 0 || ref.start >= all[i - 1].end);
}

// Citação de arquivo no markdown NATIVO: a lib desenha o texto e só devolve o toque em link, então
// a citação vira link `hangar-file:` (o par do chip do markdown.ts do web). Mídia, html e pdf ficam
// de fora: a bolha já desenha anexo pra eles.
const FILE_LINK = 'hangar-file:';
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

export function fileLinkUrl(path: string, line: number | null): string {
  return FILE_LINK + encodeURIComponent(path) + (line ? `#L${line}` : '');
}

/** Destino de um link tocado que é arquivo: o `hangar-file:` acima ou o caminho cru de
 *  `[x](src/a.ts:12)`. null = URL de verdade (http, mailto…) ou âncora. */
export function parseFileLink(url: string): { path: string; line: number | null } | null {
  if (url.startsWith(FILE_LINK)) {
    const [p, frag = ''] = url.slice(FILE_LINK.length).split('#');
    const n = Number(frag.slice(1));
    return { path: decodeURIComponent(p), line: frag.startsWith('L') && Number.isSafeInteger(n) && n > 0 ? n : null };
  }
  let raw = url.replace(/^file:\/\//i, '');
  if (!raw || raw.startsWith('#') || raw.startsWith('?')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !LINE_SUFFIX.test(raw)) return null;
  try { raw = decodeURI(raw); } catch { /* fica o cru */ }
  const suffix = LINE_SUFFIX.exec(raw);
  const n = suffix ? Number(suffix[1]) : 0;
  return { path: suffix ? raw.slice(0, suffix.index) : raw, line: Number.isSafeInteger(n) && n > 0 ? n : null };
}

// Mesmas recusas do `reference` do markdown.ts: código inline só vira link se for INTEIRO um caminho.
function codeRef(code: string): { path: string; line: number | null } | null {
  if (/\s/.test(code) && !code.startsWith('/') && !code.startsWith('~/')) return null;
  if (/^\.[^./:]+(?::\d+(?::\d+)?)?$/.test(code) && code !== '.env') return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(code) && !LINE_SUFFIX.test(code)) return null;
  const candidate = (code.startsWith('/') || code.startsWith('~/') ? '' : '/') + code.replace(/ /g, '%20');
  const ref = parseCodeReferences(candidate)[0];
  if (!ref || ref.start !== 0 || ref.end !== candidate.length) return null;
  return { path: code.slice(0, code.length - (ref.end - ref.path.length)), line: ref.line };
}

function linkProse(text: string): string {
  let s = text;
  for (const ref of parseCodeReferences(text).reverse()) {
    if (fileKind(ref.path)) continue;
    s = `${s.slice(0, ref.start)}[${s.slice(ref.start, ref.end)}](${fileLinkUrl(ref.path, ref.line)})${s.slice(ref.end)}`;
  }
  return s;
}

// Código inline, link markdown e URL ficam protegidos: só o código que é caminho vira link.
const PROTEGIDO = /`([^`]+)`|\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s<]+/g;

function linkLine(line: string): string {
  let out = '';
  let last = 0;
  for (const mt of line.matchAll(PROTEGIDO)) {
    out += linkProse(line.slice(last, mt.index));
    const ref = mt[1] !== undefined ? codeRef(mt[1]) : null;
    out += ref && !fileKind(ref.path) ? `[${mt[0]}](${fileLinkUrl(ref.path, ref.line)})` : mt[0];
    last = mt.index + mt[0].length;
  }
  return out + linkProse(line.slice(last));
}

export function linkCodeReferences(md: string): string {
  let fence: string | null = null;
  return md.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return line;
    }
    if (f) { fence = f[1]; return line; }
    return linkLine(line);
  }).join('\n');
}

export type Origem ='Read' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'Bash' | 'tool' | 'voce' | 'citado';
const _TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);

export interface Citado {
  cru: string;                 // a string como apareceu — é o que `path_in_transcript` casa no /file
  relativo: string | null;     // dentro do cwd: caminho relativo (abre na árvore); fora: null
  nome: string;
  pasta: string;               // relativa ao cwd, ou `~/…` abreviada
  origens: Partial<Record<Origem, number>>;
  ultimoTs: number;
  primeiroTs: number;
}

export interface EstadoCitados {
  desde: number;
  porCru: Map<string, Citado>;
  lista: Citado[];             // ordenada por ultimoTs desc
}

export const estadoVazio = (): EstadoCitados => ({ desde: 0, porCru: new Map(), lista: [] });

function* strings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) yield* strings(x);
}

export function caminhosCitadosPorNome(eventos: ChatEvent[], nome: string): string[] {
  const caminhos = new Set<string>();
  for (const ev of eventos) {
    for (const texto of strings([ev.text, ev.tool_input, ev.result])) {
      for (const path of parseCodePaths(texto)) {
        if (path.endsWith('/' + nome)) caminhos.add(path);
      }
    }
  }
  return [...caminhos];
}

const _HOME = '/home/';
function expandir(p: string): string {
  return p.startsWith('~/') ? `${_HOME}~${p.slice(1)}` : p; // ponytail: só pra comparar com o cwd; o cru fica intacto
}
function abreviar(p: string): string {
  const i = p.indexOf('/', _HOME.length);
  return p.startsWith(_HOME) && i > 0 ? `~${p.slice(i)}` : p;
}

function classificar(cru: string, cwd: string): Pick<Citado, 'relativo' | 'nome' | 'pasta'> {
  const base = cwd.replace(/\/+$/, '');
  const abs = expandir(cru);
  let relativo: string | null = null;
  if (!abs.startsWith('/')) relativo = abs.replace(/^\.\//, '');
  else if (abs === base || abs.startsWith(base + '/')) relativo = abs.slice(base.length + 1);
  // `../x` sai do cwd: fora
  if (relativo !== null && relativo.split('/').includes('..')) relativo = null;
  const partes = (relativo ?? abreviar(abs)).split('/');
  const nome = partes.pop() ?? cru;
  return { relativo, nome, pasta: partes.join('/') || (relativo !== null ? '.' : '') };
}

function origemDe(ev: ChatEvent): Origem {
  if (ev.kind === 'user_msg') return 'voce';
  if (ev.kind === 'assistant_msg') return 'citado';
  const t = ev.tool_name ?? '';
  return (_TOOLS.has(t) ? t : 'tool') as Origem;
}

function* caminhosDe(ev: ChatEvent): Generator<string> {
  if (ev.kind === 'tool_use') {
    for (const s of strings(ev.tool_input)) yield* parseCodePaths(s);
  } else if ((ev.kind === 'user_msg' || ev.kind === 'assistant_msg') && ev.text) {
    yield* parseCodePaths(ev.text);
  }
}

// Incremental: processa só `eventos[desde..]` e devolve o estado NOVO (o antigo não é mutado).
// Re-varrer 5k eventos a cada tick do SSE é o erro que o deriveActivity do Chat já documenta.
export function acumularCitados(estado: EstadoCitados, eventos: ChatEvent[], desde: number, cwd: string): EstadoCitados {
  const porCru = new Map(estado.porCru);
  for (let i = desde; i < eventos.length; i++) {
    const ev = eventos[i];
    const ts = ev.ts ?? 0;
    const origem = origemDe(ev);
    for (const cru of caminhosDe(ev)) {
      const atual = porCru.get(cru);
      if (atual) {
        const c = { ...atual, origens: { ...atual.origens } };
        c.origens[origem] = (c.origens[origem] ?? 0) + 1;
        c.ultimoTs = Math.max(c.ultimoTs, ts);
        c.primeiroTs = Math.min(c.primeiroTs, ts);
        porCru.set(cru, c);
      } else {
        porCru.set(cru, { cru, ...classificar(cru, cwd), origens: { [origem]: 1 }, ultimoTs: ts, primeiroTs: ts });
      }
    }
  }
  const lista = [...porCru.values()].sort((a, b) => b.ultimoTs - a.ultimoTs);
  return { desde: eventos.length, porCru, lista };
}
