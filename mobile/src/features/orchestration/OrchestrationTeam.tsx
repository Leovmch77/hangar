import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Platform, Pressable, ScrollView, Switch, Text, TextInput, View, type ListRenderItemInfo } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useIsFocused } from 'expo-router';
import { useHeaderHeight, useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import { casarViva, contaMedida, estadoDoPapel, getEnginesForServer, probeServerResponse, resumoCota, type CotaContaResumo, type Motor, comecarOrq, removerPapel, contasLiberadas, effortLevels, etapasDoTime, faixaDe, formataErro, getOrqGrupo, getOrqPoliticaForServer, hasExecutionMode, modelosLiberados, permissionModes, politicaDe, postOrqPapeis, retentarAgora, type AggSession, type OrqGrupo, type OrqPolitica, type Papel, type Provider, type Server } from '@hangar/core';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { ProviderPicker } from '../create/ProviderPicker';
import { PillMenu, type PillMenuItem } from '../pills/PillMenu';
import { permissionLabel } from '../pills/permissionLabel';
import { Sheet } from '../../ui/Sheet';
import { Icon } from '../../ui/Icon';
import { useServers } from '../../stores/servers';
import { useSessions } from '../../stores/sessions';
import * as m from '../../paraglide/messages';

const NO_LIVE: AggSession[] = [];
const serverKey = (server: Server) => JSON.stringify([server.id, server.baseUrl, server.token]);
const roleKey = (role: Papel) => JSON.stringify([role.papel, role.vez ?? '']);
const errorText = (error: unknown) => formataErro(error) ?? String(error);
function readiness(group: OrqGrupo): string {
  const ready = group.prontidao;
  const plano = ready?.plan?.path ?? '';
  if (ready?.phase === 'arbiter') return m.orqcfg_fase_arbiter({ plano });
  if (ready?.phase === 'launch') return m.orqcfg_fase_launch({ plano });
  if (ready?.phase === 'prepare') return ready.plan?.state === 'changed' ? m.orqcfg_fase_changed({ plano }) : m.orqcfg_fase_prepare({ plano });
  return m.orqcfg_fase_planner();
}
function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={[styles.action, disabled && styles.disabled]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}
const RoleRow = memo(function RoleRow({ role, rowKey, quota, edited, onSelect }: { role: Papel; rowKey: string; quota: string; edited: boolean; onSelect: (key: string) => void }) {
  return <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel={[role.papel, role.vez ? m.orqcfg_vez_n({ n: role.vez }) : null].filter(Boolean).join(', ')} onPress={() => onSelect(rowKey)}>
    <Text style={styles.title}>{role.papel}</Text>
    {role.vez ? <Text style={styles.note}>{m.orqcfg_vez_n({ n: role.vez })}</Text> : null}
    <Text style={styles.note}>{[role.conta, role.modelo, role.esforco].filter(Boolean).join(' · ')}</Text>
    <Text style={styles.note}>{quota}</Text>
    {edited ? <Text style={styles.note}>{m.orqcfg_editado()}</Text> : null}
  </Pressable>;
});

export function OrchestrationTeam({ serverId, name }: { serverId: string; name: string }) {
  return <TeamRoute key={`${serverId}:${name}`} serverId={serverId} name={name} />;
}
function TeamRoute({ serverId, name }: { serverId: string; name: string }) {
  const header = useHeaderHeight();
  const ready = useServers(state => state.ready);
  const server = useServers(state => state.servers.find(item => item.id === serverId && !item.removed) ?? null);
  const live = useSessions(state => state.byServerRecord[serverId] ?? NO_LIVE);
  const retain = useSessions(state => state.retain);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const source = live.find(item => item.name === name);
  const synthetic = source?.provider === 'orq';
  const realName = !source ? null : synthetic ? (live.some(item => item.name === source.orq_arbiter) ? source.orq_arbiter ?? null : null) : name;
  const targetLife = live.find(item => item.name === realName)?.jsonl ?? '';
  const lastResolved = useRef<{ server: Server; name: string } | null>(null);
  if (ready && server && !server.invite && realName) lastResolved.current = { server, name: realName };
  const active = focused && foreground;
  useEffect(() => { const subscription = AppState.addEventListener('change', state => setForeground(state === 'active')); return () => subscription.remove(); }, []);
  useEffect(() => { if (ready && server && !server.invite && active) return retain(); }, [ready, server, active, retain]);
  const stillTarget = useCallback(() => {
    const current = useServers.getState().servers.find(item => item.id === serverId && !item.removed && !item.invite);
    if (!ready || !current || !server || !realName || serverKey(current) !== serverKey(server)) return false;
    const rows = useSessions.getState().byServerRecord[serverId] ?? NO_LIVE;
    const route = rows.find(item => item.name === name);
    const target = rows.find(item => item.name === realName);
    if (!route || !target || (route.provider === 'orq') !== synthetic) return false;
    if (synthetic && route.orq_arbiter !== realName) return false;
    return (target.jsonl ?? '') === targetLife;
  }, [ready, serverId, server, name, realName, targetLife, synthetic]);
  const error = ready && !server ? m.chat_servidor_removido() : server?.invite ? m.lista_acesso_recusado() : ready && !realName ? m.erro_sessao_orq() : null;
  const resolved = lastResolved.current;
  if (!resolved && error) return <View style={[styles.status, { paddingTop: header }]}><Text accessibilityRole="alert" style={styles.error}>{error}</Text></View>;
  if (!resolved) return <View style={[styles.status, { paddingTop: header }]}><ActivityIndicator /><Text style={styles.note}>{m.orqcfg_carregando()}</Text></View>;
  const available = ready && !!server && !server.invite && !!realName;
  const targetKey = JSON.stringify([server && serverKey(server), realName, targetLife, available]);
  return <TeamEditor server={resolved.server} name={resolved.name} active={active} available={available} targetKey={targetKey} routeError={error} stillTarget={stillTarget} live={live} />;
}
type Drafts = Record<string, Papel>;
type TeamRow = { key: string; role: Papel; edited: boolean };
type PendingWrite = { timer: ReturnType<typeof setTimeout> | null; abandoned: boolean; abandon: () => void };
type WriteRequests = { pending: Set<Promise<unknown>>; settled: number };
const writeRequests = new Map<string, WriteRequests>();
const writeScope = (server: Server, name: string) => JSON.stringify([server.id, server.baseUrl, name]);
const rowKey = (row: TeamRow) => row.key;
const normalizeName = (value: string) => value.trim().replace(/^`+|`+$/g, '').replace(/\*\*/g, '').trim().normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').toLowerCase();
function editable(role: Papel): Papel {
  return { papel: role.papel, vez: role.vez ?? '', sessao: role.sessao, provider: role.provider || 'claude', conta: role.conta, modelo: role.modelo, esforco: role.esforco,
    headless: role.headless ?? null, permissao: role.permissao ?? '', motor: role.motor ?? '', jev: role.jev ?? false, subagente: role.subagente ?? '', perfil: role.perfil ?? '', janela: role.janela ?? '', viva: null };
}
function accountPatch(role: Papel, conta: string, policy: OrqPolitica, keepDefault = true): Partial<Papel> {
  const provider = role.provider || 'claude';
  const rule = politicaDe(policy.politica, provider, conta, policy.inventario);
  const inventory = policy.inventario.find(item => item.provider === provider && item.conta === conta) ?? null;
  const models = modelosLiberados(inventory, rule);
  const modelo = rule?.trocar && ((keepDefault && !role.modelo) || models.some(item => item.id === role.modelo)) ? role.modelo : models[0]?.id ?? '';
  const efforts = effortLevels(provider, models.map(({ id, efforts }) => ({ id, efforts })), modelo);
  return { conta, modelo, esforco: efforts.includes(role.esforco) ? role.esforco : '' };
}
function sessionName(role: Papel, group: OrqGrupo, name: string): string {
  const prefix = group.session_prefix || name;
  const base = normalizeName(faixaDe(role.papel).base);
  const suffix = ({ arbitro: 'arbitro', executor: 't*', revisor: 'review*', 'revisao final': 'final', 'par de research': 'mock' } as Record<string, string>)[base]
    ?? `${base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}*`;
  return `${prefix.endsWith('-') ? prefix : `${prefix}-`}${suffix}`;
}
function Choice({ label, value, items, onChange, disabled = false, emptyText }: { label: string; value: string; items: PillMenuItem[]; onChange: (value: string) => void; disabled?: boolean; emptyText?: string }) {
  const [open, setOpen] = useState(false);
  const choices = items.some(item => (item.id ?? item.label) === value) || !value ? items : [...items, { id: value, label: value }];
  const display = choices.find(item => (item.id ?? item.label) === value)?.label ?? value;
  return <>
    <Pressable style={styles.choice} accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: display }} accessibilityState={{ disabled }} disabled={disabled} onPress={() => setOpen(true)}>
      <View style={styles.grow}><Text style={styles.note}>{label}</Text><Text style={styles.title}>{display || m.config_motores_padrao()}</Text></View><Icon name="ChevronDown" size={16} />
    </Pressable>
    {open && !disabled ? <PillMenu open title={label} items={choices.map(item => ({ ...item, selected: (item.id ?? item.label) === value }))} emptyText={emptyText} onClose={() => setOpen(false)} onSelect={item => { onChange(item.id ?? item.label); setOpen(false); }} /> : null}
  </>;
}
function RoleDetail({ role, existing, policy, busy, writeBlocked, engines, quota, live, error, notice, auxiliaryError, onChange, onClose, onSave, onDiscard, onRemove }: { role: Papel; existing: boolean; policy: OrqPolitica; busy: boolean; writeBlocked: boolean; engines: Record<string, Motor>; quota: string; live: AggSession | null; error: string | null; notice: string | null; auxiliaryError: string; onChange: (patch: Partial<Papel>) => void; onClose: () => void; onSave: () => void; onDiscard: () => void; onRemove: () => void }) {
  const provider = role.provider || 'claude';
  const locked = busy || writeBlocked;
  const measured = estadoDoPapel(role, live);
  const accounts = contasLiberadas(policy.politica, policy.inventario, provider);
  const rule = politicaDe(policy.politica, provider, role.conta, policy.inventario);
  const inventory = policy.inventario.find(item => item.provider === provider && item.conta === role.conta) ?? null;
  const models = modelosLiberados(inventory, rule);
  const defaultItem = { id: '', label: m.config_motores_padrao() };
  const effortModels = models.map(({ id, efforts }) => ({ id, efforts }));
  const levels = effortLevels(provider, effortModels, role.modelo);
  const modes = permissionModes(provider, role.headless === true);
  const switchProvider = (next: Provider) => {
    const reset: Papel = { ...role, provider: next, modelo: '', esforco: '', permissao: '', motor: '', subagente: '', perfil: '', headless: null };
    const conta = contasLiberadas(policy.politica, policy.inventario, next)[0]?.conta ?? '';
    onChange({ ...reset, ...accountPatch(reset, conta, policy, false) });
  };
  return <Sheet open sizes={['large']} dismissible={false} scrollable>
    <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.root}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{existing ? role.papel : m.orqcfg_novo_papel()}</Text>
        <Text style={styles.note}>{m.orqcfg_papel()}</Text>
        <TextInput value={role.papel} editable={!existing && !locked} accessibilityLabel={m.orqcfg_papel()} onChangeText={papel => onChange({ papel })} style={styles.input} autoCorrect={false} />
        {role.vez ? <Text style={styles.note}>{m.orqcfg_vez_n({ n: role.vez })}</Text> : null}
        <Text style={styles.note}>{m.orqcfg_sessao()}</Text>
        <TextInput value={role.sessao} editable={!locked} accessibilityLabel={m.orqcfg_sessao()} onChangeText={sessao => onChange({ sessao })} style={styles.input} autoCapitalize="none" autoCorrect={false} />
        {!locked ? <ProviderPicker value={provider} onChange={switchProvider} /> : null}
        {!accounts.length ? <Text style={styles.error}>{m.orqcfg_nenhuma_conta()}</Text> : null}
        <Choice label={m.orqcfg_conta()} value={role.conta} items={accounts.map(account => ({ id: account.conta, label: account.apelido || account.conta }))} onChange={conta => onChange(accountPatch(role, conta, policy))} disabled={locked} emptyText={m.orqcfg_nenhuma_conta()} />
        <Choice label={m.native_ctl_model_title()} value={role.modelo} items={[defaultItem, ...models.map(model => ({ id: model.id, label: model.name || model.id }))]} onChange={modelo => onChange({ modelo, esforco: effortLevels(provider, effortModels, modelo).includes(role.esforco) ? role.esforco : '' })} disabled={locked || rule?.trocar === false} />
        <Choice label={m.native_ctl_effort()} value={role.esforco} items={[defaultItem, ...levels.map(level => ({ id: level, label: level }))]} onChange={esforco => onChange({ esforco })} disabled={locked} />
        <Choice label={m.orqcfg_janela()} value={role.janela ?? ''} items={[{ id: '', label: m.orqcfg_janela_padrao({ pct: 50 }) }, ...['30', '40', '60', '70', '80'].map(id => ({ id, label: `${id}%` })), ...(role.janela && !['30', '40', '60', '70', '80'].includes(role.janela) ? [{ id: role.janela, label: `${role.janela}%` }] : [])]} onChange={janela => onChange({ janela })} disabled={locked} />
        {hasExecutionMode(provider) ? <Choice label={m.criar_modo_exec()} value={role.headless == null ? '' : String(role.headless)} items={[defaultItem, { id: 'false', label: m.criar_modo_exec_tmux() }, { id: 'true', label: m.criar_modo_exec_headless() }]} onChange={value => onChange({ headless: value === '' ? null : value === 'true', ...(provider === 'codex' && value !== 'true' ? { permissao: '' } : {}) })} disabled={locked} /> : null}
        {modes.length ? <Choice label={m.criar_permissao()} value={role.permissao ?? ''} items={[{ id: '', label: m.criar_permissao_padrao() }, ...modes.map(mode => ({ id: mode, label: permissionLabel(mode) }))]} onChange={permissao => onChange({ permissao })} disabled={locked} /> : null}
        {provider === 'claude' ? <>
          <Choice label={m.comum_motor()} value={role.motor ?? ''} items={[defaultItem, ...Object.entries(engines).map(([id, engine]) => ({ id, label: engine.label || id }))]} onChange={motor => onChange({ motor, subagente: '' })} disabled={locked} />
          {!role.motor ? <Choice label={m.criar_subagente()} value={role.subagente ?? ''} items={[{ id: '', label: m.criar_subagente_padrao() }, ...models.map(model => ({ id: model.id, label: model.name || model.id }))]} onChange={subagente => onChange({ subagente })} disabled={locked} /> : null}
        </> : null}
        {provider === 'omp' ? <><Text style={styles.note}>{m.criar_perfil_omp()}</Text><TextInput value={role.perfil ?? ''} editable={!locked} accessibilityLabel={m.criar_perfil_omp()} onChangeText={perfil => onChange({ perfil })} style={styles.input} autoCapitalize="none" /></> : null}
        <View style={styles.switch}><Text style={styles.note}>{m.criar_jev()}</Text><Switch value={!!role.jev} disabled={locked} onValueChange={jev => onChange({ jev })} accessibilityLabel={m.criar_jev()} accessibilityState={{ checked: !!role.jev, disabled: locked }} /></View>
        <Text style={styles.note}>{m.orqcfg_cota()}: {quota}</Text>
        {measured.viva && live ? <Text style={styles.note}>{measured.modeloMedido ? m.orqcfg_agora_viva({ sessao: live.name, modelo: measured.modeloMedido, esforco: measured.esforcoMedido ?? '' }) : m.orqcfg_agora_nao_medido()}</Text> : null}
        {measured.divergente ? <Text style={styles.note}>{m.orqcfg_agora_diverge({ modelo: role.modelo, esforco: role.esforco })}</Text> : null}
        <Text style={styles.note}>{m.orqcfg_aplica_proxima()}</Text>
        {notice ? <Text style={styles.note}>{notice}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {auxiliaryError ? <Text accessibilityRole="alert" style={styles.error}>{auxiliaryError}</Text> : null}
        <View style={styles.controls}><Action label={m.orqcfg_salvar()} onPress={onSave} disabled={locked} /><Action label={m.orqcfg_descartar()} onPress={onDiscard} disabled={busy} /><Action label={m.native_close()} onPress={onClose} disabled={busy} /><Action label={m.comum_apagar()} onPress={onRemove} disabled={locked} /></View>
      </ScrollView>
    </KeyboardAvoidingView>
  </Sheet>;
}
function TeamEditor({ server, name, active, available, targetKey, routeError, stillTarget, live }: { server: Server; name: string; active: boolean; available: boolean; targetKey: string; routeError: string | null; stillTarget: () => boolean; live: AggSession[] }) {
  const header = useHeaderHeight();
  const navigation = useNavigation();
  const [leaveAction, setLeaveAction] = useState<Parameters<typeof navigation.dispatch>[0] | null>(null);
  const deciding = useRef(false);
  const [starting, setStarting] = useState(false);
  const [engines, setEngines] = useState<Record<string, Motor>>({});
  const [quotas, setQuotas] = useState<CotaContaResumo[]>([]);
  const [quotaError, setQuotaError] = useState('');
  const [engineError, setEngineError] = useState('');
  const round = useRef(0);
  const [group, setGroup] = useState<OrqGrupo | null>(null);
  const [policy, setPolicy] = useState<OrqPolitica | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scope = writeScope(server, name);
  const [blocked, setBlocked] = useState(() => writeRequests.has(scope));
  const blockedRef = useRef(blocked);
  const needsRead = useRef(false);
  const block = () => { blockedRef.current = true; setBlocked(true); };
  const newId = useRef(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const readingRef = useRef<number | null>(null);
  const abandonRead = useRef<(() => void) | null>(null);
  const pendingWrite = useRef<PendingWrite | null>(null);
  const submitted = useRef<Record<string, { draft: Papel; body: Papel }>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abandonRead.current?.(); pendingWrite.current?.abandon(); }; }, []);
  const lastTarget = useRef(targetKey);
  const groupRef = useRef(group); groupRef.current = group;
  const policyRef = useRef(policy); policyRef.current = policy;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const activeRef = useRef(active); activeRef.current = active;
  const targetRef = useRef(stillTarget); targetRef.current = stillTarget;
  const current = useCallback((token: number) => generation.current === token && activeRef.current && targetRef.current(), []);
  const read = useCallback(async (token: number) => {
    const reading = ++round.current;
    readingRef.current = reading;
    const valid = () => current(token) && round.current === reading;
    const requestsAtStart = writeRequests.get(scope);
    const writeAtStart = !!requestsAtStart?.pending.size;
    const settledAtStart = requestsAtStart?.settled;
    const required = Promise.all([getOrqGrupo(name, server), getOrqPoliticaForServer(server)]);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandon = () => {};
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve(null); }, 20_000);
      abandon = () => { clearTimeout(timer); resolve(null); };
    });
    abandonRead.current = abandon;
    void getEnginesForServer(server).then(response => {
      if (!valid()) return;
      setEngines(response.motores); setEngineError(response.arquivo_corrompido ? m.criar_motores_erro() : '');
    }).catch(cause => { if (valid()) setEngineError(errorText(cause)); });
    void probeServerResponse(server, '/api/cotas').then(async response => {
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<CotaContaResumo[]>;
    }).then(response => { if (valid()) { setQuotas(response); setQuotaError(''); } })
      .catch(cause => { if (valid()) setQuotaError(`${m.orqcfg_cota()}: ${errorText(cause)}`); });
    setLoading(true);
    try {
      const response = await Promise.race([required, deadline]);
      clearTimeout(timer);
      if (!response) { if (timedOut && valid()) setError(m.orqcfg_read_timeout()); return false; }
      const [next, options] = response;
      if (!valid()) return false;
      if (groupRef.current && groupRef.current.session_identity !== next.session_identity) {
        block(); setNotice(m.orqcfg_target_changed());
        const discardPrevious = await new Promise<boolean>(resolve => Alert.alert(m.orqcfg_unsaved_title(), m.orqcfg_target_changed(), [
          { text: m.comum_cancelar(), style: 'cancel', onPress: () => resolve(false) },
          { text: m.orqcfg_descartar(), style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: false }));
        if (!discardPrevious || !valid()) return false;
        draftsRef.current = {}; setDrafts({}); setSelected(null); setNotice(null);
      }
      const missing = Object.keys(draftsRef.current).filter(key => !key.startsWith('new:') && !next.papeis.some(role => roleKey(role) === key));
      if (missing.length) {
        const discardMissing = await new Promise<boolean>(resolve => Alert.alert(m.orqcfg_unsaved_title(), m.orqcfg_arquivo_mudou(), [
          { text: m.comum_cancelar(), style: 'cancel', onPress: () => resolve(false) },
          { text: m.orqcfg_descartar(), style: 'destructive', onPress: () => resolve(true) },
        ], { cancelable: false }));
        if (!discardMissing || !valid()) return false;
        const kept = { ...draftsRef.current }; for (const key of missing) delete kept[key];
        draftsRef.current = kept; setDrafts(kept); setSelected(null);
      }
      groupRef.current = next; setGroup(next); setPolicy(options); setError(null);
      const requests = writeRequests.get(scope);
      if (writeAtStart || requests?.pending.size || requestsAtStart !== requests || settledAtStart !== requests?.settled) { block(); setNotice(m.orqcfg_write_pending()); return false; }
      writeRequests.delete(scope);
      const kept = { ...draftsRef.current };
      for (const [key, sent] of Object.entries(submitted.current)) {
        const confirmed = next.papeis.find(role => roleKey(role) === roleKey(sent.body));
        if (confirmed && kept[key] === sent.draft && JSON.stringify(editable(confirmed)) === JSON.stringify(sent.body)) delete kept[key];
      }
      draftsRef.current = kept; setDrafts(kept); submitted.current = {}; needsRead.current = false;
      setNotice(previous => previous === m.orqcfg_write_pending() ? null : previous);
      blockedRef.current = false; setBlocked(false);
      return true;
    } catch (cause) {
      if (valid()) setError(errorText(cause));
      return false;
    } finally {
      clearTimeout(timer); if (abandonRead.current === abandon) abandonRead.current = null;
      if (valid()) { readingRef.current = null; setLoading(false); }
    }
  }, [server, name, current, targetKey, scope]);
  const waitForWrite = <T,>(request: Promise<T>): Promise<{ value: T } | null> => {
    const requests = writeRequests.get(scope) ?? { pending: new Set<Promise<unknown>>(), settled: 0 };
    requests.pending.add(request); writeRequests.set(scope, requests);
    const operation: PendingWrite = { timer: null, abandoned: false, abandon: () => {} };
    pendingWrite.current = operation;
    return new Promise((resolve, reject) => {
      operation.abandon = () => { operation.abandoned = true; if (operation.timer !== null) clearTimeout(operation.timer); resolve(null); };
      operation.timer = setTimeout(() => {
        operation.abandon();
        if (mounted.current) { block(); setNotice(m.orqcfg_write_pending()); }
      }, 30_000);
      const finish = (deliver: () => void) => {
        if (operation.timer !== null) clearTimeout(operation.timer);
        requests.pending.delete(request); requests.settled++;
        if (pendingWrite.current === operation) pendingWrite.current = null;
        if (operation.abandoned) { if (mounted.current) needsRead.current = true; return; }
        if (mounted.current) deliver(); else resolve(null);
      };
      request.then(value => finish(() => resolve({ value })), cause => finish(() => reject(cause)));
    });
  };
  const unlock = () => {
    busy.current = false;
    if (!mounted.current) return;
    setSaving(false); setStarting(false); if (readingRef.current === null) setLoading(false);
    if (needsRead.current && activeRef.current && targetRef.current()) { needsRead.current = false; setAttempt(value => value + 1); }
  };
  useEffect(() => {
    const token = ++generation.current;
    if (lastTarget.current !== targetKey) { lastTarget.current = targetKey; if (groupRef.current) block(); }
    if (active && available) {
      if (busy.current) needsRead.current = true;
      else { needsRead.current = false; void read(token); }
    } else setLoading(false);
    return () => { generation.current++; abandonRead.current?.(); readingRef.current = null; };
  }, [active, available, attempt, read, targetKey]);
  const refresh = useCallback(() => {
    if (busy.current || readingRef.current !== null || !activeRef.current || !targetRef.current()) return;
    retentarAgora(server.id); void read(generation.current);
  }, [server.id, read]);
  const onSelect = useCallback((key: string) => setSelected(key), []);
  const patch = (key: string, change: Partial<Papel>) => {
    if (busy.current || readingRef.current !== null || blockedRef.current || !activeRef.current || !targetRef.current()) return;
    const original = groupRef.current?.papeis.find(role => roleKey(role) === key);
    setDrafts(previous => {
      const base = previous[key] ?? (original && editable(original));
      if (!base) return previous;
      const next = { ...base, ...change, ...(original ? { papel: original.papel, vez: original.vez ?? '' } : { vez: '' }) };
      const result = { ...previous };
      if (original && JSON.stringify(editable(original)) === JSON.stringify(next)) delete result[key]; else result[key] = next;
      return result;
    });
  };
  const add = () => {
    if (!policy || !active || busy.current || readingRef.current !== null || blockedRef.current || !targetRef.current()) return;
    const blank = editable({ papel: '', sessao: '', provider: 'claude', conta: '', modelo: '', esforco: '', viva: null });
    const conta = contasLiberadas(policy.politica, policy.inventario, 'claude')[0]?.conta ?? '';
    const key = `new:${++newId.current}`;
    setDrafts(previous => ({ ...previous, [key]: { ...blank, ...accountPatch(blank, conta, policy, false) } })); setSelected(key);
  };
  const save = async (): Promise<boolean> => {
    const original = groupRef.current;
    const options = policyRef.current;
    const pending = Object.entries(draftsRef.current);
    if (!original || !options || busy.current || blockedRef.current || loading || !activeRef.current || !targetRef.current()) return false;
    if (!pending.length) return true;
    const names = original.papeis.map(role => normalizeName(role.papel));
    for (const [key, role] of pending) {
      const label = normalizeName(role.papel);
      if (key.startsWith('new:') && (!label || names.includes(label))) { setError(m.orqcfg_role_exists()); return false; }
      if (key.startsWith('new:')) names.push(label);
      const provider = role.provider || 'claude';
      if (!role.conta || !options.inventario.some(account => account.provider === provider && account.conta === role.conta)) { setError(`${role.papel}: ${m.erro_orq_conta_desconhecida()}`); return false; }
      if (!contasLiberadas(options.politica, options.inventario, provider).some(account => account.conta === role.conta)) { setError(`${role.papel}: ${m.erro_orq_conta_nao_liberada()}`); return false; }
    }
    busy.current = true; setSaving(true); setError(null); setNotice(null);
    const token = generation.current;
    try {
      const papeis = pending.map(([key, role]) => {
        const { viva: _viva, id_cota: _quota, ...body } = role;
        const provider = role.provider || 'claude';
        const headless = hasExecutionMode(provider) ? role.headless ?? null : null;
        return { ...body, provider, sessao: key.startsWith('new:') && !role.sessao.trim() ? sessionName(role, original, name) : role.sessao,
          headless, permissao: provider === 'claude' || (provider === 'codex' && headless === true) ? role.permissao ?? '' : '',
          motor: provider === 'claude' ? role.motor ?? '' : '', subagente: provider === 'claude' && !role.motor ? role.subagente ?? '' : '',
          perfil: provider === 'omp' ? role.perfil?.trim() ?? '' : '' };
      });
      submitted.current = Object.fromEntries(pending.map(([key, draft], index) => [key, { draft, body: editable({ ...papeis[index], viva: null }) }]));
      const result = await waitForWrite(postOrqPapeis(name, { papeis, mtime: original.mtime }, server));
      if (!result) return false;
      const response = result.value;
      if (!current(token)) { block(); needsRead.current = true; return false; }
      groupRef.current = { ...original, mtime: response.mtime }; setGroup(groupRef.current);
      setDrafts(previous => { const next = { ...previous }; for (const [key, role] of pending) if (next[key] === role) delete next[key]; return next; });
      setNotice(m.orqcfg_aviso_proxima_sessao());
      const reloaded = await read(token);
      if (!reloaded) { block(); if (current(token)) setNotice(m.orqcfg_saved_reload_failed()); }
      return reloaded;
    } catch (cause) {
      failWrite(cause, token);
      return false;
    } finally { unlock(); }
  };
  const failWrite = (cause: unknown, token: number) => {
    const status = (cause as { status?: number })?.status;
    if (!status || status === 409 || status >= 500) { block(); if (current(token)) setNotice(m.orqcfg_write_uncertain()); }
    if (current(token)) setError(errorText(cause));
  };
  const discard = (key?: string) => {
    const next = { ...draftsRef.current };
    if (key) delete next[key]; else for (const item of Object.keys(next)) delete next[item];
    draftsRef.current = next; setDrafts(next); setSelected(null);
  };
  const decide = (proceed: () => void, leaving = false) => {
    if (busy.current || deciding.current || !activeRef.current || (!leaving && !targetRef.current())) return;
    const token = generation.current;
    deciding.current = true;
    const accept = (task: () => void) => { deciding.current = false; if (generation.current === token && activeRef.current && (leaving || targetRef.current()) && !busy.current) task(); };
    Alert.alert(m.orqcfg_unsaved_title(), m.orqcfg_unsaved_body(), [
      { text: m.comum_cancelar(), style: 'cancel', onPress: () => { deciding.current = false; } },
      { text: m.orqcfg_descartar(), style: 'destructive', onPress: () => accept(() => { discard(); proceed(); }) },
      { text: m.orqcfg_salvar_continuar(), onPress: () => accept(() => { void save().then(ok => { if (ok && current(token)) proceed(); }); }) },
    ], { cancelable: false });
  };
  const dirty = Object.keys(drafts).length > 0;
  usePreventRemove(dirty || saving || starting, ({ data }) => {
    if (dirty) decide(() => setLeaveAction(data.action), true);
  });
  useEffect(() => {
    if (leaveAction && !dirty && !saving && !starting && active) { navigation.dispatch(leaveAction); setLeaveAction(null); }
  }, [leaveAction, dirty, saving, starting, active, navigation]);
  const start = async () => {
    if (busy.current || blockedRef.current || !activeRef.current || !targetRef.current()) return;
    busy.current = true; setStarting(true); setError(null);
    const token = generation.current;
    try {
      const result = await waitForWrite(comecarOrq(name, server));
      if (!result) return;
      const response = result.value;
      if (!current(token)) { block(); needsRead.current = true; return; }
      setNotice(response.entregue ? m.orqcfg_comecou() : m.orqcfg_comecou_fila());
      await read(token);
    } catch (cause) { failWrite(cause, token); }
    finally { unlock(); }
  };
  const begin = () => { if (Object.keys(draftsRef.current).length) decide(() => void start()); else void start(); };
  const remove = (key: string) => {
    if (busy.current || blockedRef.current || deciding.current || !activeRef.current || !targetRef.current()) return;
    const snapshot = groupRef.current;
    const original = snapshot?.papeis.find(role => roleKey(role) === key);
    const role = draftsRef.current[key] ?? original;
    if (!snapshot || !role) return;
    const token = generation.current;
    deciding.current = true;
    Alert.alert(m.comum_apagar(), m.orqcfg_remove_confirm({ papel: role.papel }), [
      { text: m.comum_cancelar(), style: 'cancel', onPress: () => { deciding.current = false; } },
      { text: m.comum_apagar(), style: 'destructive', onPress: () => {
        deciding.current = false;
        if (!current(token) || busy.current || blockedRef.current || snapshot !== groupRef.current) return;
        if (!original) { discard(key); return; }
        busy.current = true; setSaving(true); setError(null);
        void (async () => {
          try {
            const response = await waitForWrite(removerPapel(name, { papel: original.papel, vez: original.vez ?? '', mtime: snapshot.mtime }, server));
            if (!response) return;
            if (!current(token)) { block(); needsRead.current = true; return; }
            groupRef.current = { ...snapshot, mtime: response.value.mtime }; setGroup(groupRef.current);
            discard(key); setNotice(m.orqcfg_aviso_proxima_sessao());
            if (!await read(token)) { block(); if (current(token)) setNotice(m.orqcfg_saved_reload_failed()); }
          } catch (cause) { failWrite(cause, token); }
          finally { unlock(); }
        })();
      } },
    ], { cancelable: false });
  };
  const rows = useMemo(() => {
    if (!group) return [];
    const existing = group.papeis.map(role => ({ key: roleKey(role), role: drafts[roleKey(role)] ?? role, edited: !!drafts[roleKey(role)] }));
    const fresh = Object.entries(drafts).filter(([key]) => key.startsWith('new:')).map(([key, role]) => ({ key, role, edited: true }));
    const entries = new Map([...existing, ...fresh].map(row => [row.role, row]));
    return etapasDoTime([...entries.keys()]).flatMap(stage => stage.linhas.map(role => entries.get(role)!));
  }, [group, drafts]);
  const quotaFor = useCallback((role: Papel) => {
    const provider = role.provider || 'claude';
    const id = policy?.inventario.find(account => account.provider === provider && account.conta === role.conta)?.id_cota
      ?? group?.papeis.find(item => (item.provider || 'claude') === provider && item.conta === role.conta)?.id_cota
      ?? live.find(item => (item.provider || 'claude') === provider && contaMedida(item) === role.conta)?.conta;
    return resumoCota(quotas.find(item => item.id === id)) || m.orqcfg_cota_sem();
  }, [policy, group, live, quotas]);
  const renderRow = useCallback(({ item }: ListRenderItemInfo<TeamRow>) => <RoleRow role={item.role} rowKey={item.key} edited={item.edited} quota={quotaFor(item.role)} onSelect={onSelect} />, [onSelect, quotaFor]);
  const original = selected ? group?.papeis.find(role => roleKey(role) === selected) : undefined;
  const detail = selected ? drafts[selected] ?? (original && editable(original)) : null;
  const disabled = !active || loading || saving || starting;
  const writeBlocked = blocked || !available;
  const displayError = routeError ?? error;
  const listHeader = <>
    <View style={styles.controls}>
      <Action label={m.orqcfg_recarregar()} onPress={refresh} disabled={disabled || !available} />
      {group && policy ? <><Action label={m.orqcfg_novo_papel()} onPress={add} disabled={disabled || writeBlocked} /><Action label={saving ? m.orqcfg_salvando() : m.orqcfg_salvar()} onPress={() => void save()} disabled={disabled || writeBlocked || !Object.keys(drafts).length} /><Action label={starting ? m.orqcfg_comecando() : m.orqcfg_comecar()} onPress={begin} disabled={disabled || writeBlocked} /></> : null}
    </View>
    {notice ? <Text style={styles.note}>{notice}</Text> : null}
    {quotaError || engineError ? <Text accessibilityRole="alert" style={styles.error}>{[quotaError, engineError].filter(Boolean).join('\n')}</Text> : null}
    {displayError ? <View style={styles.status}><Text accessibilityRole="alert" style={styles.error}>{displayError}</Text><Action label={m.orq_panel_retry()} onPress={refresh} disabled={disabled || !available} /></View> : null}
    {loading ? <View style={styles.status}><ActivityIndicator /><Text style={styles.note}>{m.orqcfg_carregando()}</Text></View> : null}
    {group && policy ? <Text style={styles.note}>{readiness(group)}</Text> : null}
  </>;
  return <View style={styles.root}>
    <FlatList data={rows} renderItem={renderRow} keyExtractor={rowKey} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, Platform.OS !== 'ios' && { paddingTop: header }]} ListHeaderComponent={listHeader} ListEmptyComponent={group && policy ? <Text style={styles.note}>{m.orqcfg_sem_papeis()}</Text> : null} />
    {detail && selected && policy && active ? <RoleDetail key={selected} role={detail} existing={!!original} policy={policy} busy={disabled} writeBlocked={writeBlocked} engines={engines} quota={quotaFor(detail)} live={casarViva(detail.sessao, live) as AggSession | null} error={displayError} notice={notice} auxiliaryError={[quotaError, engineError].filter(Boolean).join('\n')} onChange={change => patch(selected, change)} onSave={() => void save()} onClose={() => setSelected(null)} onDiscard={() => discard(selected)} onRemove={() => remove(selected)} /> : null}
  </View>;
}
const styles = StyleSheet.create(theme => ({
  root: { flex: 1, backgroundColor: 'transparent' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: theme.base.space[4], gap: theme.base.space[2] },
  status: { padding: theme.base.space[4], gap: theme.base.space[2] },
  content: { paddingBottom: theme.base.space[6] },
  row: { minHeight: 44, padding: theme.base.space[4], gap: theme.base.space[2] },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[3] },
  actionText: { fontSize: theme.base.text.sm, color: theme.tokens.accent.base },
  title: { fontSize: theme.base.text.base, color: theme.tokens.text.primary, fontWeight: '600' },
  note: { fontSize: theme.base.text.sm, color: theme.tokens.text.muted },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.warning },
  choice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], paddingVertical: theme.base.space[2] },
  grow: { flex: 1 },
  form: { padding: theme.base.space[4], gap: theme.base.space[2] },
  input: { minHeight: 44, fontSize: theme.base.text.base, color: theme.tokens.text.primary, borderBottomWidth: 1, borderBottomColor: theme.tokens.text.muted },
  switch: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  disabled: { opacity: 0.5 },
}));
