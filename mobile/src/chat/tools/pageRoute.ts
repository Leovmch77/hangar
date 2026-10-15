import type { HtmlPageRef } from '@hangar/core';

// Tela cheia da página: só o que a tela precisa para buscar o documento e mostrar o título.
export function pageScreenHref(serverId: string, sessionName: string, page: HtmlPageRef): string {
  const q = new URLSearchParams({ id: page.id, title: page.title });
  if (page.ownTheme) q.set('own', '1');
  return `/s/${serverId}/${sessionName}/page?${q.toString()}`;
}

// Parâmetro de rota do expo-router: repetido vira lista, e vale o primeiro.
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export function pageFromParams(p: { id?: string | string[]; title?: string | string[]; own?: string | string[] }): HtmlPageRef | null {
  const id = one(p.id);
  if (!id) return null;
  return { id, title: one(p.title) || id, height: null, heights: {}, ownTheme: one(p.own) === '1' };
}
