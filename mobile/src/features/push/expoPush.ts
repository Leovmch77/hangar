import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { subscribeExpoPushForServer, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { getLocale } from '../../paraglide/runtime';

// Convite (token de convidado), desligado e entrada montada para par externo não recebem push do dono.
const pushable = (s: Server) => !s.disabled && !s.invite && !s.removed && !s.ephemeral;

type PushResult = 'registered' | 'denied' | 'unsupported';
let lastResult: PushResult | null = null;

// ponytail: só Android; o iOS do SideStore não assina o entitlement de push.
export async function registerExpoPush(servers: Server[]): Promise<PushResult> {
  lastResult = await register(servers);
  return lastResult;
}

/** Volta dos ajustes do sistema: quem negou e depois liberou precisa mandar o token agora. */
export async function retryExpoPushIfDenied(servers: Server[]): Promise<PushResult | null> {
  return lastResult === 'denied' ? registerExpoPush(servers) : null;
}

let handlerInstalled = false;
// Sem o handler, o push que chega com o app aberto é descartado; sem som, o Android não mostra o banner.
export function installNotificationHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

async function register(servers: Server[]): Promise<PushResult> {
  if (Platform.OS !== 'android') return 'unsupported';
  // O canal precisa existir antes do pedido: no Android 13+ é ele que dispara a pergunta do sistema.
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Hangar',
    importance: Notifications.AndroidImportance.HIGH,
  });
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') return 'denied';
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const locale = getLocale();
  // Servidor fora do ar não impede os outros; a falha de cada um já vai ao diário pelo apiFetch.
  await Promise.allSettled(servers.filter(pushable).map((s) =>
    subscribeExpoPushForServer(s, { token, server_id: s.id, label: s.label, locale })));
  return 'registered';
}

export function openFromNotification(data: unknown, servers: Server[]): void {
  const d = (data ?? {}) as { server?: unknown; session?: unknown };
  const known = typeof d.server === 'string' && servers.some((s) => s.id === d.server);
  if (known && typeof d.session === 'string' && d.session) {
    router.push({ pathname: '/s/[server]/[name]', params: { server: d.server as string, name: d.session } });
  } else {
    router.push('/');
  }
}

export function handleNotificationResponse(response: Notifications.NotificationResponse, servers: Server[]): void {
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  openFromNotification(response.notification.request.content.data, servers);
  // Sem limpar, o hook devolve a mesma resposta na próxima montagem e abre de novo.
  Notifications.clearLastNotificationResponse();
}

/** Toque na notificação, inclusive com o app fechado: espera a lista de servidores carregar. */
export function useNotificationNavigation(): void {
  const response = Notifications.useLastNotificationResponse();
  const ready = useServers((s) => s.ready);
  useEffect(() => {
    if (ready && response) handleNotificationResponse(response, useServers.getState().servers);
  }, [ready, response]);
}

export function openNotificationSettings(): Promise<void> {
  return Linking.openSettings();
}
