import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrewarmReserve, prewarmEligible } from './prewarm';

const server = { id: 'pc', label: 'PC', baseUrl: 'http://pc:8765', token: 't' };
const body = { cwd: '/repo', provider: 'claude' as const, headless: true, model: 'opus' };

function setup() {
  const api = {
    reserve: vi.fn().mockResolvedValue({ id: 'k1', fingerprint: 'f', name: 'repo' }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { api, reserve: new PrewarmReserve(api) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('prewarmEligible', () => {
  it('só Claude sem terminal, sem motor e sem worktree', () => {
    expect(prewarmEligible(body)).toBe(true);
    expect(prewarmEligible({ ...body, headless: false })).toBe(false);
    expect(prewarmEligible({ ...body, provider: 'codex' })).toBe(false);
    expect(prewarmEligible({ ...body, engine: 'gpt' })).toBe(false);
    expect(prewarmEligible({ ...body, branch: 'feat' })).toBe(false);
    expect(prewarmEligible({ ...body, cwd: null })).toBe(false);
  });
});

describe('PrewarmReserve', () => {
  it('pede só depois de 600 ms sem troca, e cada troca recomeça a espera', async () => {
    const { api, reserve } = setup();
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(500);
    reserve.update(server, { ...body, cwd: '/outra' });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.reserve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.reserve).toHaveBeenCalledTimes(1);
    expect(api.reserve).toHaveBeenCalledWith(server, expect.objectContaining({ cwd: '/outra' }), reserve.clientId);
  });

  it('nome digitado não pede reserva nova', async () => {
    const { api, reserve } = setup();
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    reserve.update(server, { ...body, name: 'meu-nome' });
    await vi.advanceTimersByTimeAsync(600);
    expect(api.reserve).toHaveBeenCalledTimes(1);
    expect(api.reserve.mock.calls[0][1]).not.toHaveProperty('name');
  });

  it('renova a cada 30 s com o mesmo corpo', async () => {
    const { api, reserve } = setup();
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.reserve).toHaveBeenCalledTimes(2);
    expect(api.reserve.mock.calls[1][1]).toEqual(api.reserve.mock.calls[0][1]);
  });

  it('take para a renovação antes do envio e entrega a reserva', async () => {
    const { api, reserve } = setup();
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    expect(reserve.take()).toEqual({ id: 'k1', fingerprint: 'f', name: 'repo' });
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.reserve).toHaveBeenCalledTimes(1);
    // A reserva entregue virou sessão: sair da tela não a solta.
    reserve.release();
    expect(api.release).not.toHaveBeenCalled();
  });

  it('corpo trocado depois do PUT: o envio não leva a reserva velha e a solta', async () => {
    const { api, reserve } = setup();
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    reserve.update(server, { ...body, model: 'sonnet' });
    expect(reserve.take()).toBeNull();
    expect(api.release).toHaveBeenCalledWith(server, null, reserve.clientId);
  });

  it('corpo inelegível, servidor trocado ou saída soltam a reserva', async () => {
    const { api, reserve } = setup();
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    reserve.update(server, { ...body, headless: false });
    expect(api.release).toHaveBeenLastCalledWith(server, 'k1', reserve.clientId);

    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    const other = { ...server, id: 'casa', baseUrl: 'http://casa:8765' };
    reserve.update(other, body);
    expect(api.release).toHaveBeenLastCalledWith(server, 'k1', reserve.clientId);

    await vi.advanceTimersByTimeAsync(600);
    reserve.release();
    expect(api.release).toHaveBeenLastCalledWith(other, 'k1', reserve.clientId);
    expect(api.release).toHaveBeenCalledTimes(3);
  });

  it('falha do PUT fica calada, e a criação que falhou volta a reservar', async () => {
    const { api, reserve } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.reserve.mockRejectedValueOnce(new Error('422'));
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    expect(reserve.take()).toBeNull();
    reserve.resume();
    await vi.advanceTimersByTimeAsync(600);
    expect(reserve.take()?.id).toBe('k1');
    expect(warn).toHaveBeenCalled();
  });

  it('recusa 4xx para a renovação até o corpo mudar; 5xx continua renovando', async () => {
    const { api, reserve } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.reserve.mockRejectedValueOnce(Object.assign(new Error('409: conta'), { status: 409 }));
    reserve.update(server, body);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(api.reserve).toHaveBeenCalledTimes(1);
    reserve.update(server, { ...body, model: 'sonnet' });
    await vi.advanceTimersByTimeAsync(600);
    expect(api.reserve).toHaveBeenCalledTimes(2);

    api.reserve.mockRejectedValueOnce(Object.assign(new Error('503: fora'), { status: 503 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.reserve).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.reserve).toHaveBeenCalledTimes(4);
  });
});
