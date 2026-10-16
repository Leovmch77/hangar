// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '../../paraglide/runtime';
import { type Credencial, configureLocale } from '@hangar/core';
import { AccountUsage } from './AccountUsage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let locale: 'pt' | 'en' = 'pt';
overwriteGetLocale(() => locale);
configureLocale({ getLocale: () => locale });
const credential = (cota?: Credencial['cota']): Credencial => ({
  id: 'codex:/work', tipo: 'codex', codex_account: 'work', nome: 'Trabalho', nome_natural: 'Trabalho', ativa: true, usos: [], cota,
});
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); locale = 'pt'; vi.restoreAllMocks(); });
async function show(cota?: Credencial['cota']) {
  const container = document.createElement('div');
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(createElement(AccountUsage, { credential: credential(cota) })));
  return container;
}

describe('cota dentro da linha da conta', () => {
  it('mostra janelas, renovação e causa sem trocar os números antigos', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const container = await show({ estado: 'lida', janelas: [
      { rotulo: '5h', pct: 42, reset_ts: 2_000_007_205 },
      { rotulo: '7d', pct: 100, reset_ts: 2_000_172_805 },
      { rotulo: 'sonnet', pct: 23, por_modelo: true },
    ], ts: 1_999_996_400, idade_s: 3600, motivo: 'http-429' });
    expect(container.textContent).toContain('42%');
    expect(container.textContent).toContain('100%');
    expect(container.textContent).toContain('sonnet');
    expect(container.textContent).toContain('23%');
    expect(container.textContent).toContain('em 2 h');
    expect(container.textContent).toContain('em 2 d');
    expect(container.textContent).toContain('limite de consultas');
    expect(container.textContent).toContain('1 h');
  });

  it.each([
    [undefined, 'Cota ausente'],
    [{ estado: 'sem_credencial', janelas: [] }, 'sem cota: precisa entrar'],
    [{ estado: 'expirada', janelas: [], motivo: 'renovacao-falhou' }, 'sem cota: abra uma sessão nela'],
    [{ estado: 'indisponivel', janelas: [], motivo: 'http-503' }, 'Cota indisponível'],
  ] as const)('não inventa porcentagem no estado %j', async (quota, text) => {
    const container = await show(quota as Credencial['cota']);
    expect(container.textContent).toContain(text);
    expect(container.textContent).not.toContain('%');
    if (quota && 'motivo' in quota) expect(container.textContent).not.toContain(quota.motivo);
  });

  it.each(['pt', 'en'] as const)('traduz os motivos da cota em %s sem exibir códigos internos', async language => {
    locale = language;
    const reasons: Array<[NonNullable<Credencial['cota']>['estado'], string, string, string]> = [
      ['expirada', 'renovacao-falhou', 'sem cota: abra uma sessão nela', 'no quota: open a session on it'],
      ['sem_credencial', 'sessao-viva', 'a sessão aberta renova sozinha; o número volta já', 'the open session renews it; the number is back soon'],
      ['sem_credencial', 'future-code', 'sem cota: precisa entrar', 'no quota: needs sign-in'],
      ['indisponivel', 'credencial-ilegivel', 'credencial inválida', 'invalid credential'],
      ['indisponivel', 'http-404', 'a fonte respondeu erro 404', 'the source answered error 404'],
      ['indisponivel', 'formato-desconhecido', 'resposta num formato desconhecido', 'answer in an unknown format'],
      ['indisponivel', 'future-code', 'a leitura falhou', 'the read failed'],
    ];
    for (const [estado, motivo, pt, en] of reasons) {
      const container = await show({ estado, motivo, janelas: [] });
      expect(container.textContent).toContain(language === 'pt' ? pt : en);
      expect(container.textContent).not.toContain(motivo);
    }
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    for (const motivo of ['http-404', 'sessao-viva']) {
      const container = await show({ estado: 'lida', motivo, idade_s: 3600,
        janelas: [{ rotulo: '5h', pct: 42, reset_ts: 2_000_007_205 }] });
      expect(container.textContent).toContain('42%');
      expect(container.textContent).toContain(language === 'pt' ? 'em 2 h' : 'in 2h');
      expect(container.textContent).toContain('1 h');
      expect(container.textContent).not.toContain(motivo);
      if (motivo === 'http-404') expect(container.textContent).toContain(language === 'pt' ? 'não atualizou: a fonte respondeu erro 404' : 'not updated: the source answered error 404');
      else expect(container.textContent).not.toContain(language === 'pt' ? 'não atualizou' : 'not updated');
    }
  });

  it('usa ts quando a idade não veio do servidor', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const container = await show({ estado: 'lida', janelas: [], ts: 1_999_992_800 });
    expect(container.textContent).toContain('2 h');
  });
});
