import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { disableSyncForServer, getSyncSetupForServer, setupSyncForServer, type SyncSetup } from '@hangar/core';
import { Pagina } from '../../src/features/config/Pagina';
import { PageHeader, Pill } from '../../src/features/config/PageHeader';
import { SectionCard } from '../../src/features/config/SectionCard';
import { InfoNotice } from '../../src/features/config/InfoNotice';
import { useSettingsColors } from '../../src/features/config/colors';
import { useServers } from '../../src/stores/servers';
import * as m from '../../src/paraglide/messages';

type Write = 'enable' | 'disable';

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : m.native_sync_config_erro());

export default function SyncPage() {
  const server = useServers((s) => s.active());
  const c = useSettingsColors();
  const [setup, setSetup] = useState<SyncSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Write | null>(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);

  // `reconcile`: a gravação que falhou pode ter chegado antes da queda; a releitura diz se valeu.
  const load = useCallback((reconcile?: Write) => {
    const now = ++generation.current;
    if (!server) return;
    setLoading(true);
    setLoadError('');
    getSyncSetupForServer(server)
      .then((next) => {
        if (now !== generation.current) return;
        setSetup(next);
        if (reconcile && next.enabled === (reconcile === 'enable')) {
          setError('');
          setDone(reconcile);
        }
      })
      .catch((cause: unknown) => { if (now === generation.current) setLoadError(errorText(cause)); })
      .finally(() => { if (now === generation.current) setLoading(false); });
  }, [server]);

  useEffect(() => {
    setSetup(null);
    setError('');
    setDone(null);
    setCopied(false);
    load();
    return () => { generation.current++; };
  }, [load, server?.id, server?.baseUrl, server?.token]);

  const write = (kind: Write) => {
    if (!server || saving) return;
    setSaving(true);
    setError('');
    setDone(null);
    (kind === 'enable' ? setupSyncForServer(server) : disableSyncForServer(server))
      .then((next) => {
        generation.current++;
        setSetup(next);
        setLoading(false);
        setDone(kind);
      })
      .catch((cause: unknown) => {
        setError(errorText(cause));
        load(kind);
      })
      .finally(() => setSaving(false));
  };

  const confirmDisable = () =>
    Alert.alert(m.native_sync_config_desativar(), m.native_sync_config_desativar_aviso(), [
      { text: m.comum_cancelar(), style: 'cancel' },
      { text: m.native_sync_config_desativar(), style: 'destructive', onPress: () => write('disable') },
    ]);

  // O endereço da raiz da máquina: é nele que os outros aparelhos entram.
  const address = server ? server.baseUrl.replace(/^(https?:\/\/[^/]+).*$/i, '$1/') : '';
  const copy = () => {
    void Clipboard.setStringAsync(address).then(() => setCopied(true));
  };

  const header = (
    <PageHeader
      title={m.native_settings_page_sync()}
      subtitle={m.native_sync_config_ganho()}
      actions={server ? [{ icon: 'RefreshCw', label: m.native_reload(), onPress: () => load() }] : undefined}
    />
  );
  if (!server) {
    return (
      <Pagina>
        {header}
        <InfoNotice text={m.native_settings_offline()} />
      </Pagina>
    );
  }

  const muted = [styles.text, { color: c.muted }];
  const body = (() => {
    if (!setup) {
      if (loadError) {
        return (
          <View style={styles.block}>
            <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
            <View style={styles.row}><Pill icon="RefreshCw" label={m.native_server_retry()} onPress={() => load()} /></View>
          </View>
        );
      }
      return <Text style={muted}>{m.native_loading()}</Text>;
    }
    const disable = setup.enabled ? (
      <Pill icon="CloudOff" label={m.native_sync_config_desativar()} onPress={saving ? () => {} : confirmDisable} />
    ) : null;
    if (setup.enabled && setup.registered) {
      return (
        <View style={styles.block}>
          <Text style={[styles.strong, { color: c.text }]}>
            {done === 'enable' ? m.native_sync_config_ativada() : m.native_sync_config_ativa()}
          </Text>
          {setup.user ? <Text style={[styles.text, { color: c.text }]}>{m.native_sync_config_usuario_atual({ usuario: setup.user })}</Text> : null}
          <Text style={muted}>{m.native_sync_config_como_entrar()}</Text>
          <View style={[styles.address, { borderColor: c.border, backgroundColor: c.inset }]}>
            <Text style={[styles.mono, { color: c.text }]} numberOfLines={1} selectable>{address}</Text>
          </View>
          <View style={styles.row}>
            <Pill icon="Copy" label={copied ? m.native_sync_config_copiado() : m.native_sync_config_copiar()} onPress={copy} />
            <Pill icon="ExternalLink" label={m.native_sync_config_abrir()} onPress={() => { void Linking.openURL(address); }} />
            {disable}
          </View>
        </View>
      );
    }
    return (
      <View style={styles.block}>
        {!setup.enabled ? <Text style={muted}>{m.native_sync_config_direta()}</Text> : null}
        {setup.enabled && !setup.registered ? <Text style={muted}>{m.native_sync_no_account()}</Text> : null}
        {done === 'disable' ? <Text style={[styles.text, { color: c.text }]}>{m.native_sync_config_desativada()}</Text> : null}
        {setup.registered ? (
          <>
            <Text style={muted}>{m.native_sync_config_conta_existente({ usuario: setup.user ?? '' })}</Text>
            <View style={styles.row}>
              <Pill
                icon="RefreshCw"
                label={saving ? m.native_sync_config_ativando() : m.native_sync_config_reativar()}
                onPress={() => write('enable')}
              />
            </View>
          </>
        ) : (
          // ponytail: criar a conta exige PBKDF2 + AES-GCM, que o Hermes não tem; com uma lib de cripto nativa dá para portar.
          <InfoNotice text={m.mobile_sync_register_elsewhere()} />
        )}
        {disable ? <View style={styles.row}>{disable}</View> : null}
      </View>
    );
  })();

  return (
    <Pagina>
      {header}
      <SectionCard icon="RefreshCw" title={server.label} subtitle={m.native_server_scope()}>
        <View style={styles.inner}>
          <Text style={muted}>{m.native_sync_config_principal({ servidor: server.label })}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {loading && setup ? <Text style={muted}>{m.native_loading()}</Text> : null}
          {body}
        </View>
      </SectionCard>
    </Pagina>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  block: { gap: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  text: { fontSize: 15, lineHeight: 20 },
  strong: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.error },
  address: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  mono: { fontFamily: theme.base.fontMono, fontSize: 14 },
}));
