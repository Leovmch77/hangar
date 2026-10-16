// @vitest-environment happy-dom
import { act, createElement, createRef, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi, type ChatEvent, type Server, type TtsResposta } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ synth: vi.fn(), output: vi.fn(), player: vi.fn(), play: vi.fn(), remove: vi.fn(),
  toast: vi.fn(), copy: vi.fn(), share: vi.fn() }));
const servers = vi.hoisted(() => ({ activeId: 's2', servers: [] as Server[] }));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(), sintetizarTts: h.synth, getBashOutput: h.output,
}));
vi.mock('../stores/servers', () => ({
  useServers: Object.assign((select: (s: typeof servers) => unknown) => select(servers), { getState: () => servers }),
}));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(), Share: { share: h.share },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: h.copy }));
vi.mock('expo-audio', () => ({ createAudioPlayer: h.player }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Toast', () => ({ toast: { erro: h.toast, ok: () => {} } }));
vi.mock('../ui/Sheet', () => ({
  Sheet: forwardRef(function Sheet({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }, ref) {
    useImperativeHandle(ref, () => ({ present: async () => {} }), []);
    return createElement('div', null, children, createElement('button', { onClick: onDismiss }, 'dismiss'));
  }),
}));
vi.mock('./tools/EditDiff', () => ({ EditDiff: () => null }));
vi.mock('../paraglide/messages', () => Object.fromEntries(
  ('navbar_mais_acoes bubble_copiar bolha_compartilhar bubble_ouvir toast_copiado chat_servidor_removido '
    + 'tool_saida tool_saida_ao_vivo quiet_erro_carregar formato_rodando erro_desconhecido')
    .split(' ').map((key) => [key, () => key]),
));

import { BubbleActions, pararTts } from './BubbleActions';
import { setLiveVoiceAudioActive, useVoiceAudioState } from '../features/voice/audioSession';
import { ToolDetailSheet, type ToolDetailHandle } from './tools/ToolDetailSheet';

const roots: Root[] = [];
async function mount(element: ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}
const button = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const pendingTool: ChatEvent = { kind: 'tool_use', id: 'bash', tool_name: 'Bash', tool_input: { command: 'pwd' } };
const resultOf = () => null;
async function openTool(serverId: string | undefined = 's1') {
  const ref = createRef<ToolDetailHandle>();
  const props = { ref, resultOf, sessionName: 'sess', serverId };
  const mounted = await mount(createElement(ToolDetailSheet, props));
  await act(async () => ref.current!.abrir(pendingTool));
  return { ...mounted, props };
}

beforeEach(() => {
  useVoiceAudioState.setState({ voiceActive: false, dictations: 0 });
  vi.resetAllMocks();
  vi.useFakeTimers();
  servers.activeId = 's2';
  servers.servers = [
    { id: 's1', label: 'A', baseUrl: 'https://a.test', token: 'token-a' },
    { id: 's2', label: 'B', baseUrl: 'https://b.test', token: 'token-b' },
  ];
  configureApi({ getBaseUrl: () => servers.servers.find((s) => s.id === servers.activeId)!.baseUrl,
    getToken: () => servers.servers.find((s) => s.id === servers.activeId)!.token, onUnauthorized: () => {},
    origin: null, createEventSource: () => { throw new Error('unexpected SSE'); } });
  h.player.mockReturnValue({ play: h.play, remove: h.remove, addListener: vi.fn() });
});
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  pararTts();
  useVoiceAudioState.setState({ voiceActive: false, dictations: 0 });
  vi.useRealTimers();
});

describe('ações de áudio durante voz ao vivo', () => {
  it('cala o TTS mesmo se a bolha já saiu da tela e não retoma no fim da chamada', async () => {
    h.synth.mockResolvedValue({ url: '/api/tts/audio/1.mp3' });
    const { container, root } = await mount(createElement(BubbleActions, { text: 'resposta', serverId: 's1', defaultOpen: true }));
    await act(async () => button(container, 'bubble_ouvir').click());
    expect(h.play).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    act(() => setLiveVoiceAudioActive(true));
    expect(h.remove).toHaveBeenCalledTimes(1);
    act(() => setLiveVoiceAudioActive(false));
    expect(h.play).toHaveBeenCalledTimes(1);
  });

  it('recusa Ouvir já enfileirado antes da API; copiar e compartilhar continuam', async () => {
    const { container } = await mount(createElement(BubbleActions, { text: 'resposta', serverId: 's1', defaultOpen: true }));
    act(() => {
      setLiveVoiceAudioActive(true);
      // O DOM ainda mostra o botão habilitado até o React publicar o estado.
      button(container, 'bubble_ouvir').click();
    });
    expect(button(container, 'bubble_ouvir').disabled).toBe(true);
    expect(h.synth).not.toHaveBeenCalled();
    expect(h.player).not.toHaveBeenCalled();
    await act(async () => button(container, 'bubble_copiar').click());
    await act(async () => button(container, 'bolha_compartilhar').click());
    expect(h.copy).toHaveBeenCalledWith('resposta');
    expect(h.share).toHaveBeenCalledWith({ message: 'resposta' });
    expect(h.toast).not.toHaveBeenCalled();
    act(() => setLiveVoiceAudioActive(false));
    expect(button(container, 'bubble_ouvir').disabled).toBe(false);
  });

  it.each([false, true])('descarta síntese anterior à chamada; chamada encerrada=%s', async (ended) => {
    let finish!: (r: TtsResposta) => void;
    h.synth.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = await mount(createElement(BubbleActions, { text: 'resposta', serverId: 's1', defaultOpen: true }));
    await act(async () => button(container, 'bubble_ouvir').click());
    act(() => {
      setLiveVoiceAudioActive(true);
      if (ended) setLiveVoiceAudioActive(false);
    });
    await act(async () => finish({ url: '/api/tts/audio/1.mp3', chars: 8, cached: false, provider: 'local' }));
    expect(h.player).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
    if (!ended) act(() => setLiveVoiceAudioActive(false));
    h.synth.mockResolvedValueOnce({ url: '/api/tts/audio/2.mp3' });
    await act(async () => button(container, 'bubble_ouvir').click());
    expect(h.player).toHaveBeenCalledExactlyOnceWith('https://a.test/api/tts/audio/2.mp3?token=token-a');
    expect(h.play).toHaveBeenCalledTimes(1);
  });
});

describe('ações da conversa usam o servidor da rota', () => {
  it('Ouvir captura A no toque e usa o mesmo objeto no áudio após mudar o ativo', async () => {
    let finish!: (r: TtsResposta) => void;
    h.synth.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const source = servers.servers[0];
    const { container } = await mount(createElement(BubbleActions, { text: 'resposta', serverId: 's1', defaultOpen: true }));
    await act(async () => button(container, 'bubble_ouvir').click());
    expect(h.synth).toHaveBeenCalledExactlyOnceWith({ text: 'resposta' }, source);
    expect(h.synth.mock.calls[0][1]).toBe(source);
    servers.activeId = 's1';
    servers.servers = [{ ...source, baseUrl: 'https://new-a.test', token: 'new-token-a' }, servers.servers[1]];
    await act(async () => finish({ url: '/api/tts/audio/1.mp3', chars: 8, cached: false, provider: 'local' }));
    expect(h.player).toHaveBeenCalledExactlyOnceWith('https://a.test/api/tts/audio/1.mp3?token=token-a');
    expect(h.play).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'removed'])('sem servidor %s não sintetiza nem toca; copiar e compartilhar continuam', async (serverId) => {
    const { container } = await mount(createElement(BubbleActions, { text: 'resposta', serverId, defaultOpen: true }));
    await act(async () => button(container, 'bubble_ouvir').click());
    expect(h.toast).toHaveBeenCalledWith('chat_servidor_removido');
    expect(h.synth).not.toHaveBeenCalled();
    expect(h.player).not.toHaveBeenCalled();
    await act(async () => button(container, 'bubble_copiar').click());
    await act(async () => button(container, 'bolha_compartilhar').click());
    expect(h.copy).toHaveBeenCalledWith('resposta');
    expect(h.share).toHaveBeenCalledWith({ message: 'resposta' });
  });

  it('a saída ao vivo consulta A com B ativo e para quando A sai da lista', async () => {
    h.output.mockResolvedValue('saída de A');
    const { container, root, props } = await openTool();
    expect(h.output).toHaveBeenCalledExactlyOnceWith('sess', 'pwd', servers.servers[0]);
    expect(container.textContent).toContain('saída de A');
    servers.servers = servers.servers.filter((s) => s.id !== 's1');
    await act(async () => root.render(createElement(ToolDetailSheet, props)));
    expect(container.textContent).toContain('chat_servidor_removido');
    expect(container.textContent).not.toContain('saída de A');
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(h.output).toHaveBeenCalledTimes(1);
  });

  it('sem servidor da rota não inicia pedido nem repetição da saída', async () => {
    const { container } = await openTool('removed');
    expect(container.textContent).toContain('chat_servidor_removido');
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(h.output).not.toHaveBeenCalled();
  });

  it('trocar a rota descarta a resposta anterior e fechar a folha cancela o timer', async () => {
    let finish!: (text: string) => void;
    h.output.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue('saída de B');
    const { container, root, props } = await openTool();
    await act(async () => root.render(createElement(ToolDetailSheet, { ...props, sessionName: 'outra', serverId: 's2' })));
    expect(h.output).toHaveBeenLastCalledWith('outra', 'pwd', servers.servers[1]);
    await act(async () => finish('saída antiga de A'));
    expect(container.textContent).toContain('saída de B');
    expect(container.textContent).not.toContain('saída antiga de A');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(h.output).toHaveBeenCalledTimes(2);
  });
});
