import { useEffect, useState, useCallback, useRef } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { getArchivePorCwd, getCodexAccountsForServer,
  getEnginesForServer, fetchSessionsForServer, listClaudeConfigsForServer, probeServerResponse,
  modelOptionsForServer, resumeArchivedConversation } from '@hangar/core';
import { basename, providerName, cotaDaConta, cotaParada, resumoCota, CLAUDE_PERMISSION_MODES, EFFORT_LEVELS } from '@hangar/core';
import type { ArchiveEntry, CodexAccount, ConfigDirInfo, Provider, ModelOption, CotaContaResumo, Server } from '@hangar/core';
import { MenuView } from '@react-native-menu/menu';
import { useServers } from '../../stores/servers';
import { rememberProject } from '../../stores/createPreferences';
import type { NewConversationInput } from '../../stores/newConversation';
import { CwdPicker } from './CwdPicker';
import { ProviderPicker } from './ProviderPicker';
import { CodexContextControl } from './CodexContextControl';
import { NewConversation } from './NewConversation';
import * as m from '../../paraglide/messages';

function valorModelo(mm: ModelOption): string {
  return mm.provider ? `${mm.provider}/${mm.id}` : mm.id;
}

// pequeno wrapper pra MenuView — renderiza botão com valor atual e abre menu nativo
function MenuSelect({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const actions = options.map((o) => ({
    id: o.value,
    title: o.label,
    subtitle: o.hint ?? undefined,
    state: (o.value === value ? 'on' : 'off') as 'on' | 'off',
  }));
  const label = options.find((o) => o.value === value)?.label ?? placeholder ?? '—';
  return (
    <MenuView actions={actions} onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}>
      <Pressable style={styles.selectBtn}>
        <Text style={styles.selectTxt} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.selectChevron}>›</Text>
      </Pressable>
    </MenuView>
  );
}

export function CreateSessionSheet({ onClose }: { onClose?: () => void }) {
  const active = useServers((s) => s.active());
  const target = active ?? useServers.getState().servers[0];
  return target ? <CreateSessionForm key={`${target.id}:${target.baseUrl}`} active={target} onClose={onClose} />
    : <Text accessibilityRole="alert">{m.servidor_nao_existe()}</Text>;
}

function CreateSessionForm({ active, onClose }: { active: Server; onClose?: () => void }) {
  const router = useRouter();

  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [hasSameFolder, setHasSameFolder] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [browse, setBrowse] = useState(false);
  const [projectWarning, setProjectWarning] = useState('');
  const pickGeneration = useRef(0);

  const [provider, setProvider] = useState<Provider>('claude');

  const [codexAccounts, setCodexAccounts] = useState<CodexAccount[]>([]);
  const [codexAccount, setCodexAccount] = useState('');
  const [codexLoading, setCodexLoading] = useState(false);
  const [codexError, setCodexError] = useState('');
  const [codexProgress, setCodexProgress] = useState('');
  const codexGeneration = useRef(0);
  const codexController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [retomaveis, setRetomaveis] = useState<ArchiveEntry[]>([]);
  const [retomavel, setRetomavel] = useState('');
  const [retomando, setRetomando] = useState(false);
  const archiveGeneration = useRef(0);
  const archiveController = useRef<AbortController | null>(null);

  const [configs, setConfigs] = useState<ConfigDirInfo[]>([]);
  // Cota por conta no seletor (/api/cotas, chave `claude:<path>`); falha = lista sem número.
  const [cotas, setCotas] = useState<CotaContaResumo[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const cotaSelecionada = selectedConfig ? cotaDaConta(cotas, selectedConfig) : undefined;
  const [motores, setMotores] = useState<Record<string, { label?: string; model?: string }>>({});
  const [engine, setEngine] = useState('');
  const [modelos, setModelos] = useState<ModelOption[]>([]);
  const [modelo, setModelo] = useState('');
  const [subagente, setSubagente] = useState('');
  const [esforco, setEsforco] = useState('');
  const [permissao, setPermissao] = useState('');
  const [listaReduzida, setListaReduzida] = useState(false);
  const [erroModelos, setErroModelos] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');

  const contaCodex = codexAccounts.find((account) => account.id === codexAccount);
  const codexReady = provider !== 'codex' || (!!active && !!contaCodex && contaCodex.auth.status === 'connected' && !codexLoading);
  const esforcosDoModelo = (value: string) => {
    const selected = modelos.find((model) => valorModelo(model) === value || model.id === value);
    return selected?.efforts ?? [];
  };
  const niveisEsforco = provider === 'codex' ? esforcosDoModelo(modelo) : (EFFORT_LEVELS[provider] ?? []);

  useEffect(() => {
    mounted.current = true;
    return () => {
    mounted.current = false;
    pickGeneration.current++;
    codexGeneration.current++;
    archiveGeneration.current++;
    codexController.current?.abort();
    archiveController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const generation = ++codexGeneration.current;
    codexController.current?.abort();
    const controller = new AbortController();
    codexController.current = controller;
    setCodexAccounts([]);
    setCodexAccount('');
    setCodexError('');
    setCodexProgress('');
    setRetomando(false);
    if (provider !== 'codex' || !active) {
      setCodexLoading(false);
      return () => { controller.abort(); codexGeneration.current++; };
    }
    setCodexLoading(true);
    void getCodexAccountsForServer(active, controller.signal)
      .then((accounts) => {
        if (generation !== codexGeneration.current || controller.signal.aborted) return;
        setCodexAccounts(accounts);
        setCodexAccount((accounts.find((account) => account.is_default) ?? accounts[0])?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (generation !== codexGeneration.current || controller.signal.aborted) return;
        setCodexError(cause instanceof Error ? cause.message : m.codex_ui_login_error());
      })
      .finally(() => {
        if (generation === codexGeneration.current && !controller.signal.aborted) setCodexLoading(false);
      });
    return () => { controller.abort(); codexGeneration.current++; };
  }, [provider, active, active?.id, active?.baseUrl, active?.token]);

  // Cada catálogo pertence ao destino capturado, mesmo após trocar de máquina.
  useEffect(() => {
    let alive = true;
    setConfigs([]);
    setSelectedConfig(null);
    setMotores({});
    setEngine('');
    setCotas([]);
    setCatalogError('');
    void listClaudeConfigsForServer(active)
      .then((cs) => {
        if (!alive) return;
        setConfigs(cs);
        const sel = cs.find((c) => c.active)?.path ?? cs[0]?.path ?? null;
        setSelectedConfig(sel);
      })
      .catch((cause: unknown) => {
        if (alive) setCatalogError(cause instanceof Error ? cause.message : m.criar_sessao_erro());
      });
    void probeServerResponse(active, '/api/cotas')
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<CotaContaResumo[]>;
      })
      .then((cs) => {
        if (alive) setCotas(cs);
      })
      .catch(() => {});
    void getEnginesForServer(active)
      .then((r) => {
        if (alive) {
          setMotores(r.motores);
          if (r.arquivo_corrompido) setCatalogError(m.criar_motores_erro());
        }
      })
      .catch((cause: unknown) => {
        if (alive) setCatalogError(cause instanceof Error ? cause.message : m.criar_motores_erro());
      });
    return () => {
      alive = false;
    };
  }, [active]);

  // modelos quando provider/config/engine mudam
  useEffect(() => {
    // reset incondicional — igual à PWA (CreateSessionSheet.svelte:141), evita vazar modelo/esforço pro Codex
    setModelo('');
    setModelos([]);
    setEsforco('');
    setSubagente('');
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'pi' && provider !== 'kimi') {
      setModelos([]);
      setListaReduzida(false);
      setErroModelos('');
      return;
    }
    if (provider === 'codex' && (!active || !codexAccount)) {
      setModelos([]);
      setListaReduzida(false);
      setErroModelos('');
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setErroModelos('');
    const request = provider === 'codex'
      ? modelOptionsForServer(active!, 'codex', null, null, codexAccount, controller.signal)
      : modelOptionsForServer(active, provider, engine || null, selectedConfig, null, controller.signal);
    void request
      .then((r) => {
        if (!alive) return;
        setModelos(r.models);
        setListaReduzida(r.reduced);
      })
      .catch((e) => {
        if (!alive) return;
        setModelos([]);
        setErroModelos(e instanceof Error ? e.message : m.criar_modelos_erro());
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [provider, engine, selectedConfig, codexAccount, active, active?.id, active?.baseUrl, active?.token]);

  useEffect(() => {
    const generation = ++archiveGeneration.current;
    archiveController.current?.abort();
    const controller = new AbortController();
    archiveController.current = controller;
    setRetomaveis([]);
    setRetomavel('');
    setRetomando(false);
    if (provider !== 'codex' || !picked || !active || !codexAccount) return () => { controller.abort(); archiveGeneration.current++; };
    void getArchivePorCwd(picked, null, 'codex', codexAccount, active, controller.signal)
      .then((entries) => {
        if (generation !== archiveGeneration.current || controller.signal.aborted) return;
        setRetomaveis(entries.filter((entry) => !entry.live));
      })
      .catch(() => {
        if (generation === archiveGeneration.current && !controller.signal.aborted) setRetomaveis([]);
      });
    return () => { controller.abort(); archiveGeneration.current++; };
  }, [provider, picked, codexAccount, active, active?.id, active?.baseUrl, active?.token]);

  const handlePick = useCallback(async (p: string, root?: string) => {
    const generation = ++pickGeneration.current;
    setPicked(p);
    setBrowse(false);
    setError('');
    setProjectWarning('');
    if (root) {
      try { rememberProject(active.id, { root, cwd: p }); }
      catch { setProjectWarning(m.criar_projeto_salvar_erro()); }
    }
    setHasSameFolder(false);
    try {
      const sessions = await fetchSessionsForServer(active);
      if (!mounted.current || generation !== pickGeneration.current) return;
      setHasSameFolder(sessions.some((s) => s.cwd === p));
    } catch (cause: unknown) {
      if (!mounted.current || generation !== pickGeneration.current) return;
      setError(cause instanceof Error ? cause.message : m.criar_sessao_erro());
    }
  }, [active]);

  const handleManual = () => {
    const p = manualPath.trim();
    if (p) void handlePick(p);
  };

  // Nome em branco: o store gera projeto + sufixo da tentativa.
  const settings: Omit<NewConversationInput['body'], 'cwd'> = provider === 'codex'
    ? { provider: 'codex', model: modelo || null, effort: esforco || null, codex_account: codexAccount }
    : {
      provider,
      config_dir: provider === 'claude' ? selectedConfig : null,
      engine: provider === 'claude' ? engine || null : null,
      model: (provider === 'claude' || provider === 'pi' || provider === 'kimi') ? modelo || null : null,
      effort: (provider === 'claude' || provider === 'pi') ? esforco || null : null,
      permission_mode: provider === 'claude' ? permissao || null : null,
      subagent_model: provider === 'claude' && !engine ? subagente || null : null,
    };
  const body = picked && codexReady ? { ...settings, cwd: picked, ...(name.trim() ? { name: name.trim() } : {}) } : null;

  const handleResume = async () => {
    const entry = retomaveis.find((candidate) => candidate.session_id === retomavel);
    if (!entry || !active || retomando) return;
    const generation = archiveGeneration.current;
    const codexGenerationAtStart = codexGeneration.current;
    const target = active;
    setRetomando(true);
    setError('');
    try {
      setCodexProgress(m.codex_ui_abrindo_sessao());
      const session = await resumeArchivedConversation(entry.project, entry.session_id, null, null,
        'codex', entry.codex_account ?? codexAccount, target);
      if (!mounted.current || generation !== archiveGeneration.current || codexGenerationAtStart !== codexGeneration.current) return;
      router.replace((`/s/${target.id}/${session.name}` as never) as never);
    } catch (cause: unknown) {
      if (mounted.current && generation === archiveGeneration.current && codexGenerationAtStart === codexGeneration.current) {
        setError(cause instanceof Error ? cause.message : m.criar_sessao_erro());
      }
    } finally {
      if (mounted.current && generation === archiveGeneration.current && codexGenerationAtStart === codexGeneration.current) {
        setRetomando(false);
        setCodexProgress('');
      }
    }
  };

  const destination = (
    <View style={styles.field}>
      <Text style={styles.label}>{active.label}</Text>
      {picked ? (
        <Pressable
          onPress={() => { pickGeneration.current++; setBrowse(true); setPicked(null); }}
          style={styles.picked}
          accessibilityRole="button"
          accessibilityLabel={m.criar_outra_pasta()}
        >
          <Text style={styles.pickedName}>{basename(picked)}</Text>
          <Text style={styles.pickedPath}>{picked}</Text>
          <Text style={styles.hintSm}>{m.criar_outra_pasta()}</Text>
        </Pressable>
      ) : (
        <>
          <View style={styles.pickerWrap}>
            <CwdPicker server={active} onPick={handlePick} selected={picked} autoSelect={!browse} />
          </View>
          <View style={styles.advanced}>
            <Pressable onPress={() => setManualOpen((v) => !v)} style={styles.advToggle}>
              <Text style={styles.advTxt}>{m.criar_avancado()}</Text>
              <Text style={[styles.chev, manualOpen && styles.chevOpen]}>›</Text>
            </Pressable>
            {manualOpen ? (
              <View style={styles.manualForm}>
                <TextInput
                  style={styles.input}
                  value={manualPath}
                  onChangeText={setManualPath}
                  placeholder={m.criar_caminho_placeholder()}
                  placeholderTextColor="#8d8489"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable onPress={handleManual} disabled={!manualPath.trim()} style={[styles.manualGo, !manualPath.trim() && styles.manualGoDis]}>
                  <Text style={styles.manualGoTxt}>{m.criar_usar()}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </>
      )}
    </View>
  );

  const selectedModel = modelos.find((model) => valorModelo(model) === modelo || model.id === modelo);
  const modelLabel = modelo ? selectedModel?.name ?? modelo : m.criar_padrao();
  const settingsLabel = retomavel
    ? `${providerName(provider)} · ${m.criar_retomar()}`
    : [providerName(provider), settings.engine ? motores[engine]?.label ?? engine : null, modelLabel, settings.effort].filter(Boolean).join(' · ');
  const destinationSummary = <Text style={styles.summary} numberOfLines={2}>{active.label} · {picked || m.nova_conversa_sem_destino()}</Text>;
  const settingsSummary = <Text style={styles.summary} numberOfLines={2}>{settingsLabel}</Text>;
  const quotaNotice = provider === 'claude' && cotaSelecionada ? (
    <Text style={styles.hint}>
      {resumoCota(cotaSelecionada) ||
        `${m.cota_sem_cota()} ${
          cotaSelecionada.estado === 'indisponivel'
            ? (cotaParada(cotaSelecionada) ? m.cota_conta_parada() : '')
            : m.cota_precisa_entrar()
        }`.trim()}
    </Text>
  ) : null;

  const notices = (
    <View style={styles.field}>
      {hasSameFolder ? <Text style={styles.hint}>{m.criar_ja_existe()}</Text> : null}
      {picked && !codexReady ? (
        codexError ? <Text style={styles.error} accessibilityRole="alert">{codexError}</Text>
          : <Text style={styles.hint}>{codexLoading ? m.comum_carregando() : m.contas_nao_conectada()}</Text>
      ) : null}
      {projectWarning ? <Text style={styles.error} accessibilityRole="alert">{projectWarning}</Text> : null}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      {catalogError ? <Text style={styles.error} accessibilityRole="alert">{catalogError}</Text> : null}
      {!retomavel && listaReduzida ? <Text style={styles.hint}>{m.criar_lista_reduzida()}</Text> : null}
      {!retomavel && erroModelos ? <Text style={styles.hint} accessibilityRole="alert">{m.criar_abre_padrao({ erro: erroModelos } as any)}</Text> : null}
      {quotaNotice}
      {contextBusy ? <Text style={styles.hint} accessibilityLiveRegion="polite">{m.comum_carregando()}</Text> : null}
      {retomavel ? <Text style={styles.hint}>{m.nova_conversa_retomada_selecionada()}</Text> : null}
      {provider === 'codex' && retomando && codexProgress ? <Text style={styles.hint} accessibilityLiveRegion="polite">{codexProgress}</Text> : null}
    </View>
  );

  const options = (
    <>
      {!retomavel ? (
        <View style={styles.field}>
          <Text style={styles.label}>{m.comum_nome()}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder={m.criar_nome_placeholder()}
            accessibilityLabel={m.comum_nome()}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor="#8d8489"
          />
          <Text style={styles.hintSm}>{m.nova_conversa_nome_automatico()}</Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>{m.comum_provider()}</Text>
        <ProviderPicker value={provider} onChange={(p) => setProvider(p)} />
      </View>

      {provider === 'codex' ? <CodexContextControl server={active ?? null} onBusy={setContextBusy} /> : null}

      {provider === 'codex' ? (
        <View style={styles.field}>
          <Text style={styles.label}>{m.criar_conta_aria()}</Text>
          {codexLoading ? <Text style={styles.hint}>{m.comum_carregando()}</Text> : null}
          {codexError ? <Text style={styles.error} accessibilityRole="alert">{codexError}</Text> : null}
          <MenuSelect
            value={codexAccount}
            options={codexAccounts.map((account) => ({
              value: account.id,
              label: account.name,
              hint: account.auth.status === 'connected'
                ? (account.auth.email ?? m.codex_ui_account())
                : account.auth.status === 'disconnected' ? m.contas_nao_conectada() : m.codex_ui_unknown(),
            }))}
            onChange={(value) => {
              codexGeneration.current++;
              archiveGeneration.current++;
              setRetomando(false);
              setRetomavel('');
              setError('');
              setCodexProgress('');
              setCodexAccount(value);
            }}
          />
          {contaCodex?.auth.status !== 'connected' ? <Text style={styles.hint}>{m.contas_nao_conectada()}</Text> : null}
        </View>
      ) : null}

      {provider === 'claude' && configs.length > 1 ? (
        <View style={styles.field}>
          <Text style={styles.label}>{m.comum_conta_claude()}</Text>
          <MenuSelect
            value={selectedConfig ?? ''}
            options={configs.map((c) => ({
              value: c.path,
              label: c.label,
              hint: [c.active ? (m.switcher_atual() as string) : '', resumoCota(cotaDaConta(cotas, c.path))]
                .filter(Boolean).join(' · ') || undefined,
            }))}
            onChange={(v) => setSelectedConfig(v)}
          />
          {quotaNotice}
        </View>
      ) : null}

      {provider === 'claude' && Object.keys(motores).length ? (
        <View style={styles.field}>
          <Text style={styles.label}>{m.comum_motor()}</Text>
          <MenuSelect
            value={engine}
            options={[{ value: '', label: m.criar_claude_sua_conta() }, ...Object.entries(motores).map(([k, v]) => ({ value: k, label: (v as any).label ?? k, hint: (v as any).model }))]}
            onChange={(v) => setEngine(v)}
          />
        </View>
      ) : null}

      {!retomavel && (provider === 'claude' || provider === 'codex' || provider === 'pi' || provider === 'kimi') && (
        <View style={styles.field}>
          <Text style={styles.label}>{m.composer_modelo()}</Text>
          <MenuSelect
            value={modelo}
            options={[{ value: '', label: m.criar_padrao() }, ...modelos.map((md) => ({ value: valorModelo(md), label: md.name ?? md.id, hint: [md.provider, (md as any).context ?? ((md as any).context_length ? `${Math.round(((md as any).context_length) / 1000)}K` : null), ((md as any).vision ?? (md as any).images) ? '👁' : null].filter(Boolean).join(' · ') }))]}
            onChange={(v) => { setModelo(v); if (provider === 'codex' && !esforcosDoModelo(v).includes(esforco)) setEsforco(''); }}
          />
          {listaReduzida ? <Text style={styles.hintSm}>{m.criar_lista_reduzida()}</Text> : null}
          {erroModelos ? <Text style={styles.hintSm}>{m.criar_abre_padrao({ erro: erroModelos } as any)}</Text> : null}
        </View>
      )}

      {!retomavel && niveisEsforco.length > 0 && (
        <View style={styles.field}>
          <Text style={styles.label}>{provider === 'pi' ? (m.criar_raciocinio()) : (m.composer_esforco())}</Text>
          <MenuSelect
            value={esforco}
            options={[{ value: '', label: m.criar_padrao() }, ...niveisEsforco.map((n) => ({ value: n, label: n }))]}
            onChange={(v) => setEsforco(v)}
          />
        </View>
      )}

      {provider === 'claude' && (
        <View style={styles.field}>
          <Text style={styles.label}>{m.criar_permissao()}</Text>
          <MenuSelect
            value={permissao}
            options={[{ value: '', label: m.criar_permissao_padrao() }, ...CLAUDE_PERMISSION_MODES.map((n) => ({ value: n, label: n }))]}
            onChange={(v) => setPermissao(v)}
          />
        </View>
      )}

      {provider === 'claude' && !engine && modelos.length > 0 && (
        <View style={styles.field}>
          <Text style={styles.label}>{m.criar_subagente()}</Text>
          <MenuSelect
            value={subagente}
            options={[{ value: '', label: m.criar_subagente_padrao() }, ...modelos.filter((md) => md.id !== 'default').map((md) => ({ value: valorModelo(md), label: md.name ?? md.id }))]}
            onChange={(v) => setSubagente(v)}
          />
          <Text style={styles.hintSm}>{m.criar_subagente_ajuda()}</Text>
        </View>
      )}

      {provider === 'codex' && retomaveis.length ? (
        <View style={styles.field}>
          <Text style={styles.label}>{m.criar_retomar()}</Text>
          <MenuSelect
            value={retomavel}
            options={[{ value: '', label: m.criar_retomar_escolha() }, ...retomaveis.map((entry) => ({ value: entry.session_id, label: entry.ultima || entry.preview || entry.session_id }))]}
            onChange={setRetomavel}
          />
          <Pressable
            onPress={() => void handleResume()}
            disabled={!retomavel || retomando || !codexReady}
            style={[styles.ghostButton, (!retomavel || retomando || !codexReady) && styles.primaryDis]}
          >
            <Text style={styles.ghostTxt}>{retomando ? m.criar_criando() : m.criar_retomar_acao()}</Text>
          </Pressable>
        </View>
      ) : null}

      {provider === 'codex' && retomando && codexProgress ? (
        <View style={styles.rowCenter}>
          <ActivityIndicator />
          <Text style={[styles.hint, { flex: 1 }]} accessibilityLiveRegion="polite">{codexProgress}</Text>
        </View>
      ) : null}
    </>
  );

  return (
    <NewConversation
      server={active}
      destination={destination}
      destinationPending={!picked}
      destinationSummary={destinationSummary}
      settingsSummary={settingsSummary}
      notices={notices}
      options={options}
      body={body}
      blocked={contextBusy || retomando || !!retomavel || (!!picked && !codexReady)}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  pickerWrap: { minHeight: 380, flex: 1 },
  advanced: { borderTopWidth: 1, borderTopColor: theme.tokens.border.subtle, paddingTop: theme.base.space[3], gap: theme.base.space[2] },
  advToggle: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  advTxt: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary },
  chev: { color: theme.tokens.text.muted, fontSize: 18 },
  chevOpen: { transform: [{ rotate: '90deg' }] } as any,
  manualForm: { flexDirection: 'row', gap: theme.base.space[2] },
  input: {
    flex: 1,
    height: 44,
    backgroundColor: theme.tokens.bg.surface,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    borderRadius: theme.base.radius.md,
    color: theme.tokens.text.primary,
    fontSize: 16,
    paddingHorizontal: theme.base.space[3],
  },
  manualGo: {
    height: 44,
    paddingHorizontal: theme.base.space[4],
    borderRadius: theme.base.radius.md,
    backgroundColor: theme.tokens.accent.dim,
    justifyContent: 'center',
  },
  manualGoDis: { opacity: 0.5 },
  manualGoTxt: { color: theme.tokens.text.primary, fontWeight: '600', fontSize: theme.base.text.sm },
  picked: {
    padding: theme.base.space[3],
    backgroundColor: theme.tokens.bg.surface,
    borderWidth: 1,
    borderColor: theme.tokens.border.subtle,
    borderRadius: theme.base.radius.md,
    gap: 2,
  },
  pickedName: { fontSize: theme.base.text.lg, fontWeight: '600', color: theme.tokens.text.primary },
  pickedPath: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  summary: { fontSize: theme.base.text.sm, color: theme.tokens.text.primary },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hint: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary },
  hintSm: { fontSize: 12, color: theme.tokens.text.muted, marginTop: 4 },
  field: { gap: theme.base.space[2] },
  label: { fontSize: theme.base.text.sm, color: theme.tokens.text.secondary, fontWeight: '500' },
  selectBtn: {
    height: 44,
    backgroundColor: theme.tokens.bg.surface,
    borderWidth: 1,
    borderColor: theme.tokens.border.default,
    borderRadius: theme.base.radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.base.space[3],
  },
  selectTxt: { color: theme.tokens.text.primary, fontSize: 16, flex: 1 },
  selectChevron: { color: theme.tokens.text.muted, fontSize: 18, marginLeft: 8 },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.sm },
  primaryDis: { opacity: 0.5 },
  ghostButton: { height: 44, borderWidth: 1, borderColor: theme.tokens.border.default, borderRadius: theme.base.radius.md, justifyContent: 'center', alignItems: 'center' },
  ghostTxt: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm },
}));
