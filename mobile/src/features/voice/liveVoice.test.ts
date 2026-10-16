import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApi, type LiveVoiceHandlers, type Server } from '@hangar/core';
import { LiveVoiceCall } from './liveVoice';

const RuntimeLogger = (require('react-native-webrtc/lib/commonjs/Logger') as typeof import('react-native-webrtc/lib/typescript/Logger')).default;

const rtc = vi.hoisted(() => {
  class Track {
    kind = 'audio'; enabled = true; readyState = 'live';
    onended: (() => void) | null = null;
    stop = vi.fn(() => { this.enabled = false; this.readyState = 'ended'; });
  }
  class Stream {
    track = new Track();
    getTracks = () => [this.track];
    getAudioTracks = () => [this.track];
    release = vi.fn();
  }
  class Peer {
    static all: Peer[] = [];
    connectionState = 'new';
    onconnectionstatechange: (() => void) | null = null;
    channel = { close: vi.fn() };
    addTrack = vi.fn();
    createDataChannel = vi.fn(() => this.channel);
    createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
    setLocalDescription = vi.fn(async (_sdp: unknown) => {});
    setRemoteDescription = vi.fn(async (_sdp: unknown) => {});
    getStats = vi.fn(async () => new Map<string, unknown>([
      ['mic', { id: 'mic', type: 'media-source', kind: 'audio', audioLevel: 0.03 }],
      ['speaker', { id: 'speaker', type: 'inbound-rtp', kind: 'audio', audioLevel: 0.02 }],
    ]));
    close = vi.fn(() => { this.connectionState = 'closed'; });
    constructor() { Peer.all.push(this); }
    connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  }
  return {
    Peer, Stream, getUserMedia: vi.fn<() => Promise<Stream>>(),
    nativeStart: vi.fn<() => Promise<void>>(), nativeStop: vi.fn<() => Promise<void>>(),
    platform: { OS: 'ios', Version: 18 }, requestPermission: vi.fn<(permission: string) => Promise<string>>(),
    clock: undefined as ReturnType<typeof setInterval> | undefined,
    ticks: new Set<() => void>(),
    listeners: new Set<(event: { reason: string }) => void>(), removes: [] as ReturnType<typeof vi.fn>[],
  };
});
vi.mock('react-native-webrtc', () => ({ RTCPeerConnection: rtc.Peer, mediaDevices: { getUserMedia: rtc.getUserMedia } }));
vi.mock('react-native', () => ({
  Platform: rtc.platform,
  PermissionsAndroid: { PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS', BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT' },
    RESULTS: { GRANTED: 'granted' }, request: rtc.requestPermission },
}));
vi.mock('../../../modules/live-voice-audio', () => ({ default: {
  start: rtc.nativeStart, stop: rtc.nativeStop,
  addListener: (name: string, callback: (event?: { reason: string }) => void) => {
    const listeners = name === 'tick' ? rtc.ticks : rtc.listeners;
    listeners.add(callback);
    const remove = vi.fn(() => { listeners.delete(callback); });
    rtc.removes.push(remove);
    return { remove };
  },
} }));

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  messages: Record<string, unknown>[] = [];
  send = vi.fn((data: string) => { this.messages.push(JSON.parse(data)); });
  close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string) { Socket.all.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const server: Server = { id: 'a', label: 'A', baseUrl: 'https://a.test', token: 'token-a' };
const calls: LiveVoiceCall[] = [];
function makeCall() {
  const handlers: LiveVoiceHandlers = {
    phase: vi.fn(), state: vi.fn(), failed: vi.fn(), taken: vi.fn(), levels: vi.fn(),
    switchTo: vi.fn(() => true), actions: vi.fn(() => [{ id: 'sessions', label: 'sessions', description: 'list' }]),
    runAction: vi.fn(() => true as const),
  };
  const call = new LiveVoiceCall(handlers);
  calls.push(call);
  return { call, handlers };
}
async function openCall() {
  const value = makeCall();
  await value.call.start(server, { server: '', name: 'chat' });
  const socket = Socket.all.at(-1)!;
  const pc = rtc.Peer.all.at(-1)!;
  socket.open();
  return { ...value, socket, pc };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('WebSocket', Socket);
  rtc.Peer.all = []; Socket.all = [];
  rtc.getUserMedia.mockReset().mockImplementation(async () => new rtc.Stream());
  rtc.platform.OS = 'ios'; rtc.platform.Version = 18;
  rtc.requestPermission.mockReset().mockResolvedValue('granted');
  rtc.nativeStart.mockReset().mockImplementation(async () => {
    if (rtc.clock === undefined) rtc.clock = setInterval(() => { for (const tick of rtc.ticks) tick(); }, 100);
  });
  rtc.nativeStop.mockReset().mockImplementation(async () => { clearInterval(rtc.clock); rtc.clock = undefined; });
  rtc.listeners.clear(); rtc.ticks.clear(); rtc.removes = [];
  configureApi({ getBaseUrl: () => 'https://active-b.test', getToken: () => 'token-b', origin: null,
    onUnauthorized: vi.fn(), createEventSource: () => { throw new Error('unexpected_stream'); } });
});
afterEach(async () => {
  for (const call of calls.splice(0)) await call.stop();
  clearInterval(rtc.clock); rtc.clock = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('logs WebRTC pela abertura pública da chamada', () => {
  let previousDebug: string | undefined;
  beforeEach(() => { previousDebug = process.env.DEBUG; });
  afterEach(() => {
    RuntimeLogger.enable(previousDebug ?? '');
    if (previousDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previousDebug;
  });

  it('release bloqueia DEBUG, mas mantém INFO, WARN e ERROR do logger real', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    RuntimeLogger.enable(`${RuntimeLogger.ROOT_PREFIX}:*`);
    const logger = new RuntimeLogger('pc');
    vi.stubGlobal('__DEV__', false);
    const { call, handlers } = makeCall();
    await call.start(server, null);
    expect(handlers.failed).not.toHaveBeenCalled();
    logger.debug('getStats-release-marker');
    logger.info('info-release-marker');
    logger.warn('warn-release-marker');
    logger.error('error-release-marker');
    const printed = output.mock.calls.map(args => args.join(' ')).join('\n');
    expect(printed).not.toContain('getStats-release-marker');
    expect(printed).toContain('info-release-marker');
    expect(printed).toContain('warn-release-marker');
    expect(printed).toContain('error-release-marker');
  });

  it('desenvolvimento conserva DEBUG e não altera a configuração do logger', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    RuntimeLogger.enable(`${RuntimeLogger.ROOT_PREFIX}:*`);
    const logger = new RuntimeLogger('pc');
    const enable = vi.spyOn(RuntimeLogger, 'enable');
    vi.stubGlobal('__DEV__', true);
    const { call, handlers } = makeCall();
    await call.start(server, null);
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    logger.debug('getStats-dev-marker');
    expect(output.mock.calls.map(args => args.join(' ')).join('\n')).toContain('getStats-dev-marker');
  });
});

describe('LiveVoiceCall público', () => {
  it('liga A com B ativo, captura só áudio e anuncia apenas as ferramentas atendidas', async () => {
    const { socket, pc, call } = await openCall();
    expect(socket.url).toBe('wss://a.test/api/voice?token=token-a');
    expect(rtc.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(rtc.nativeStart).toHaveBeenCalledWith(expect.objectContaining({ title: expect.any(String), body: expect.any(String), stopLabel: expect.any(String) }));
    const stream = await rtc.getUserMedia.mock.results[0].value;
    expect(stream.track.enabled).toBe(false);
    expect(pc.createDataChannel).toHaveBeenCalledWith('oai-events');
    expect(pc.channel.close).not.toHaveBeenCalled();
    expect(socket.messages[0]).toMatchObject({ type: 'hello', client: 'mobile', screen: { server: '', name: 'chat' },
      caps: ['switch_session', 'hangar_actions', 'hangar_action'] });
    expect(socket.messages[1]).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    pc.connect();
    expect(stream.track.enabled).toBe(true);
    expect(socket.messages).toContainEqual({ type: 'live' });
    await call.stop();
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(pc.close).toHaveBeenCalledTimes(1);
    expect(pc.channel.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(rtc.nativeStop).toHaveBeenCalledTimes(1);
    expect(rtc.removes.every(remove => remove.mock.calls.length === 1)).toBe(true);
  });

  it('Android 33 exige notificação antes de abrir microfone ou serviço', async () => {
    rtc.platform.OS = 'android'; rtc.platform.Version = 33;
    rtc.requestPermission.mockResolvedValue('denied');
    const { call, handlers } = makeCall();
    await call.start(server, null);
    expect(rtc.requestPermission).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS');
    expect(rtc.getUserMedia).not.toHaveBeenCalled();
    expect(rtc.nativeStart).not.toHaveBeenCalled();
    expect(handlers.failed).toHaveBeenCalledWith('notifications_permission', undefined);
  });

  it('Android 32 pede Bluetooth, mas não notificação; iOS não pede nenhum dos dois', async () => {
    rtc.platform.OS = 'android'; rtc.platform.Version = 32;
    const { call } = await openCall();
    expect(rtc.requestPermission).toHaveBeenCalledExactlyOnceWith('android.permission.BLUETOOTH_CONNECT');
    expect(rtc.requestPermission).not.toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS');
    await call.stop();
    rtc.requestPermission.mockClear();
    rtc.platform.OS = 'ios'; rtc.platform.Version = 18;
    await openCall();
    expect(rtc.requestPermission).not.toHaveBeenCalled();
  });

  it('Android anterior a 31 não pede Bluetooth nem notificação', async () => {
    rtc.platform.OS = 'android'; rtc.platform.Version = 30;
    await openCall();
    expect(rtc.requestPermission).not.toHaveBeenCalled();
  });

  it.each(['granted', 'denied', 'never_ask_again'])('Bluetooth %s não impede a chamada e resolve antes da captura', async (permission) => {
    rtc.platform.OS = 'android'; rtc.platform.Version = 31;
    const pending = deferred<string>(), entered = deferred<void>();
    rtc.requestPermission.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const { call, handlers } = makeCall();
    const starting = call.start(server, null);
    await entered.promise;
    expect(rtc.requestPermission).toHaveBeenCalledWith('android.permission.BLUETOOTH_CONNECT');
    expect(rtc.getUserMedia).not.toHaveBeenCalled();
    expect(rtc.nativeStart).not.toHaveBeenCalled();
    pending.resolve(permission);
    await starting;
    expect(rtc.getUserMedia).toHaveBeenCalledTimes(1);
    expect(rtc.nativeStart).toHaveBeenCalledTimes(1);
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(1);
  });

  it('cancelar enquanto pede Bluetooth impede captura e serviço após a resposta tardia', async () => {
    rtc.platform.OS = 'android'; rtc.platform.Version = 31;
    const pending = deferred<string>(), entered = deferred<void>();
    rtc.requestPermission.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const { call, handlers } = makeCall();
    const starting = call.start(server, null);
    await entered.promise;
    await call.stop();
    pending.resolve('granted');
    await starting;
    expect(rtc.getUserMedia).not.toHaveBeenCalled();
    expect(rtc.nativeStart).not.toHaveBeenCalled();
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(0);
  });

  it('exceção ao pedir Bluetooth é visível sem virar erro de notificação', async () => {
    rtc.platform.OS = 'android'; rtc.platform.Version = 33;
    rtc.requestPermission.mockImplementation(async permission => {
      if (permission === 'android.permission.BLUETOOTH_CONNECT') throw new Error('bluetooth_request_failed');
      return 'granted';
    });
    const { call, handlers } = makeCall();
    await call.start(server, null);
    expect(handlers.failed).toHaveBeenCalledExactlyOnceWith('failed', 'bluetooth_request_failed');
    expect(rtc.getUserMedia).not.toHaveBeenCalled();
    expect(rtc.nativeStart).not.toHaveBeenCalled();
  });

  it('desligar com captura pendente libera a mídia tardia sem conectar', async () => {
    const pending = deferred<InstanceType<typeof rtc.Stream>>(), entered = deferred<void>();
    rtc.getUserMedia.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const { call, handlers } = makeCall();
    const starting = call.start(server, null);
    await entered.promise;
    await call.stop();
    const stream = new rtc.Stream(); pending.resolve(stream);
    await starting;
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(Socket.all).toHaveLength(0);
    expect(handlers.failed).not.toHaveBeenCalled();
  });

  it('answer tardia da tentativa antiga não derruba nem muda a chamada nova', async () => {
    const { call, socket, pc, handlers } = await openCall();
    const answer = deferred<void>();
    pc.setRemoteDescription.mockReturnValueOnce(answer.promise);
    const oldMessage = socket.onmessage!;
    socket.receive({ type: 'answer', sdp: 'old-answer' });
    await call.start(server, null);
    const current = Socket.all.at(-1)!; current.open();
    rtc.Peer.all.at(-1)!.connect();
    answer.reject(new Error('closed_peer'));
    await Promise.resolve(); await Promise.resolve();
    oldMessage({ data: JSON.stringify({ type: 'closed' }) });
    expect(current.close).not.toHaveBeenCalled();
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(handlers.phase).toHaveBeenLastCalledWith('live');
  });

  it('RMS enviado é cru; barra tem ganho e mudo manda zero mesmo com stats antigos', async () => {
    const { call, socket, pc, handlers } = await openCall(); pc.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.messages).toContainEqual({ type: 'level', input: 0.03 });
    expect(handlers.levels).toHaveBeenLastCalledWith({ input: 0.16, output: 0.1 });
    call.setMuted(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.messages.at(-1)).toEqual({ type: 'level', input: 0 });
    expect(handlers.levels).toHaveBeenLastCalledWith({ input: 0, output: 0.1 });
  });

  it('mudo envia zero conhecido mesmo com getStats anterior ainda pendente', async () => {
    const { call, socket, pc, handlers } = await openCall();
    const pending = deferred<Map<string, unknown>>();
    pc.getStats.mockReturnValue(pending.promise);
    pc.connect();
    await vi.advanceTimersByTimeAsync(100);
    call.setMuted(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(socket.messages).toContainEqual({ type: 'level', input: 0 });
    expect(handlers.failed).not.toHaveBeenCalled();
    pending.resolve(new Map());
    await vi.advanceTimersByTimeAsync(0);
  });

  it('delta de energia mede entrada/saída sem inventar zero na primeira amostra', async () => {
    const { pc, socket } = await openCall();
    pc.getStats.mockResolvedValueOnce(new Map([
      ['mic', { id: 'mic', type: 'media-source', kind: 'audio', totalAudioEnergy: 1, totalSamplesDuration: 10 }],
      ['speaker', { id: 'speaker', type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 2, totalSamplesDuration: 10 }],
    ])).mockResolvedValueOnce(new Map([
      ['mic', { id: 'mic', type: 'media-source', kind: 'audio', totalAudioEnergy: 1.0025, totalSamplesDuration: 11 }],
      ['speaker', { id: 'speaker', type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 2.01, totalSamplesDuration: 11 }],
    ]));
    pc.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.messages.filter(m => m.type === 'level')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.messages.find(m => m.type === 'level')?.input).toBeCloseTo(0.05);
  });

  it('entrada medida com saída ainda ausente mantém a chamada sem erro', async () => {
    const { pc, socket, handlers } = await openCall();
    pc.getStats.mockResolvedValue(new Map([
      ['mic', { id: 'mic', type: 'media-source', kind: 'audio', audioLevel: 0 }],
    ]));
    pc.connect();
    await vi.advanceTimersByTimeAsync(12000);
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(socket.messages).toContainEqual({ type: 'level', input: 0 });
    expect(handlers.levels).toHaveBeenLastCalledWith({ input: 0, output: 0 });
  });

  it('stats sem medição viram erro visível, sem level inventado', async () => {
    const { pc, socket, handlers } = await openCall();
    pc.getStats.mockResolvedValue(new Map()); pc.connect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(handlers.failed).toHaveBeenCalledWith('audio_levels_unavailable', expect.any(String));
    expect(socket.messages.some(m => m.type === 'level')).toBe(false);
    expect(socket.messages).toContainEqual({ type: 'stop' });
  });

  it('getStats rejeitado enquanto mudo conserva zero conhecido sem erro de entrada', async () => {
    const { call, pc, socket, handlers } = await openCall();
    pc.getStats.mockRejectedValue(new Error('unavailable-while-muted'));
    pc.connect(); call.setMuted(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(socket.messages).toContainEqual({ type: 'level', input: 0 });
    expect(handlers.failed).not.toHaveBeenCalled();
  });

  it('getStats rejeitado mostra causa estável sem vazar IDs do diagnóstico nativo', async () => {
    const { pc, handlers } = await openCall();
    pc.getStats.mockRejectedValue(new Error('track-secret-native-id'));
    pc.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(handlers.failed).toHaveBeenCalledExactlyOnceWith('audio_levels_unavailable', 'getStats_failed');
  });

  it('ping parte da criação do socket e corta VPN que nunca abriu em 30s', async () => {
    const { call, handlers } = makeCall();
    await call.start(server, null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(handlers.failed).toHaveBeenCalledWith('connection_lost', undefined);
    expect(Socket.all[0].close).toHaveBeenCalledTimes(1);
    expect(Socket.all[0].messages.some(m => m.type === 'stop')).toBe(false);
  });

  it('ping a cada 10s e pong renova o prazo sem fluxo de áudio no WS', async () => {
    const { socket, handlers, pc } = await openCall();
    pc.connect();
    await vi.advanceTimersByTimeAsync(20000);
    expect(socket.messages.filter(m => m.type === 'ping')).toHaveLength(2);
    socket.receive({ type: 'pong' });
    await vi.advanceTimersByTimeAsync(20000);
    expect(handlers.failed).not.toHaveBeenCalled();
  });

  it('taken limpa sem stop e invalida callbacks guardados', async () => {
    const { socket, handlers } = await openCall();
    const oldClose = socket.onclose!;
    socket.receive({ type: 'taken' }); oldClose();
    await Promise.resolve(); await Promise.resolve();
    expect(handlers.taken).toHaveBeenCalledTimes(1);
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(socket.messages.some(m => m.type === 'stop')).toBe(false);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('erro fatal seguido de closed/close conserva causa e detalhe', async () => {
    const { socket, handlers } = await openCall();
    const oldMessage = socket.onmessage!, oldClose = socket.onclose!;
    socket.receive({ type: 'error', code: 'account_missing', detail: 'chosen-account' });
    oldMessage({ data: JSON.stringify({ type: 'closed' }) }); oldClose();
    expect(handlers.failed).toHaveBeenCalledExactlyOnceWith('account_missing', 'chosen-account');
    expect(socket.messages.some(m => m.type === 'stop')).toBe(false);
  });

  it.each(['error', 'close'] as const)('socket %s mostra falha sem encerrar organizador', async (event) => {
    const { socket, handlers } = await openCall();
    if (event === 'error') socket.onerror?.(); else socket.onclose?.();
    expect(handlers.failed).toHaveBeenCalledWith('connection_lost', undefined);
    expect(socket.messages.some(m => m.type === 'stop')).toBe(false);
  });

  it('ferramenta desconhecida sempre recebe tool_result; modo só manda controle', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { call, socket, handlers } = await openCall();
    socket.receive({ type: 'tool', call: 9, name: 'read_screen', args: {} });
    socket.receive({ type: 'tool', call: 10, name: 'switch_session', args: { server: 'peer', base_url: 'https://peer.test', name: 'other' } });
    socket.receive({ type: 'tool', call: 11, name: 'hangar_action', args: { id: 'sessions', arg: '  a  ' } });
    expect(socket.messages).toContainEqual({ type: 'tool_result', call: 9, ok: false, text: '' });
    expect(socket.messages).toContainEqual({ type: 'tool_result', call: 10, ok: true, text: '' });
    expect(handlers.switchTo).toHaveBeenCalledWith({ server: 'peer', baseUrl: 'https://peer.test', name: 'other' });
    expect(handlers.runAction).toHaveBeenCalledWith('sessions', 'a');
    call.setMode('planejar'); call.setScreen({ server: 'peer', name: 'other' });
    expect(socket.messages).toContainEqual({ type: 'mode', mode: 'planejar' });
    expect(socket.messages).toContainEqual({ type: 'screen', screen: { server: 'peer', name: 'other' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('native start tardio é seguido de stop antes do start da chamada seguinte', async () => {
    const entered = deferred<void>(), pending = deferred<void>();
    rtc.nativeStart.mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const { call } = makeCall();
    const starting = call.start(server, null);
    await entered.promise;
    const stopping = call.stop();
    const next = call.start(server, null);
    const order: string[] = [];
    rtc.nativeStop.mockImplementation(async () => { order.push('stop'); });
    rtc.nativeStart.mockImplementation(async () => { order.push('start'); });
    pending.resolve();
    await Promise.all([starting, stopping, next]);
    expect(order).toEqual(['stop', 'start']);
    expect(Socket.all).toHaveLength(1);
    expect(Socket.all[0].close).not.toHaveBeenCalled();
  });

  it('reativar depois do ditado reaplica áudio nativo antes de ligar o track', async () => {
    const { call, pc } = await openCall(); pc.connect();
    const stream = await rtc.getUserMedia.mock.results[0].value;
    call.setMuted(true);
    const restored = deferred<void>(), entered = deferred<void>();
    rtc.nativeStart.mockImplementationOnce(() => { entered.resolve(); return restored.promise; });
    call.setMuted(false);
    await entered.promise;
    call.setMuted(false);
    expect(stream.track.enabled).toBe(false);
    restored.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.track.enabled).toBe(true);
    expect(rtc.nativeStart).toHaveBeenCalledTimes(2);
  });

  it('restauração atrasada ou rejeitada não muda nem derruba a chamada posterior', async () => {
    const { call, pc, handlers } = await openCall(); pc.connect(); call.setMuted(true);
    const restore = deferred<void>(), entered = deferred<void>();
    rtc.nativeStart.mockImplementationOnce(() => { entered.resolve(); return restore.promise; });
    call.setMuted(false); await entered.promise;
    const next = call.start(server, null);
    restore.reject(new Error('old-audio'));
    await next;
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(Socket.all.at(-1)!.close).not.toHaveBeenCalled();
  });

  it('Encerrar na notificação usa o desligamento normal, sem erro de interrupção', async () => {
    const { socket, handlers } = await openCall();
    for (const listener of rtc.listeners) listener({ reason: 'stop' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.messages).toContainEqual({ type: 'stop' });
    expect(handlers.phase).toHaveBeenLastCalledWith('closed');
    expect(handlers.failed).not.toHaveBeenCalled();
    expect(rtc.nativeStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['notifications_permission', 'notifications_permission'],
    ['microphone_permission', 'microphone'],
    ['app_not_visible', 'foreground_required'],
    ['audio_interrupted', 'audio_interrupted'],
  ])('preserva a recusa nativa %s como %s', async (nativeCode, shownCode) => {
    rtc.nativeStart.mockRejectedValueOnce(Object.assign(new Error('native-private-detail'), { code: nativeCode }));
    const { call, handlers } = makeCall();
    await call.start(server, null);
    expect(handlers.failed).toHaveBeenCalledExactlyOnceWith(shownCode, undefined);
    expect(Socket.all).toHaveLength(0);
  });

  it('recusa nativa desconhecida vira failed com detalhe estável', async () => {
    rtc.nativeStart.mockRejectedValueOnce(Object.assign(new Error('native-private-detail'), { code: 'unexpected_native_code' }));
    const { call, handlers } = makeCall();
    await call.start(server, null);
    expect(handlers.failed).toHaveBeenCalledExactlyOnceWith('failed', 'native_audio_start_failed');
  });

  it('a restauração também conserva o código da recusa nativa e encerra a própria chamada', async () => {
    const { call, socket, pc, handlers } = await openCall(); pc.connect(); call.setMuted(true);
    rtc.nativeStart.mockRejectedValueOnce(Object.assign(new Error('blocked_channel'), { code: 'notifications_permission' }));
    call.setMuted(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.failed).toHaveBeenCalledExactlyOnceWith('notifications_permission', undefined);
    expect(socket.messages).toContainEqual({ type: 'stop' });
  });

  it('interrupção fatal de mídia encerra só a própria chamada anexada', async () => {
    const { socket, handlers } = await openCall();
    for (const listener of rtc.listeners) listener({ reason: 'focus_lost' });
    expect(socket.messages).toContainEqual({ type: 'stop' });
    expect(handlers.failed).toHaveBeenCalledWith('audio_interrupted', 'focus_lost');
  });
});
