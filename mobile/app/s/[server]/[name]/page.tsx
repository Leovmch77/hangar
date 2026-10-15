import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { parseHostMessage, type HtmlPageRef } from '@hangar/core';
import { Screen } from '../../../../src/ui/Screen';
import { Icon } from '../../../../src/ui/Icon';
import { onlyInitial, usePageDocument, usePageWebView } from '../../../../src/chat/tools/pageDocument';
import { one, pageFromParams } from '../../../../src/chat/tools/pageRoute';
import * as m from '../../../../src/paraglide/messages';

// Libera a pinça mesmo em página que travou o zoom no viewport: ampliar é o motivo da tela cheia.
const ALLOW_PINCH = "(()=>{const f=()=>{let v=document.querySelector('meta[name=viewport]');"
  + "if(!v){v=document.createElement('meta');v.name='viewport';document.head.appendChild(v)}"
  + "v.content='width=device-width,initial-scale=1,minimum-scale=0.5,maximum-scale=5,user-scalable=yes'};"
  + "document.readyState==='loading'?document.addEventListener('DOMContentLoaded',f):f()})();true";

// Página publicada pelo agente em tela própria, como o T3 no celular: voltar no cabeçalho e no gesto, zoom por pinça.
export default function PageScreen() {
  const params = useLocalSearchParams<{ server: string; name: string; id: string; title: string; own?: string }>();
  const page = pageFromParams(params);
  const serverId = one(params.server);
  const sessionName = one(params.name);
  return page
    ? <PageView page={page} serverId={serverId} sessionName={sessionName} />
    : <Shell title="" serverId={serverId} sessionName={sessionName}><Text style={styles.note}>{m.page_error({ title: '' })}</Text></Shell>;
}

function Shell({ title, serverId, sessionName, children }: { title: string; serverId: string; sessionName: string; children: React.ReactNode }) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/s/${encodeURIComponent(serverId)}/${encodeURIComponent(sessionName)}` as never));
  return (
    <Screen>
      <View style={[styles.header, { borderBottomColor: theme.tokens.border.subtle }]}>
        <Pressable onPress={back} hitSlop={8} style={styles.back} accessibilityRole="button" accessibilityLabel={m.comum_voltar()}>
          <Icon name="ChevronLeft" size={22} color={theme.tokens.text.primary} />
        </Pressable>
        <Text style={[styles.title, { color: theme.tokens.text.primary }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
      </View>
      <View style={styles.flex}>{children}</View>
    </Screen>
  );
}

function PageView({ page, serverId, sessionName }: { page: HtmlPageRef; serverId: string; sessionName: string }) {
  const { state, doc, load, params } = usePageDocument(page, sessionName, serverId);
  const { web, applyTheme, touched, openLink } = usePageWebView(params, page.ownTheme);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    const msg = parseHostMessage(e.nativeEvent.data);
    if (msg?.kind === 'link') openLink(msg.url);
  }, [openLink]);

  let body: React.ReactNode;
  if (state === 'loading') {
    body = <View style={styles.center} accessibilityRole="progressbar"><Text style={styles.note}>{m.page_loading({ title: page.title })}</Text></View>;
  } else if (state === 'expired') {
    body = <View style={styles.center}><Text style={styles.note} selectable>{m.page_expired()}</Text></View>;
  } else if (state === 'error') {
    body = (
      <View style={styles.center} accessibilityRole="alert">
        <Text style={styles.note} selectable>{m.page_error({ title: page.title })}</Text>
        <Pressable onPress={() => void load()} style={styles.retry} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.retryText}>{m.page_retry()}</Text>
        </Pressable>
      </View>
    );
  } else {
    body = (
      <View style={styles.flex} onTouchStart={touched}>
        <WebView
          ref={web}
          source={{ html: doc }}
          style={styles.web}
          // Mesmas travas do cartão: só o documento inicial carrega, sem janela nova.
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={onlyInitial}
          setSupportMultipleWindows={false}
          onMessage={onMessage}
          onLoadEnd={applyTheme}
          injectedJavaScript={ALLOW_PINCH}
          scalesPageToFit
          setBuiltInZoomControls
          setDisplayZoomControls={false}
          bounces={false}
          automaticallyAdjustContentInsets={false}
        />
      </View>
    );
  }
  return <Shell title={page.title} serverId={serverId} sessionName={sessionName}>{body}</Shell>;
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingHorizontal: theme.base.space[1],
    paddingRight: theme.base.space[3], minHeight: 48, borderBottomWidth: 1,
  },
  back: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0, fontSize: theme.base.text.base, fontWeight: '600' },
  web: { flex: 1, backgroundColor: 'transparent' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: theme.base.space[2], padding: theme.base.space[6] },
  note: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted, textAlign: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[2] },
  retryText: { fontSize: theme.base.text.sm, fontWeight: '600', color: theme.tokens.accent.base },
}));
