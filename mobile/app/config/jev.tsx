import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getComputerControlEnabled, getJevAuxCliproxy, listJevAuxModels, patchConfigForServer, type JevAuxCliproxy } from '@hangar/core';
import { BlockHead, Box, ConfigRow, Disclosure, Muted, ServerConfigPage } from '../../src/features/config/ServerConfigParts';
import { Pill } from '../../src/features/config/PageHeader';
import { useSettingsColors } from '../../src/features/config/colors';
import { textOf, useServerConfig } from '../../src/features/config/serverConfig';
import * as m from '../../src/paraglide/messages';

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : m.erro_desconhecido());
// A lista do provedor pode ter centenas de modelos: o campo Modelo filtra, e só as primeiras aparecem.
const SHOWN = 30;

export default function Jev() {
  const cfg = useServerConfig();
  const c = useSettingsColors();
  const { theme } = useUnistyles();
  const failed = theme.tokens.status.error;
  const server = cfg.server;
  const [advanced, setAdvanced] = useState(false);
  const [cliproxy, setCliproxy] = useState<JevAuxCliproxy | null>(null);
  const [applying, setApplying] = useState(false);
  const [cliproxyMsg, setCliproxyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [computer, setComputer] = useState<{ enabled: boolean } | { error: string } | null>(null);

  useEffect(() => {
    let live = true;
    setCliproxy(null);
    setComputer(null);
    setModels([]);
    if (!server) return;
    getJevAuxCliproxy(server).then((r) => { if (live) setCliproxy(r); }).catch(() => {});
    getComputerControlEnabled(server)
      .then((r) => { if (live) setComputer({ enabled: !!r.enabled }); })
      .catch((e: unknown) => { if (live) setComputer({ error: message(e) }); });
    return () => { live = false; };
  }, [server?.id, server?.baseUrl, server?.token]);

  const auxSupported = 'jev_aux_base_url' in cfg.fields;
  const url = textOf(cfg.current('jev_aux_base_url')).trim();
  const model = textOf(cfg.current('jev_aux_modelo')).trim();

  const fetchModels = () => {
    if (!server || fetching || !url) return;
    const key = textOf(cfg.draft.jev_aux_api_key).trim();
    setFetching(true);
    setModelsError('');
    listJevAuxModels(server, { base_url: url, api_key: key || null, use_saved_key: !key })
      .then((r) => { setModels(r.models); if (!r.models.length) setModelsError(m.browser_jev_aux_models_none()); })
      .catch((e: unknown) => { setModels([]); setModelsError(message(e)); })
      .finally(() => setFetching(false));
  };

  // Grava na hora, fora do rascunho: a chave do CLIProxyAPI só existe no servidor.
  const useCliproxy = () => {
    if (!server || !cliproxy || applying) return;
    setApplying(true);
    setCliproxyMsg(null);
    patchConfigForServer(server, { jev_aux_cliproxy: true, jev_aux_base_url: cliproxy.preset_url })
      .then(() => {
        cfg.unstage('jev_aux_base_url');
        cfg.unstage('jev_aux_api_key');
        cfg.reload();
        setCliproxyMsg({ ok: true, text: m.browser_jev_aux_cliproxy_done() });
      })
      .catch((e: unknown) => setCliproxyMsg({ ok: false, text: message(e) }))
      .finally(() => setApplying(false));
  };

  const shown = models.filter((id) => id !== model && (!model || id.toLowerCase().includes(model.toLowerCase()))).slice(0, SHOWN);

  return (
    <ServerConfigPage title={m.jev_title()} cfg={cfg}>
      <Muted>{m.jev_intro()}</Muted>

      <BlockHead title={m.browser_jev_decisions_title()} help={m.browser_jev_decisions_help()} />
      <Box>
        <ConfigRow cfg={cfg} k="jev_api_key" />
      </Box>
      <Disclosure open={advanced} label={m.jev_advanced()} onChange={setAdvanced} />
      {advanced ? (
        <Box>
          <ConfigRow cfg={cfg} k="jev_endpoint" />
          <ConfigRow cfg={cfg} k="jev_model" />
        </Box>
      ) : null}

      <BlockHead title={m.browser_jev_aux_title()} help={m.browser_jev_aux_help()} />
      {!auxSupported ? <Muted>{m.browser_jev_aux_unsupported()}</Muted> : (
        <>
          {cliproxy ? (
            <View style={styles.block}>
              <Muted>{!cliproxy.running ? m.browser_jev_aux_cliproxy_stopped({ url: cliproxy.preset_url })
                : cliproxy.has_keys ? m.browser_jev_aux_cliproxy_ready({ url: cliproxy.preset_url })
                : m.browser_jev_aux_cliproxy_no_key()}</Muted>
              <View style={styles.row}>
                <Pill label={m.browser_jev_aux_cliproxy_use()} onPress={useCliproxy}
                  disabled={applying || !cliproxy.running || !cliproxy.has_keys} />
              </View>
              {cliproxyMsg ? (
                <Text accessibilityLiveRegion="polite" style={[styles.note, { color: cliproxyMsg.ok ? c.muted : failed }]}>{cliproxyMsg.text}</Text>
              ) : null}
            </View>
          ) : null}
          <Box>
            <ConfigRow cfg={cfg} k="jev_aux_base_url" />
            <ConfigRow cfg={cfg} k="jev_aux_api_key" />
            <ConfigRow cfg={cfg} k="jev_aux_modelo" />
          </Box>
          <View style={styles.block}>
            <View style={styles.row}>
              <Pill label={fetching ? m.browser_jev_aux_models_fetching() : m.browser_jev_aux_models_fetch()}
                onPress={fetchModels} disabled={fetching || !url} />
            </View>
            {!url ? <Muted>{m.browser_jev_aux_models_need_url()}</Muted> : null}
            {modelsError ? <Text accessibilityRole="alert" style={[styles.note, { color: failed }]}>{modelsError}</Text> : null}
            {models.length ? <Muted>{m.browser_jev_aux_models_found({ n: String(models.length) })}</Muted> : null}
            {shown.length ? (
              <Box>
                {shown.map((id) => (
                  <Pressable key={id} accessibilityRole="button" accessibilityLabel={id} onPress={() => cfg.stage('jev_aux_modelo', id)}
                    style={({ pressed }) => [styles.model, { borderTopColor: c.border }, pressed && { backgroundColor: c.hover }]}>
                    <Text style={[styles.modelText, { color: c.text }]} numberOfLines={1}>{id}</Text>
                  </Pressable>
                ))}
              </Box>
            ) : null}
          </View>
          <Box>
            <ConfigRow cfg={cfg} k="jev_aux_esforco" />
          </Box>
        </>
      )}

      <BlockHead title={m.browser_jev_where_title()} />
      <Box>
        <ConfigRow cfg={cfg} k="jev_padrao" />
      </Box>
      <Muted>{m.browser_jev_where_orq()}</Muted>
      <Muted>{computer === null ? m.comum_carregando()
        : 'error' in computer ? m.browser_jev_where_cu_error({ e: computer.error })
        : computer.enabled ? m.browser_jev_where_cu_on() : m.browser_jev_where_cu_off()}</Muted>
    </ServerConfigPage>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  row: { flexDirection: 'row' },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  model: { paddingVertical: 10, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth },
  modelText: { fontSize: 14 },
});
