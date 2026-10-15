import { describe, expect, it } from 'vitest';
import { pageFromParams, pageScreenHref } from './pageRoute';

const page = { id: 'p1', title: 'Gráfico & vendas', height: null, heights: {}, ownTheme: false };

describe('rota da página em tela cheia', () => {
  it('leva id e título, e o tema próprio só quando há', () => {
    expect(pageScreenHref('srv', 'sessao-1', page)).toBe('/s/srv/sessao-1/page?id=p1&title=Gr%C3%A1fico+%26+vendas');
    expect(pageScreenHref('srv', 'sessao-1', { ...page, ownTheme: true })).toContain('&own=1');
  });

  it('lê os parâmetros de volta; sem id não há página', () => {
    expect(pageFromParams({ id: 'p1', title: 'Gráfico & vendas' })).toEqual(page);
    expect(pageFromParams({ id: ['p1'], title: [''], own: '1' })).toEqual({ ...page, title: 'p1', ownTheme: true });
    expect(pageFromParams({ title: 'x' })).toBeNull();
  });
});
