import { useEffect } from 'react';
import { AppState, View } from 'react-native';
import { useGlobalSearchParams, useRouter, useSegments } from 'expo-router';
import { useServers } from '../../stores/servers';
import { LiveVoiceButton } from './LiveVoiceButton';
import { LiveVoiceSheet } from './LiveVoiceSheet';
import { useLiveVoice, type LiveVoiceDestination } from './liveVoiceStore';

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

/** A chamada não pertence à tela da sessão nem ao tempo em que a folha fica aberta. */
export function LiveVoiceRoot() {
  const router = useRouter();
  const segments: readonly string[] = useSegments();
  const params = useGlobalSearchParams<{ server?: string | string[]; name?: string | string[] }>();
  const servers = useServers(state => state.servers);
  const open = useLiveVoice(state => state.open);
  const view = useLiveVoice(state => state.view);
  const chatControls = useLiveVoice(state => state.chatControls);
  const serverId = first(params.server);
  const name = first(params.name);
  const sessionRoute = segments[0] === 's' && !!serverId && !!name;
  const chatRoute = sessionRoute && (segments.length === 3 || segments.length === 4 && segments[3] === 'index');

  useEffect(() => useLiveVoice.getState().registerNavigation((destination: LiveVoiceDestination) => {
    if (destination.kind === 'list') { router.replace('/'); return true; }
    if (destination.kind === 'settings') {
      // As telas de configuração usam a seleção global: a navegação explícita alinha a máquina antes de abri-las.
      const target = useServers.getState().servers.find(server => server.id === destination.serverId && !server.invite && !server.inviteEnded && !server.removed);
      if (!target || !useServers.getState().ensureActive(target.id)) return false;
      router.push((destination.section ? `/config/${destination.section}` : '/config') as '/config');
      return true;
    }
    if (destination.panel === 'activity') {
      router.push({ pathname: '/s/[server]/[name]/activity', params: { server: destination.serverId, name: destination.name } });
    } else if (destination.panel === 'terminal') {
      router.push({ pathname: '/s/[server]/[name]/terminal', params: { server: destination.serverId, name: destination.name } });
    } else {
      router.replace({ pathname: '/s/[server]/[name]', params: { server: destination.serverId, name: destination.name } });
    }
    return true;
  }), [router]);

  useEffect(() => {
    useLiveVoice.getState().setRoute(sessionRoute
      ? { serverId: serverId!, name: name!, kind: chatRoute ? 'chat' : 'session-panel' }
      : null);
  }, [sessionRoute, chatRoute, serverId, name]);

  useEffect(() => {
    useLiveVoice.getState().setForeground((AppState.currentState ?? 'active') === 'active');
    const subscription = AppState.addEventListener('change', state => useLiveVoice.getState().setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);

  useEffect(() => { useLiveVoice.getState().reconcileServers(); }, [servers]);

  const store = useLiveVoice.getState();
  const hasCall = view.phase === 'connecting' || view.phase === 'live' || !!view.error;
  return <>
    {!(chatRoute && chatControls?.serverId === serverId && chatControls.name === name) && !open && hasCall ? <View pointerEvents="box-none" style={{ position: 'absolute', right: 16, bottom: 32 }}>
      <LiveVoiceButton phase={view.phase} muted={view.muted} levels={view.levels} error={!!view.error} visible
        onPress={() => useLiveVoice.setState({ open: true })} />
    </View> : null}
    <LiveVoiceSheet open={open} view={view} onDismiss={store.dismiss}
      onStart={() => { void store.start(); }} onStop={() => { void store.stop(); }} onToggleMute={store.toggleMute}
      onMode={store.setMode} onRetry={() => { void store.retry(); }}
      onSaveSettings={next => { void store.saveSettings(next); }} onSettingsOpen={store.openSettings}
      onForgetMemory={id => { void store.forgetMemory(id); }} />
  </>;
}
