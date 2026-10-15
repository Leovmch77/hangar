import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ leavePair: vi.fn(), undo: vi.fn(), erro: vi.fn() }));
vi.mock('@hangar/core', async (original) => ({ ...await original<typeof import('@hangar/core')>(), leavePair: h.leavePair }));
vi.mock('../../stores/sessions', () => ({ markLeavingPair: () => h.undo }));
vi.mock('../../ui/Toast', () => ({ toast: { ok: vi.fn(), erro: h.erro } }));
vi.mock('../../paraglide/messages', () => ({ par_falhou_saida: () => 'par_falhou_saida' }));
import { leaveExternal } from './leaveExternal';

const server = { id: 's1', label: 'casa', baseUrl: 'http://x', token: 't' };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('leaveExternal', () => {
  beforeEach(() => { h.leavePair.mockReset(); h.undo.mockReset(); h.erro.mockReset(); });

  it('ok:false tira a marca e avisa', async () => {
    h.leavePair.mockResolvedValue({ ok: false, error: { code: 'x_sem_traducao' } });
    leaveExternal('casa', 'api', server);
    await flush();
    expect(h.undo).toHaveBeenCalled();
    expect(h.erro).toHaveBeenCalledWith('x_sem_traducao');
  });

  it('ok:false sem motivo usa a frase de falha', async () => {
    h.leavePair.mockResolvedValue({ ok: false });
    leaveExternal('casa', 'api', server);
    await flush();
    expect(h.erro).toHaveBeenCalledWith('par_falhou_saida');
  });

  it('erro lançado tira a marca e mostra a mensagem', async () => {
    h.leavePair.mockRejectedValue(new Error('caiu'));
    leaveExternal('casa', 'api', server);
    await flush();
    expect(h.undo).toHaveBeenCalled();
    expect(h.erro).toHaveBeenCalledWith('caiu');
  });

  it('ok:true mantém a marca e não avisa', async () => {
    h.leavePair.mockResolvedValue({ ok: true });
    leaveExternal('casa', 'api', server);
    await flush();
    expect(h.undo).not.toHaveBeenCalled();
    expect(h.erro).not.toHaveBeenCalled();
  });
});
