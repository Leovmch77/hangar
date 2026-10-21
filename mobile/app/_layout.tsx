import 'react-native-url-polyfill/auto';
import '../src/theme/unistyles';
import { useEffect } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
// Sem o KeyboardProvider, KeyboardStickyView/KeyboardChatScrollView lançam em runtime
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { configureCore } from '../src/net/configureCore';
import { useServers } from '../src/stores/servers';
import { discoverSavedMachines } from '../src/features/machines/importMachines';
import { setChatsForeground } from '../src/stores/chat';
import { setQueueDeliveryForeground } from '../src/chat/useQueueDelivery';
import { setMachineDiscovery, useSessions } from '../src/stores/sessions';
import { aplicarTemaSalvo, useAparencia } from '../src/stores/aparencia';
import { aplicarMaterial } from '../src/theme/aplicarMaterial';
import { Toaster, toast } from '../src/ui/Toast';
import { LiveVoiceRoot } from '../src/features/voice/LiveVoiceRoot';
import { applyOrientationLock } from '../src/features/tablet/orientationLock';
import { setFatalErrorRoute, takeFatalErrorNotice } from '../src/net/fatalErrors';
import * as m from '../src/paraglide/messages';
import { installNotificationHandler, pushRegistrationKey, registerExpoPush, retryExpoPushIfDenied, useNotificationNavigation } from '../src/features/push/expoPush';
import { getLocale } from '../src/paraglide/runtime';
import { registrarDiag } from '@hangar/core';

configureCore();
aplicarTemaSalvo();
aplicarMaterial(useAparencia.getState());
installNotificationHandler();

const reportPushError = (e: unknown) => {
  registrarDiag({ evento: 'push.register_failed', nivel: 'erro', codigo: 'expo_push_register_failed', detalhe: e instanceof Error ? e.message : String(e) });
};

export default function Layout() {
  const router = useRouter();
  const segments = useSegments();
  setFatalErrorRoute(segments);
  const ready = useServers((s) => s.ready);
  const servers = useServers((s) => s.servers);
  const aviso = useServers((s) => s.aviso);
  const limparAviso = useServers((s) => s.limparAviso);

  useEffect(() => {
    applyOrientationLock().catch((e: unknown) => {
      registrarDiag({ evento: 'orientation.lock_failed', nivel: 'erro', codigo: 'orientation_lock_failed', detalhe: e instanceof Error ? e.message : String(e) });
    });
  }, []);

  useEffect(() => {
    try { if (takeFatalErrorNotice()) toast.aviso(m.native_last_error_available()); }
    catch { toast.erro(m.native_last_error_read_failed()); }
  }, []);

  useEffect(() => {
    setMachineDiscovery((server) => { void discoverSavedMachines([server]); });
    void useServers.getState().load();
    return () => setMachineDiscovery(() => {});
  }, []);

  // Único dono do primeiro plano: os stores conservam transcript, pergunta e rascunho ao sair
  // e ignoram repetição do mesmo estado, então voltar não duplica REST/SSE.
  useEffect(() => {
    const initial = AppState.currentState ?? 'active';
    const apply = (state: AppStateStatus) => {
      const active = state === 'active';
      setChatsForeground(active);
      setQueueDeliveryForeground(active);
      useSessions.getState().setForeground(active);
      if (active) retryExpoPushIfDenied(useServers.getState().servers).catch(reportPushError);
    };
    apply(initial);
    const subscription = AppState.addEventListener('change', apply);
    return () => subscription.remove();
  }, []);

  useNotificationNavigation();
  // A lista se regrava por outros motivos (rede local aprendida); só servidor, nome ou idioma refazem o registro.
  useAparencia((s) => s.idioma); // re-renderiza para o getLocale abaixo ler o idioma novo
  const pushKey = pushRegistrationKey(servers, getLocale());
  useEffect(() => {
    if (!ready || !pushKey) return;
    registerExpoPush(useServers.getState().servers).catch(reportPushError);
  }, [ready, pushKey]);

  useEffect(() => {
    if (!ready) return;
    const withoutServer = segments[0] === 'login' || segments[0] === 'convite' || segments[0] === 'importar';
    if (servers.length === 0 && !withoutServer) {
      router.replace('/login');
    }
  }, [ready, servers.length, segments]);

  // Aqui, e não na lista de sessões: as duas formas de perder um servidor (keystore que recusou a
  // escrita, token que o servidor rejeitou) acontecem com qualquer tela aberta, inclusive dentro
  // de um chat. O layout é o único lugar montado o tempo todo.
  useEffect(() => {
    if (!aviso) return;
    if (aviso.tipo === 'identification') toast.aviso(aviso.message);
    else toast.erro(
      aviso.tipo === 'token'
        ? m.servidores_aviso_token({ label: aviso.label })
        : aviso.tipo === 'vault_unread'
          ? m.servers_warning_vault_unread()
          : m.servidores_aviso_persistencia(),
    );
    limparAviso();
  }, [aviso, limparAviso]);

  return (
    <KeyboardProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          {/* Android: o formSheet sobe a folha com o teclado (o KeyboardAvoidingView compensava de novo)
              e retém os eventos de animação do teclado, e aí a folha de Opções nunca abria. */}
          <Stack.Screen
            name="create"
            options={Platform.OS === 'android'
              ? { presentation: 'card', headerShown: false }
              : { presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }}
          />
          {/* Página inteira, como no desktop: são várias páginas com ida e volta, e na folha arrastar fechava tudo. */}
          <Stack.Screen name="config" options={{ headerShown: false }} />
          <Stack.Screen name="costs" options={{ presentation: 'card', headerShown: false }} />
          <Stack.Screen name="stats" options={{ presentation: 'card', headerShown: false }} />
          {/* A borda esquerda do chat é o voltar do iOS; a gaveta abre mais para dentro (SessionsDrawer `edgeStart`). */}
          <Stack.Screen name="s/[server]/[name]/index" />
          {/* Página inteira, como a do T3: voltar pelo cabeçalho e pelo gesto. */}
          <Stack.Screen name="s/[server]/[name]/page" options={{ headerShown: false }} />
          <Stack.Screen name="s/[server]/[name]/ask" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/activity" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/orchestration" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/loop" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/pair" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/files" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/git" options={Platform.OS === 'android'
            ? { presentation: 'card', headerShown: true }
            : { presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/account" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/terminal" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/attachments" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/codex-limits" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/bastao" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
        </Stack>
        <LiveVoiceRoot />
        <Toaster position="top-center" />
      </GestureHandlerRootView>
    </KeyboardProvider>
  );
}
