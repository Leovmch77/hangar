import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'android',
  permission: 'granted',
  subscribe: vi.fn(),
  push: vi.fn(),
  getToken: vi.fn(async () => ({ data: 'ExponentPushToken[abc]' })),
  request: vi.fn(),
  channel: vi.fn(async () => null),
  handler: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return h.os; } }, Linking: { openSettings: vi.fn() } }));
vi.mock('expo-router', () => ({ router: { push: h.push } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } } }));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationChannelAsync: h.channel,
  getPermissionsAsync: vi.fn(async () => ({ status: h.permission })),
  requestPermissionsAsync: h.request.mockImplementation(async () => ({ status: h.permission })),
  getExpoPushTokenAsync: h.getToken,
  setNotificationHandler: h.handler,
  clearLastNotificationResponse: h.clear,
  DEFAULT_ACTION_IDENTIFIER: 'default-action',
}));
vi.mock('@hangar/core', () => ({ subscribeExpoPushForServer: h.subscribe }));
vi.mock('../../paraglide/runtime', () => ({ getLocale: () => 'pt' }));
vi.mock('../../stores/servers', () => ({ useServers: vi.fn() }));

import { handleNotificationResponse, installNotificationHandler, openFromNotification, registerExpoPush, retryExpoPushIfDenied } from './expoPush';

const casa = { id: 'casa', label: 'Casa', baseUrl: 'https://casa.test', token: 't1' };
const work = { id: 'work', label: 'Trabalho', baseUrl: 'https://work.test', token: 't2' };

beforeEach(() => {
  h.os = 'android';
  h.permission = 'granted';
  h.subscribe.mockReset();
  h.push.mockReset();
  h.getToken.mockClear();
  h.request.mockClear();
  h.channel.mockClear();
  h.clear.mockClear();
});

describe('registerExpoPush', () => {
  it('iOS não pede permissão', async () => {
    h.os = 'ios';
    expect(await registerExpoPush([casa])).toBe('unsupported');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.getToken).not.toHaveBeenCalled();
  });

  it('permissão negada não busca token', async () => {
    h.permission = 'denied';
    expect(await registerExpoPush([casa])).toBe('denied');
    expect(h.getToken).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it('um POST por servidor com o mesmo token e o id de cada um', async () => {
    expect(await registerExpoPush([casa, work])).toBe('registered');
    expect(h.getToken).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(h.subscribe).toHaveBeenCalledWith(casa, { token: 'ExponentPushToken[abc]', server_id: 'casa', label: 'Casa', locale: 'pt' });
    expect(h.subscribe).toHaveBeenCalledWith(work, { token: 'ExponentPushToken[abc]', server_id: 'work', label: 'Trabalho', locale: 'pt' });
  });

  it('falha num servidor não impede o outro', async () => {
    h.subscribe.mockImplementation(async (s: { id: string }) => { if (s.id === 'casa') throw new Error('404'); });
    expect(await registerExpoPush([casa, work])).toBe('registered');
    expect(h.subscribe).toHaveBeenCalledWith(work, expect.objectContaining({ server_id: 'work' }));
  });

  it('cria o canal Android default com importância alta', async () => {
    await registerExpoPush([casa]);
    expect(h.channel).toHaveBeenCalledWith('default', expect.objectContaining({ importance: 4 }));
  });
});

describe('openFromNotification', () => {
  it('abre a conversa da sessão', () => {
    openFromNotification({ server: 'casa', session: 'minha sessão' }, [casa]);
    expect(h.push).toHaveBeenCalledWith({ pathname: '/s/[server]/[name]', params: { server: 'casa', name: 'minha sessão' } });
  });

  it('push da lista agregada abre a lista', () => {
    openFromNotification({ server: 'casa' }, [casa]);
    expect(h.push).toHaveBeenCalledWith('/');
  });

  it('servidor fora da lista do aparelho abre a lista', () => {
    openFromNotification({ server: 'outro', session: 'x' }, [casa]);
    expect(h.push).toHaveBeenCalledWith('/');
  });
});

describe('permissão liberada nos ajustes', () => {
  it('registra de novo ao voltar quando a última tentativa foi negada', async () => {
    h.permission = 'denied';
    await registerExpoPush([casa]);
    h.permission = 'granted';
    expect(await retryExpoPushIfDenied([casa])).toBe('registered');
    expect(h.subscribe).toHaveBeenCalledWith(casa, expect.objectContaining({ server_id: 'casa' }));
  });

  it('não registra de novo quando a última tentativa deu certo', async () => {
    await registerExpoPush([casa]);
    h.subscribe.mockClear();
    expect(await retryExpoPushIfDenied([casa])).toBeNull();
    expect(h.subscribe).not.toHaveBeenCalled();
  });
});

describe('installNotificationHandler', () => {
  it('instala uma vez só, com banner, lista e som', async () => {
    installNotificationHandler();
    installNotificationHandler();
    expect(h.handler).toHaveBeenCalledTimes(1);
    const behavior = await h.handler.mock.calls[0][0].handleNotification();
    expect(behavior).toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true });
  });
});

describe('handleNotificationResponse', () => {
  const response = (actionIdentifier: string) => ({
    actionIdentifier, notification: { request: { content: { data: { server: 'casa', session: 's1' } } } },
  });

  it('ignora ação que não é o toque padrão', () => {
    handleNotificationResponse(response('reply') as never, [casa]);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('navega e limpa a última resposta para não abrir duas vezes', () => {
    handleNotificationResponse(response('default-action') as never, [casa]);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.clear).toHaveBeenCalledTimes(1);
  });
});
