import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useIsFocused, useLocalSearchParams, useNavigation, useRoute, useRouter } from 'expo-router';
import { ChatBody } from '../../../../src/chat/ChatBody';
import { SessionsDrawer } from '../../../../src/features/sessions/SessionsDrawer';
import { ServerSheet } from '../../../../src/features/sessions/ServerSheet';
import { Screen } from '../../../../src/ui/Screen';
import { useTabletLandscape } from '../../../../src/features/tablet/layout';
import { useTabletPrefs } from '../../../../src/stores/tabletPrefs';
import { READING_MAX } from '../../../../src/chat/conversationColumn';
import { WorkingMarkPaused } from '../../../../src/ui/WorkingMark';

// A faixa da borda esquerda fica com o voltar nativo do iOS.
const IOS_BACK_EDGE = 20;

export default function ChatScreen() {
  const router = useRouter();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ server: string; name: string; askFallback?: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const [serversOpen, setServersOpen] = useState(false);
  const tablet = useTabletLandscape();
  const panelOpen = useTabletPrefs(s => s.panelOpen);
  const togglePanel = useTabletPrefs(s => s.togglePanel);
  const deepStack = useStackPosition() >= 2;
  const onBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  return (
    <WorkingMarkPaused.Provider value={!focused}>
    <Screen edges={[]}>
      <SessionsDrawer enabled={!tablet} edgeStart={Platform.OS === 'ios' ? IOS_BACK_EDGE : undefined} onClose={() => router.dismissTo('/')} onOpenServers={() => setServersOpen(true)}>
        <ChatBody key={`${serverId}::${name}`} serverId={serverId} name={name}
                  header={tablet ? 'tablet' : 'phone'} panelOpen={panelOpen} onTogglePanel={togglePanel}
                  maxReading={tablet && !panelOpen ? READING_MAX : undefined}
                  askFallback={params.askFallback} onBack={onBack} deepStack={deepStack} />
      </SessionsDrawer>
      <ServerSheet open={serversOpen} onFechar={() => setServersOpen(false)} />
    </Screen>
    </WorkingMarkPaused.Provider>
  );
}

// Posição DESTA tela na pilha, não a do topo: folha empilhada sobre o chat não muda a dele. Só
// re-renderiza quando o número muda (o chat é pesado e fica montado sob as outras telas).
function useStackPosition(): number {
  const navigation = useNavigation();
  const { key } = useRoute();
  const read = useCallback(() => navigation.getState()?.routes.findIndex((r) => r.key === key) ?? 0, [navigation, key]);
  const [position, setPosition] = useState(read);
  useEffect(() => {
    setPosition(read());
    return navigation.addListener('state', () => setPosition(read()));
  }, [navigation, read]);
  return position;
}
