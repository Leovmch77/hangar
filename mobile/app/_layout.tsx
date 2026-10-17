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
import { useSessions } from '../src/stores/sessions';
import { aplicarTemaSalvo, useAparencia } from '../src/stores/aparencia';
import { aplicarMaterial } from '../src/theme/aplicarMaterial';
import { Toaster, toast } from '../src/ui/Toast';
import { LiveVoiceRoot } from '../src/features/voice/LiveVoiceRoot';
import * as m from '../src/paraglide/messages';

configureCore();
aplicarTemaSalvo();
aplicarMaterial(useAparencia.getState());

export default function Layout() {
  const router = useRouter();
  const segments = useSegments();
  const ready = useServers((s) => s.ready);
  const servers = useServers((s) => s.servers);
  const aviso = useServers((s) => s.aviso);
  const limparAviso = useServers((s) => s.limparAviso);

  useEffect(() => {
    void useServers.getState().load().then(() => discoverSavedMachines());
  }, []);

  // Único dono do primeiro plano: os stores conservam transcript, pergunta e rascunho ao sair
  // e ignoram repetição do mesmo estado, então voltar não duplica REST/SSE.
  useEffect(() => {
    const initial = AppState.currentState ?? 'active';
    let foreground = initial === 'active';
    const apply = (state: AppStateStatus) => {
      const active = state === 'active';
      const resumed = active && !foreground;
      foreground = active;
      setChatsForeground(active);
      useSessions.getState().setForeground(active);
      if (resumed) void discoverSavedMachines();
    };
    apply(initial);
    const subscription = AppState.addEventListener('change', apply);
    return () => subscription.remove();
  }, []);

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
    toast.erro(
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
          {/* A borda esquerda do chat é o voltar do iOS; a gaveta abre mais para dentro (SessionsDrawer `edgeStart`). */}
          <Stack.Screen name="s/[server]/[name]/index" />
          {/* Página inteira, como a do T3: voltar pelo cabeçalho e pelo gesto. */}
          <Stack.Screen name="s/[server]/[name]/page" options={{ headerShown: false }} />
          <Stack.Screen name="s/[server]/[name]/ask" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/activity" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/loop" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/pair" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
          <Stack.Screen name="s/[server]/[name]/files" options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.92], sheetGrabberVisible: true }} />
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
