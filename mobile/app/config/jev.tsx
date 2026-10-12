import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getComputerControlEnabled, getJevAuxCliproxy, listJevAuxModels, patchConfigForServer, sameJevAuxUrl, type JevAuxCliproxy } from '@hangar/core';
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
  // `url`: o endereço gravado; editar o campo depois tira a mensagem da tela.
  const [cliproxyMsg, setCliproxyMsg] = useState<{ ok: boolean; text: string; url: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  // Endereço e chave da última busca: lista e erro só valem enquanto os campos forem esses.
  const [fetchedFor, setFetchedFor] = useState('');
  const [fetching, setFetching] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [computer, setComputer] = useState<{ enabled: boolean } | { error: string } | null>(null);
  const [cliproxyError, setCliproxyError] = useState('');
  // Troca de servidor no meio de uma chamada: a resposta do anterior não pinta esta tela.
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    const live = () => g === gen.current;
    setCliproxy(null);
    setCliproxyError('');
    setCliproxyMsg(null);
    setApplying(false);
    setFetching(false);
    setComputer(null);
    setModels([]);
    setModelsError('');
    if (!server) return;
    // 404 é servidor sem o atalho (versão anterior): só aí o atalho some calado.
    getJevAuxCliproxy(server)
      .then((r) => { if (live()) setCliproxy(r); })
      .catch((e: unknown) => { if (live() && (e as { status?: number }).status !== 404) setCliproxyError(message(e)); });
    getComputerControlEnabled(server)
      .then((r) => { if (live()) setComputer({ enabled: !!r.enabled }); })
      .catch((e: unknown) => { if (live()) setComputer({ error: message(e) }); });
    return () => { gen.current++; };
  }, [server?.id, server?.baseUrl, server?.token]);

  const auxSupported = 'jev_aux_base_url' in cfg.fields;
  const url = textOf(cfg.current('jev_aux_base_url')).trim();
  const model = textOf(cfg.current('jev_aux_modelo')).trim();
  const fetchKey = `${url}\n${textOf(cfg.draft.jev_aux_api_key).trim()}`;
  const fetchValid = fetchedFor === fetchKey;
  const shownMsg = cliproxyMsg && cliproxyMsg.url === url ? cliproxyMsg : null;

  const fetchModels = () => {
    if (!server || fetching || !url) return;
    const key = textOf(cfg.draft.jev_aux_api_key).trim();
    const g = gen.current;
    setFetching(true);
    setModelsError('');
    setFetchedFor(fetchKey);
    const saved = !key && sameJevAuxUrl(url, cfg.fields.jev_aux_base_url?.valor);
    listJevAuxModels(server, { base_url: url, api_key: key || null, use_saved_key: saved })
      .then((r) => { if (g !== gen.current) return; setModels(r.models); if (!r.models.length) setModelsError(m.browser_jev_aux_models_none()); })
      .catch((e: unknown) => { if (g !== gen.current) return; setModels([]); setModelsError(message(e)); })
      .finally(() => { if (g === gen.current) setFetching(false); });
  };

  // Grava na hora, fora do rascunho: a chave do CLIProxyAPI só existe no servidor.
  const applyCliproxy = () => {
    if (!server || !cliproxy || applying) return;
    const g = gen.current;
    setApplying(true);
    setCliproxyMsg(null);
    const target = cliproxy.preset_url;
    patchConfigForServer(server, { jev_aux_cliproxy: true, jev_aux_base_url: target })
      .then(() => {
        if (g !== gen.current) return;
        cfg.unstage('jev_aux_base_url');
        cfg.unstage('jev_aux_api_key');
        cfg.reload();
        setCliproxyMsg({ ok: true, text: m.browser_jev_aux_cliproxy_done(), url: target });
        // A região viva só existe no Android: no iOS o leitor de tela precisa do anúncio.
        AccessibilityInfo.announceForAccessibility(m.browser_jev_aux_cliproxy_done());
      })
      .catch((e: unknown) => {
        if (g !== gen.current) return;
        setCliproxyMsg({ ok: false, text: message(e), url });
        AccessibilityInfo.announceForAccessibility(message(e));
      })
      .finally(() => { if (g === gen.current) setApplying(false); });
  };

  // O nome já escolhido conta como achado (só não repete na lista): "nenhum" só quando nada contém o texto.
  const containing = fetchValid ? models.filter((id) => !model || id.toLowerCase().includes(model.toLowerCase())) : [];
  const matching = containing.filter((id) => id !== model);
  const shown = matching.slice(0, SHOWN);

  return (
    // Releitura que falha depois do atalho troca a página pelo erro: o "gravado" fica embaixo dele.
    <ServerConfigPage title={m.jev_title()} cfg={cfg} extra={cfg.load.status !== 'ready' && cliproxyMsg ? (
      <Text accessibilityLiveRegion="polite" style={[styles.note, { color: cliproxyMsg.ok ? c.muted : failed }]}>{cliproxyMsg.text}</Text>
    ) : null}>
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
                <Pill label={m.browser_jev_aux_cliproxy_use()} onPress={applyCliproxy}
                  disabled={applying || !cliproxy.running || !cliproxy.has_keys} />
              </View>
              {shownMsg ? (
                <Text accessibilityLiveRegion="polite" style={[styles.note, { color: shownMsg.ok ? c.muted : failed }]}>{shownMsg.text}</Text>
              ) : null}
            </View>
          ) : cliproxyError ? (
            <Text accessibilityRole="alert" style={[styles.note, { color: failed }]}>{m.browser_jev_aux_cliproxy_error({ e: cliproxyError })}</Text>
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
            {fetchValid && modelsError ? <Text accessibilityRole="alert" style={[styles.note, { color: failed }]}>{modelsError}</Text> : null}
            {fetchValid && models.length ? (
              <Muted>{!containing.length ? m.browser_jev_aux_models_no_match()
                : matching.length > SHOWN ? m.browser_jev_aux_models_cut({ shown: String(SHOWN), n: String(matching.length) })
                : m.browser_jev_aux_models_found({ n: String(models.length) })}</Muted>
            ) : null}
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
  // 44 pt: alvo de toque mínimo.
  model: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth },
  modelText: { fontSize: 14 },
});
