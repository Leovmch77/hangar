// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '../../paraglide/runtime';
import { type Credencial, configureLocale } from '@hangar/core';
import { AccountUsage } from './AccountUsage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
overwriteGetLocale(() => 'pt');
configureLocale({ getLocale: () => 'pt' });
const credential = (cota?: Credencial['cota']): Credencial => ({
  id: 'codex:/work', tipo: 'codex', codex_account: 'work', nome: 'Trabalho', nome_natural: 'Trabalho', ativa: true, usos: [], cota,
});
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); vi.restoreAllMocks(); });
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
    [{ estado: 'sem_credencial', janelas: [] }, 'Sem credencial'],
    [{ estado: 'expirada', janelas: [], motivo: 'renovacao-falhou' }, 'Credencial expirada'],
    [{ estado: 'indisponivel', janelas: [], motivo: 'http-503' }, 'Cota indisponível'],
  ] as const)('não inventa porcentagem no estado %j', async (quota, text) => {
    const container = await show(quota as Credencial['cota']);
    expect(container.textContent).toContain(text);
    expect(container.textContent).not.toContain('%');
    if (quota && 'motivo' in quota) expect(container.textContent).toContain(quota.motivo);
  });

  it('usa ts quando a idade não veio do servidor', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const container = await show({ estado: 'lida', janelas: [], ts: 1_999_992_800 });
    expect(container.textContent).toContain('2 h');
  });
});
