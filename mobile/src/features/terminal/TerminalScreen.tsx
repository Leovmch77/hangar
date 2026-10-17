import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Constants from 'expo-constants';
import type { Server } from '@hangar/core';
import TerminalDom, { type TerminalDomHandle } from './TerminalDom';
import { TerminalMirror } from './TerminalMirror';
import { openTerminalSocket } from './terminalSocket';
import { useServers } from '../../stores/servers';
import { Icon, type IconName } from '../../ui/Icon';
import * as m from '../../paraglide/messages';

export function TerminalScreen({ serverId, name, focused, aviso }: {
  serverId: string; name: string; focused: boolean; aviso?: string;
}) {
  const server = useServers(state => state.servers.find(item => item.id === serverId) ?? null);
  const [appState, setAppState] = useState(AppState.currentState);
  const [mirror, setMirror] = useState(false);
  const { theme } = useUnistyles();
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);
  return <View style={styles.root}>
    {aviso ? <Text style={styles.notice}>{aviso}</Text> : null}
    {!server ? <Text accessibilityRole="alert" style={styles.error}>{m.servidor_nao_existe()}</Text> : <>
      <Pressable accessibilityRole="button" accessibilityLabel={mirror ? m.mobile_terminal_real() : m.mobile_terminal_mirror()}
        style={styles.modeButton} onPress={() => setMirror(value => !value)}>
        <Icon name={mirror ? 'Terminal' : 'ScanText'} color={theme.tokens.text.primary} />
        <Text style={styles.label}>{mirror ? m.mobile_terminal_real() : m.mobile_terminal_mirror()}</Text>
      </Pressable>
      <RealTerminal key={`${serverId}:${server.baseUrl}:${server.token}:${name}`} server={server} name={name}
        active={!mirror && focused && appState === 'active'} />
      {mirror && focused && appState === 'active'
        ? <TerminalMirror key={`${serverId}:${name}`} serverId={serverId} name={name} /> : null}
    </>}
  </View>;
}

type TerminalFailure = { error: string; load: boolean };

function RealTerminal({ server, name, active }: { server: Server; name: string; active: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<TerminalFailure | null>(null);
  return active ? <TerminalConnection key={attempt} server={server} name={name} initialFailure={failure} onFailure={setFailure}
    retry={() => { setFailure(null); setAttempt(value => value + 1); }} /> : null;
}

function TerminalConnection({ server, name, retry, initialFailure, onFailure }: {
  server: Server; name: string; retry: () => void;
  initialFailure: TerminalFailure | null; onFailure: (failure: TerminalFailure) => void;
}) {
  const { theme } = useUnistyles();
  const dom = useRef<TerminalDomHandle>(null);
  const socket = useRef<ReturnType<typeof openTerminalSocket> | null>(null);
  const alive = useRef(true);
  const documentUrl = useRef<string | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initiallyBlocked = useRef(!!initialFailure).current;
  const [status, setStatus] = useState<{ state: 'connecting' | 'connected' | 'disconnected'; error: string }>({
    state: initialFailure ? 'disconnected' : 'connecting', error: initialFailure && !initialFailure.load ? initialFailure.error : '',
  });
  const [loadError, setLoadError] = useState(initialFailure?.load ? initialFailure.error : '');
  useLayoutEffect(() => {
    alive.current = true;
    if (!initiallyBlocked) loadTimer.current = setTimeout(() => fail(), 20_000);
    return () => { alive.current = false; clearTimeout(loadTimer.current); socket.current?.close(); };
  }, []);
  const fail = (detail = '') => {
    if (!alive.current) return;
    alive.current = false;
    clearTimeout(loadTimer.current);
    socket.current?.close();
    setStatus({ state: 'disconnected', error: '' });
    const error = detail ? `${m.mobile_terminal_load_error()} ${detail}` : m.mobile_terminal_load_error();
    setLoadError(error);
    onFailure({ error, load: true });
  };
  const navigate = (request: { url: string }) => {
    try {
      const url = new URL(request.url);
      url.hash = '';
      if (documentUrl.current) return url.href === documentUrl.current;
      const hostUri = Constants.expoConfig?.hostUri;
      const devOrigin = hostUri ? new URL(`http://${hostUri}`).origin : null;
      const local = url.protocol === 'file:' && url.pathname.includes('/www.bundle/');
      const development = url.origin === devOrigin && url.pathname.startsWith('/_expo/@dom/');
      if (!local && !development) return false;
      documentUrl.current = url.href;
      return true;
    } catch { return false; }
  };
  const keys: { label: string; data: string; icon: IconName }[] = [
    { label: m.mobile_terminal_escape(), data: '\u001b', icon: 'X' },
    { label: m.mobile_terminal_tab(), data: '\t', icon: 'ArrowRightToLine' },
    { label: m.mobile_terminal_enter(), data: '\r', icon: 'CornerDownLeft' },
    { label: m.mobile_terminal_ctrl_c(), data: '\u0003', icon: 'OctagonX' },
    { label: m.term_seta_cima(), data: '\u001b[A', icon: 'ArrowUp' },
    { label: m.term_seta_baixo(), data: '\u001b[B', icon: 'ArrowDown' },
    { label: m.term_seta_esquerda(), data: '\u001b[D', icon: 'ArrowLeft' },
    { label: m.term_seta_direita(), data: '\u001b[C', icon: 'ArrowRight' },
    { label: m.mobile_terminal_backspace(), data: '\u007f', icon: 'Delete' },
  ];
  const connected = status.state === 'connected' && !loadError;
  return <View style={styles.root}>
    {status.state === 'connecting' && !loadError ? <View style={styles.loading}>
      <ActivityIndicator color={theme.tokens.text.secondary} />
      <Text style={styles.notice}>{m.native_term_connecting()}</Text>
    </View> : null}
    {loadError || status.error ? <Text accessibilityRole="alert" style={styles.error}>{loadError || status.error}</Text> : null}
    {loadError || status.state === 'disconnected' ? <Pressable accessibilityRole="button"
      accessibilityLabel={loadError ? m.lista_tentar_novamente() : m.native_term_reconnect()} style={styles.modeButton} onPress={retry}>
      <Icon name="RefreshCw" color={theme.tokens.text.primary} />
      <Text style={styles.label}>{loadError ? m.lista_tentar_novamente() : m.native_term_reconnect()}</Text>
    </Pressable> : null}
    {!loadError && !initiallyBlocked ? <TerminalDom ref={dom} foreground={theme.tokens.text.primary} cursor={theme.tokens.accent.base}
      fontSize={theme.base.text.xs} connected={!!connected}
      onReady={async (cols, rows) => {
        if (!alive.current || initiallyBlocked || socket.current) return;
        clearTimeout(loadTimer.current);
        socket.current = openTerminalSocket(server, name, { cols, rows }, {
          output: bytes => { if (alive.current) dom.current?.write(bytes); },
          status: next => {
            if (!alive.current) return;
            setStatus(next);
            if (next.state === 'disconnected') onFailure({ error: next.error, load: false });
          },
        });
      }}
      onResize={async (cols, rows) => { if (alive.current) socket.current?.resize(cols, rows); }}
      onData={async (data, binary) => { if (alive.current) socket.current?.send(data, binary); }}
      onError={async message => fail(message)}
      dom={{
        useExpoDOMWebView: false,
        unstable_useExpoModulesBridge: false,
        style: styles.webview,
        containerStyle: styles.root,
        originWhitelist: ['*'],
        onShouldStartLoadWithRequest: navigate,
        onOpenWindow: () => {},
        javaScriptCanOpenWindowsAutomatically: false,
        setSupportMultipleWindows: false,
        allowFileAccessFromFileURLs: false,
        allowUniversalAccessFromFileURLs: false,
        onError: event => fail(event.nativeEvent.description),
        onHttpError: event => fail(String(event.nativeEvent.statusCode)),
        onContentProcessDidTerminate: () => fail(),
        onRenderProcessGone: () => fail(),
      }} /> : null}
    <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.keyScroll} contentContainerStyle={styles.keys}>
      {keys.map(key => <Pressable key={key.data} accessibilityRole="button" accessibilityLabel={key.label}
        disabled={!connected} style={[styles.key, { opacity: connected ? 1 : 0.4 }]}
        onPress={() => { socket.current?.send(key.data); }}>
        <Icon name={key.icon} color={theme.tokens.text.primary} />
        <Text style={styles.label}>{key.label}</Text>
      </Pressable>)}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create(theme => ({
  root: { flex: 1, backgroundColor: 'transparent' },
  webview: { flex: 1, backgroundColor: 'transparent' },
  modeButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.base.space[2], minHeight: 44, padding: theme.base.space[2] },
  label: { fontSize: theme.base.text.xs, color: theme.tokens.text.primary },
  notice: { fontSize: theme.base.text.xs, color: theme.tokens.text.secondary, padding: theme.base.space[2] },
  error: { fontSize: theme.base.text.xs, color: theme.tokens.status.error, padding: theme.base.space[2] },
  loading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  keyScroll: { flexGrow: 0 },
  keys: { flexDirection: 'row', gap: theme.base.space[2], padding: theme.base.space[2] },
  key: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.base.space[2], borderWidth: 1, borderColor: theme.tokens.border.default, borderRadius: theme.base.radius.sm },
}));
