import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi } from './apiEnv';
import {
  forgetVoiceMemory, listVoiceMemory, liveVoiceBarLevel, liveVoiceRms,
  loadLiveVoiceSettings, parseLiveVoiceMessage, saveLiveVoiceSettings,
  type LiveVoiceSettings, type LiveVoiceState,
} from './liveVoice';

const server = { id: 'voice-a', label: 'A', baseUrl: 'https://voice-a.test', token: 'token-a' };
const settings: LiveVoiceSettings = {
  voice: 'sol', codex_account: 'default',
  organizer: { direct: { model: null, effort: 'medium', tier: null }, plan: { model: 'gpt-6.1-sol', effort: 'high', tier: 'fast' } },
};
const reply = { enabled: true, codex: true, jev: false, voices: ['sol'], settings, call: { active: false, client: null } };

export const state: LiveVoiceState = {
  phase: 'live', mode: 'direct', activity: 'idle', draft: null, error: null, plan: null,
  effective: { model: 'gpt-6.1-sol', effort: 'medium', tier: null }, context: { used: 12, window: 200000 },
  limits: { five_hour: { used_percent: 10, resets_at: null }, seven_day: null }, backstage: [],
  thought: '', action: null, followed: [], server: 'A', client: 'mobile', memory: 0, progress: null,
};

beforeEach(() => configureApi({
  getBaseUrl: () => 'https://active-b.test', getToken: () => 'token-b', origin: null,
  onUnauthorized: vi.fn(), createEventSource: () => { throw new Error('unexpected_stream'); },
}));
afterEach(() => vi.restoreAllMocks());

describe('configuração da voz no servidor escolhido', () => {
  it('GET e PUT usam A com B ativo e salvam o objeto inteiro, inclusive null', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(reply))
      .mockResolvedValueOnce(Response.json({ settings }));
    expect(await loadLiveVoiceSettings(server)).toEqual(reply);
    expect(await saveLiveVoiceSettings(server, settings)).toEqual(settings);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toBe('https://voice-a.test/api/voice/settings');
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer token-a' }));
    }
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: JSON.stringify(settings) });
  });

  it('preserva código e detalhe da recusa em vez de trocar por erro genérico', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error_code: 'settings_write_failed', detail: 'disk_full' }, { status: 500 }));
    await expect(saveLiveVoiceSettings(server, settings)).rejects.toMatchObject({
      code: 'settings_write_failed', detail: 'disk_full', status: 500,
    });
  });

  it('rejeita resposta e PUT incompletos de forma visível', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ enabled: true, settings }));
    await expect(loadLiveVoiceSettings(server)).rejects.toMatchObject({ code: 'invalid_response' });
    // A fronteira também se protege de callers JS ou conteúdo persistido inválido.
    const broken = { ...settings, organizer: { direct: settings.organizer.direct } };
    // @ts-expect-error o PUT exige os dois modos
    await expect(saveLiveVoiceSettings(server, broken)).rejects.toMatchObject({ code: 'invalid_body' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lista e apaga a memória de A; lista malformada não vira vazia', async () => {
    const entry = { id: 'm/1', kind: 'preferencia', text: 'curto', learned: '2026-10-15', confirmed: '2026-10-15' };
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ entries: [entry] }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ entries: [{}] }));
    expect(await listVoiceMemory(server)).toEqual([entry]);
    await forgetVoiceMemory(server, 'm/1');
    expect(String(fetch.mock.calls[1][0])).toBe('https://voice-a.test/api/voice/memory/m%2F1');
    expect(fetch.mock.calls[1][1]?.method).toBe('DELETE');
    await expect(listVoiceMemory(server)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('protocolo público e níveis puros', () => {
  it('aceita o retrato completo e não aceita started público ou state incompleto', () => {
    expect(parseLiveVoiceMessage(JSON.stringify({ type: 'state', state }))).toEqual({ type: 'state', state });
    expect(parseLiveVoiceMessage('{')).toBeNull();
    expect(parseLiveVoiceMessage(JSON.stringify({ type: 'started', sdp: 'x' }))).toBeNull();
    expect(parseLiveVoiceMessage(JSON.stringify({ type: 'state', state: { mode: 'direct' } }))).toBeNull();
    expect(parseLiveVoiceMessage(JSON.stringify({ type: 'tool', call: 7, name: 'future_tool', args: {} })))
      .toEqual({ type: 'tool', call: 7, name: 'future_tool', args: {} });
  });

  it('audioLevel é RMS cru; ganho só entra na barra', () => {
    expect(liveVoiceRms({ audioLevel: 0.03 })).toBe(0.03);
    expect(liveVoiceBarLevel(0.03)).toBe(0.16);
    expect(liveVoiceRms({ audioLevel: 0 })).toBe(0);
    expect(liveVoiceRms({ audioLevel: NaN })).toBeNull();
  });

  it('usa delta de energia/duração e distingue falta de amostra de silêncio medido', () => {
    const previous = { totalAudioEnergy: 1, totalSamplesDuration: 10 };
    expect(liveVoiceRms({ totalAudioEnergy: 1.0025, totalSamplesDuration: 11 }, previous)).toBeCloseTo(0.05);
    expect(liveVoiceRms(previous, previous)).toBeNull();
    expect(liveVoiceRms({ totalAudioEnergy: 0, totalSamplesDuration: 1 }, { totalAudioEnergy: 0, totalSamplesDuration: 0 })).toBe(0);
    expect(liveVoiceRms({ totalAudioEnergy: 0.2, totalSamplesDuration: 1 }, previous)).toBeNull();
    expect(liveVoiceRms({})).toBeNull();
  });
});
