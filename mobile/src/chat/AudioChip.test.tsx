// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLiveVoiceAudioActive, useVoiceAudioState } from '../features/voice/audioSession';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  player: { play: vi.fn(), pause: vi.fn(), replace: vi.fn(), seekTo: vi.fn() },
  status: { playing: false, duration: 10, currentTime: 3, error: null as string | null },
}));
vi.mock('expo-audio', () => ({
  useAudioPlayer: () => h.player,
  useAudioPlayerStatus: () => h.status,
}));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../paraglide/messages', () => ({
  anexos_pausar: ({ nome }: { nome: string }) => `pause-${nome}`,
  anexos_tocar: ({ nome }: { nome: string }) => `play-${nome}`,
  visor_nao_carregou: () => 'audio-error',
  comum_carregando: () => 'loading',
  board_remover_anexo: () => 'remove-attachment',
}));

import { AudioChip } from './AudioChip';

const roots: Root[] = [];
async function mount(props: Partial<Parameters<typeof AudioChip>[0]> = {}) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(AudioChip, {
    uri: 'https://a.test/audio.m4a', headers: { Authorization: 'Bearer token' }, name: 'ditado.m4a', ...props,
  })));
  return { container, root };
}
const button = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button')!;

beforeEach(() => {
  useVoiceAudioState.setState({ voiceActive: false, dictations: 0 });
  vi.resetAllMocks();
  Object.assign(h.status, { playing: false, duration: 10, currentTime: 3, error: null });
  h.player.play.mockImplementation(() => { h.status.playing = true; });
  h.player.pause.mockImplementation(() => { h.status.playing = false; });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  useVoiceAudioState.setState({ voiceActive: false, dictations: 0 });
});

describe('AudioChip — coexistência com voz ao vivo', () => {
  it('pausa o áudio atual, bloqueia Play e só retoma por outro toque após a chamada', async () => {
    const { container } = await mount();
    await act(async () => button(container).click());
    expect(h.player.replace).toHaveBeenCalledExactlyOnceWith({
      uri: 'https://a.test/audio.m4a', headers: { Authorization: 'Bearer token' },
    });
    expect(h.player.play).toHaveBeenCalledTimes(1);
    act(() => setLiveVoiceAudioActive(true));
    expect(h.player.pause).toHaveBeenCalledTimes(1);
    expect(button(container).disabled).toBe(true);
    await act(async () => button(container).click());
    expect(h.player.play).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('ditado.m4a');
    expect(container.textContent).toContain('0:03 / 0:10');
    act(() => setLiveVoiceAudioActive(false));
    expect(button(container).disabled).toBe(false);
    expect(h.player.play).toHaveBeenCalledTimes(1);
    await act(async () => button(container).click());
    expect(h.player.play).toHaveBeenCalledTimes(2);
    expect(h.player.replace).toHaveBeenCalledTimes(1);
  });

  it('recusa toque já enfileirado antes de publicar o botão desabilitado', async () => {
    const { container } = await mount();
    act(() => {
      setLiveVoiceAudioActive(true);
      button(container).click();
    });
    expect(button(container).disabled).toBe(true);
    expect(h.player.play).not.toHaveBeenCalled();
    expect(h.player.replace).not.toHaveBeenCalled();
  });

  it('pausa mesmo se a chamada começar e terminar antes do próximo render', async () => {
    const { container } = await mount();
    await act(async () => button(container).click());
    act(() => {
      setLiveVoiceAudioActive(true);
      setLiveVoiceAudioActive(false);
    });
    expect(h.player.pause).toHaveBeenCalledTimes(1);
    expect(h.player.play).toHaveBeenCalledTimes(1);
  });

  it('monta bloqueado durante a chamada sem esconder o conteúdo nem seu erro', async () => {
    setLiveVoiceAudioActive(true);
    h.status.error = 'decoder failed';
    const { container } = await mount();
    expect(button(container).disabled).toBe(true);
    expect(container.textContent).toContain('ditado.m4a');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('audio-error (decoder failed)');
    expect(h.player.play).not.toHaveBeenCalled();
    expect(h.player.replace).not.toHaveBeenCalled();
  });

  it('remove a observação da chamada quando o tocador desmonta', async () => {
    const { root } = await mount();
    await act(async () => root.render(null));
    act(() => setLiveVoiceAudioActive(true));
    expect(h.player.pause).not.toHaveBeenCalled();
  });
});


describe('AudioChip — remoção no campo', () => {
  it('pausa e remove somente o áudio escolhido', async () => {
    const onRemove = vi.fn();
    const { container } = await mount({ onRemove });
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="remove-attachment: ditado.m4a"]');
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(h.player.pause).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith();
    expect(h.player.play).not.toHaveBeenCalled();
  });

  it('não oferece remover em bolha da conversa e bloqueia no envio', async () => {
    const { container, root } = await mount();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    const onRemove = vi.fn();
    await act(async () => root.render(createElement(AudioChip, { uri: 'file:///ditado.m4a', name: 'ditado.m4a', onRemove, disabled: true })));
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="remove-attachment: ditado.m4a"]')!;
    expect(remove.disabled).toBe(true);
    expect(button(container).disabled).toBe(true);
    await act(async () => remove.click());
    expect(onRemove).not.toHaveBeenCalled();
  });
});
