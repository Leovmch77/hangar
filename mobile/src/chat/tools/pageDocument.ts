import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';
import type { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import {
  baseOf, fetchPageSource, fileAuthHeader, pageFetchState, pageUrls, themedPageDocument, themeVariables, type HtmlPageRef, type PageFetchState, type ThemeTokens,
} from '@hangar/core';
import { useServers } from '../../stores/servers';
import { toast } from '../../ui/Toast';

export type ThemeParams = { theme: 'dark' | 'light'; styles: { variables: Record<string, string> } };

// Nome da variável da página → token do app (o mesmo mapa da PWA). Fonte fica com a padrão da
// página: as do app não são nomes de CSS.
const tokenVars = (t: ThemeTokens): Record<string, string> => ({
  '--foreground': t.text.primary, '--muted-foreground': t.text.muted, '--surface': t.bg.surface,
  '--border': t.border.default, '--accent': t.accent.base, '--accent-foreground': t.text.inverse,
  '--danger': t.status.error, '--warning': t.status.warning, '--success': t.status.success,
  '--code-background': t.bg.base, '--chart-1': t.chart[0], '--chart-2': t.chart[1], '--chart-3': t.chart[2],
  '--chart-4': t.chart[3],
});

const applyScript = (p: ThemeParams) => `window.__hangarApply&&window.__hangarApply(${JSON.stringify(p)});true`;

// Só o documento inicial carrega; qualquer navegação da página (link, location, window.open) para.
// ponytail: no Android a lib libera a navegação se o JS não responder em 250 ms (JS travado deixa
// passar); fechar isso de vez exige filtro nativo.
export const onlyInitial = (r: { url: string }) => r.url === 'about:blank' || r.url.startsWith('about:srcdoc');

// A lista desmonta o cartão fora da tela: voltar a ele não busca de novo nem pula de altura.
// ponytail: teto fixo de entradas, a mais antiga sai primeiro.
const CACHE_MAX = 20;
const cache = new Map<string, { html: string; reported: number | null }>();
function remember(key: string, entry: { html: string; reported: number | null }) {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

// Gesto do leitor vale por pouco tempo e por um link só: a página não abre endereço sozinha.
const GESTURE_MS = 2000;

// Altura nova da página: devolve se mudou, e guarda no cache para o cartão voltar sem pular.
export function rememberReported(key: string, height: number): boolean {
  const hit = cache.get(key);
  if (hit?.reported === height) return false;
  if (hit) hit.reported = height;
  return true;
}

// Link só logo depois de um toque do leitor, e um por toque: a página não abre endereço sozinha.
function openPageLink(url: string, touchedAt: { current: number }): void {
  const recent = Date.now() - touchedAt.current < GESTURE_MS;
  touchedAt.current = 0;
  if (!recent) return;
  Linking.openURL(url).catch((err: unknown) => toast.erro(err instanceof Error ? err.message : String(err)));
}

// A WebView da página, no cartão e na tela cheia: sem tema próprio, o do app entra ao carregar e a cada troca, sem
// recarregar; `touched` marca o toque do leitor que libera um link.
export function usePageWebView(params: ThemeParams, own: boolean) {
  const web = useRef<WebView>(null);
  const touchedAt = useRef(0);
  const applyTheme = useCallback(() => { if (!own) web.current?.injectJavaScript(applyScript(params)); }, [params, own]);
  useEffect(applyTheme, [applyTheme]);
  const touched = useCallback(() => { touchedAt.current = Date.now(); }, []);
  const openLink = useCallback((url: string) => openPageLink(url, touchedAt), []);
  return { web, applyTheme, touched, openLink };
}

// Documento da página com o tema do app: a mesma busca e o mesmo cache para o cartão e a tela cheia.
export function usePageDocument(page: HtmlPageRef, sessionName: string, serverId?: string) {
  const { theme, rt } = useUnistyles();
  // A página mora na máquina da sessão, que nem sempre é a ativa.
  const server = useServers((s) => (serverId ? s.servers.find((x) => x.id === serverId) ?? null : s.active()));
  // Primitivos: o objeto do servidor muda a cada atualização da store e refaria a busca.
  const base = server ? baseOf(server) : null;
  const auth = server ? fileAuthHeader(server).Authorization ?? '' : '';
  const key = `${server?.id ?? ''}|${sessionName}|${page.id}`;
  const [state, setState] = useState<PageFetchState>(() => (cache.has(key) ? 'ready' : 'loading'));
  const [raw, setRaw] = useState(() => cache.get(key)?.html ?? '');
  const [reported, setReported] = useState<number | null>(() => cache.get(key)?.reported ?? null);

  const scheme = rt.themeName === 'light' ? 'light' : 'dark';
  const params = useMemo<ThemeParams>(() => {
    const vars = tokenVars(theme.tokens);
    return { theme: scheme, styles: { variables: themeVariables((n) => vars[n] ?? '') } };
  }, [scheme, theme.tokens]);
  const paramsRef = useRef(params);
  useEffect(() => { paramsRef.current = params; }, [params]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    cache.delete(key);
    setState('loading');
    setReported(null);
    try {
      if (!base) throw new Error('no-server');
      const r = await fetch(pageUrls(base, sessionName, page.id).raw, { headers: { Authorization: auth } });
      // O 404 da página vencida traz o código; sem ele (convidado, rota ausente) é erro.
      const code = r.status === 404 ? await r.json().then((b) => b?.detail?.code, () => null) : null;
      const next = pageFetchState(r.status, code);
      const text = next === 'ready' ? await r.text() : '';
      if (n !== seq.current) return;
      if (next === 'ready') remember(key, { html: text, reported: null });
      setRaw(text);
      setState(next);
    } catch {
      if (n === seq.current) setState(pageFetchState('network'));
    }
  }, [base, auth, key, sessionName, page.id]);

  useEffect(() => {
    // Página trocada: o que estava na tela era da anterior.
    const hit = cache.get(key);
    if (hit) { seq.current++; setRaw(hit.html); setReported(hit.reported); setState('ready'); }
    else void load();
    return () => { seq.current++; };
  }, [key, load]);

  // Tema próprio: a página fica como foi desenhada, sem as cores do app.
  const doc = useMemo(() => (raw && !page.ownTheme ? themedPageDocument(raw, paramsRef.current.theme, paramsRef.current.styles.variables) : raw), [raw, page.ownTheme]);
  // Fonte: a página como o agente escreveu (o servidor tira o tema e a ponte). Erro sobe para a tela mostrar.
  const loadSource = useCallback(async () => {
    if (!base) throw new Error('no-server');
    return fetchPageSource(pageUrls(base, sessionName, page.id).source, { Authorization: auth });
  }, [base, auth, sessionName, page.id]);
  return { key, state, doc, reported, setReported, load, params, loadSource };
}
