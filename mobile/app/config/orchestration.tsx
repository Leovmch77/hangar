import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  getOrqPoliticaForServer, putOrqContaForServer,
  type ContaInventario, type ContaPolitica, type OrqPolitica,
} from '@hangar/core';
import { Pagina } from '../../src/features/config/Pagina';
import { PageHeader, Pill } from '../../src/features/config/PageHeader';
import { SectionCard } from '../../src/features/config/SectionCard';
import { InfoNotice } from '../../src/features/config/InfoNotice';
import { useSettingsColors } from '../../src/features/config/colors';
import { Icon } from '../../src/ui/Icon';
import { Chip } from '../../src/ui/Chip';
import { ProviderGlyph } from '../../src/ui/ProviderGlyph';
import { useServers } from '../../src/stores/servers';
import * as m from '../../src/paraglide/messages';

const PROVIDERS = ['claude', 'codex', 'pi', 'kimi', 'omp'] as const;
const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi', kimi: 'Kimi', omp: 'OMP' };

type Draft = { provider: string; conta: string; ligada: boolean; trocar: boolean; modelos: string[] };

// Mesma chave do backend (`orq_md.normalizar`): a política pode ter a conta escrita com outra caixa ou acento.
function accountKey(value: string): string {
  return value.trim().replace(/^`+|`+$/g, '').replaceAll('**', '').split(/\s+/).filter(Boolean).join(' ')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function initials(name: string): string {
  const skip = ['e', 'and', 'de', 'da', 'do', '&'];
  const text = name.split(/[\s_\-:/]+/).filter((p) => p && !skip.includes(p.toLowerCase()))
    .slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return text || '?';
}

const accountName = (a: ContaInventario) => a.apelido || a.conta;
const sameAccount = (p: ContaPolitica, a: { provider: string; conta: string }) =>
  p.provider === a.provider && accountKey(p.conta) === accountKey(a.conta);

/** O que a tela mostra para a conta: a política dela, ou o padrão (ligada só com política vazia, todos os modelos). */
function draftFor(data: OrqPolitica, provider: string, conta: string): Draft {
  const p = data.politica.find((x) => sameAccount(x, { provider, conta }));
  return { provider, conta, ligada: data.politica.length === 0 || !!p, trocar: p ? p.trocar : true, modelos: p ? [...p.modelos] : ['*'] };
}

const sameDraft = (a: Draft, b: Draft) =>
  a.ligada === b.ligada && a.trocar === b.trocar && a.modelos.join('\n') === b.modelos.join('\n');

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : m.native_invalid_response());

export default function OrchestrationPage() {
  const server = useServers((s) => s.active());
  const c = useSettingsColors();
  const { theme } = useUnistyles();
  const [data, setData] = useState<OrqPolitica | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState('');
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // 409 (arquivo mudou) ou resposta incerta: salvar de novo poderia sobrescrever o que não se viu.
  const [reloadRequired, setReloadRequired] = useState(false);
  const generation = useRef(0);

  const load = useCallback(() => {
    const now = ++generation.current;
    if (!server) return;
    setLoading(true);
    setLoadError('');
    setError('');
    setSaved(false);
    setReloadRequired(false);
    getOrqPoliticaForServer(server)
      .then((next) => {
        if (now !== generation.current) return;
        setData(next);
        setDraft((d) => (d && next.inventario.some((a) => a.provider === d.provider && a.conta === d.conta)
          ? draftFor(next, d.provider, d.conta) : null));
      })
      .catch((cause: unknown) => { if (now === generation.current) setLoadError(errorText(cause)); })
      .finally(() => { if (now === generation.current) setLoading(false); });
  }, [server]);

  useEffect(() => {
    setData(null);
    setDraft(null);
    load();
    return () => { generation.current++; };
  }, [load, server?.id, server?.baseUrl, server?.token]);

  const send = (target: Draft, ligada: boolean) => {
    if (!server || !data || saving || reloadRequired) return;
    const account = data.inventario.find((a) => a.provider === target.provider && a.conta === target.conta);
    if (!account) return;
    const modelos = target.modelos.length ? target.modelos : ['*'];
    const s = server;
    setSaving(true);
    setError('');
    setSaved(false);
    putOrqContaForServer(s, target.conta, {
      provider: target.provider, apelido: account.apelido, modelos, trocar: target.trocar, ligada, mtime: data.mtime,
    })
      .then((res) => {
        if (!res?.ok || typeof res.mtime !== 'number') {
          setError(m.native_invalid_response());
          setReloadRequired(true);
          return;
        }
        generation.current++;
        const politica = data.politica.filter((p) => !sameAccount(p, target));
        if (ligada) politica.push({ provider: account.provider, conta: target.conta, apelido: account.apelido, modelos, trocar: target.trocar });
        const next = { ...data, politica, mtime: res.mtime };
        setData(next);
        setDraft((d) => (d ? draftFor(next, d.provider, d.conta) : d));
        setSaved(true);
      })
      .catch((cause: unknown) => {
        const status = (cause as { status?: number }).status;
        setError(status === 409 ? m.native_orchestration_file_changed() : errorText(cause));
        // Sem status a gravação pode ter chegado: só a releitura diz o que ficou.
        setReloadRequired(status === 409 || status === undefined);
      })
      .finally(() => setSaving(false));
  };

  // Desligar a última conta ou ligar a primeira muda a regra do servidor inteiro: pede confirmação, como no desktop.
  const save = (target: Draft) => {
    if (!data || saving || reloadRequired || loading) return;
    const lastOff = !target.ligada && (data.politica.length === 0 || data.politica.every((p) => sameAccount(p, target)));
    const firstOn = target.ligada && data.politica.length === 0;
    if (lastOff || firstOn) {
      Alert.alert(
        lastOff ? m.native_orchestration_unrestricted_title() : m.native_orchestration_restrict_title(),
        lastOff ? m.native_orchestration_unrestricted_confirm()
          : m.native_orchestration_restrict_confirm({ n: String(Math.max(0, data.inventario.length - 1)) }),
        [
          { text: m.comum_cancelar(), style: 'cancel' },
          { text: m.native_orchestration_save(), style: 'destructive', onPress: () => send(target, !lastOff) },
        ],
      );
      return;
    }
    send(target, target.ligada);
  };

  const choose = (a: ContaInventario) => {
    if (!data || saving) return;
    if (draft?.provider === a.provider && draft.conta === a.conta) { setDraft(null); return; }
    setDraft(draftFor(data, a.provider, a.conta));
    setFilter('');
    setCustom('');
    setError('');
    setSaved(false);
  };

  const catalogOf = (d: Draft) =>
    (data?.inventario.find((a) => a.provider === d.provider && a.conta === d.conta)?.modelos ?? []).map((x) => x.id);

  const toggleModel = (id: string) => setDraft((d) => {
    if (!d) return d;
    if (d.modelos.includes('*')) return { ...d, modelos: catalogOf(d).filter((x) => x !== id) };
    return { ...d, modelos: d.modelos.includes(id) ? d.modelos.filter((x) => x !== id) : [...d.modelos, id] };
  });

  const addModel = () => {
    const id = custom.trim();
    if (!draft || !id || /[|\n\r]/.test(id) || draft.modelos.includes(id)) return;
    setDraft({ ...draft, modelos: [...(draft.modelos.includes('*') ? catalogOf(draft) : draft.modelos), id] });
    setCustom('');
  };

  const header = (
    <PageHeader
      title={m.native_settings_page_orchestration()}
      subtitle={m.native_orchestration_intro()}
      actions={server ? [{ icon: 'RefreshCw', label: m.native_orchestration_reload(), onPress: load }] : undefined}
    />
  );
  if (!server) return <Pagina>{header}<InfoNotice text={m.native_settings_offline()} /></Pagina>;

  const muted = [styles.text, { color: c.muted }];
  if (!data) {
    return (
      <Pagina>
        {header}
        {loadError ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
            <View style={styles.row}><Pill icon="RefreshCw" label={m.native_server_retry()} onPress={load} /></View>
          </>
        ) : <Text style={muted}>{m.native_loading()}</Text>}
      </Pagina>
    );
  }

  const current = draft ? draftFor(data, draft.provider, draft.conta) : null;
  const dirty = !!(draft && current && !sameDraft(draft, current));
  const input = [styles.input, { borderColor: c.borderStrong, backgroundColor: c.inset, color: c.text }];

  const detail = (a: ContaInventario, d: Draft) => {
    const all = d.modelos.includes('*');
    const models = a.modelos.map((x) => ({ id: x.id, name: x.name || x.id }));
    for (const id of d.modelos) if (id !== '*' && !models.some((x) => x.id === id)) models.push({ id, name: id });
    const marked = all ? models.length : d.modelos.length;
    const q = filter.trim().toLowerCase();
    const shown = models.filter((x) => !q || x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
    const off = saving || !d.ligada;
    return (
      <View style={[styles.detail, { borderTopColor: c.border }]}>
        <View style={styles.switchRow}>
          <View style={styles.texts}>
            <Text style={[styles.label, { color: c.text }]}>{m.native_orchestration_can_use()}</Text>
            <Text style={muted}>{m.native_orchestration_can_use_help()}</Text>
          </View>
          <Switch value={d.ligada} disabled={saving} accessibilityLabel={m.native_orchestration_can_use()}
            onValueChange={(v) => setDraft({ ...d, ligada: v })} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.texts}>
            <Text style={[styles.label, { color: c.text }]}>{m.native_orchestration_can_switch()}</Text>
            <Text style={muted}>{m.native_orchestration_can_switch_help()}</Text>
          </View>
          <Switch value={d.trocar} disabled={off} accessibilityLabel={m.native_orchestration_can_switch()}
            onValueChange={(v) => setDraft({ ...d, trocar: v })} />
        </View>
        <Text style={[styles.label, { color: c.text }]}>
          {m.native_orchestration_allowed_models({ n: String(marked), total: String(models.length) })}
        </Text>
        <View style={styles.row}>
          <Pill label={m.native_orchestration_mark_all()} onPress={() => { if (!off) setDraft({ ...d, modelos: ['*'] }); }} />
          <Pill label={m.native_orchestration_clear()} onPress={() => { if (!off) setDraft({ ...d, modelos: [] }); }} />
        </View>
        {models.length > 6 ? (
          <TextInput style={input} value={filter} onChangeText={setFilter} editable={!off}
            placeholder={m.native_orchestration_filter_models()} placeholderTextColor={c.faint}
            accessibilityLabel={m.native_orchestration_filter_models()} autoCapitalize="none" autoCorrect={false} />
        ) : null}
        <View>
          {shown.map((x) => {
            const on = all || d.modelos.includes(x.id);
            return (
              <Pressable key={x.id} onPress={() => { if (!off) toggleModel(x.id); }} disabled={off}
                accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: off }} accessibilityLabel={x.name}
                style={[styles.check, off && styles.dim]}>
                <Icon name={on ? 'SquareCheck' : 'Square'} size={18} color={on ? c.accent : c.faint} />
                <Text style={[styles.text, { color: c.text, flex: 1 }]} numberOfLines={1}>{x.name}</Text>
              </Pressable>
            );
          })}
        </View>
        {a.reduced ? <Text style={muted}>{m.native_orchestration_reduced_help()}</Text> : null}
        <View style={styles.addRow}>
          <TextInput style={[input, { flex: 1 }]} value={custom} onChangeText={setCustom} editable={!off}
            placeholder={m.native_orchestration_model_id()} placeholderTextColor={c.faint} onSubmitEditing={addModel}
            accessibilityLabel={m.native_orchestration_model_id()} autoCapitalize="none" autoCorrect={false} />
          <Pill label={m.native_orchestration_add()} onPress={() => { if (!off) addModel(); }} />
        </View>
        <Text style={muted}>{m.native_orchestration_policy_path({ arquivo: data.arquivo })}</Text>
        <View style={styles.row}>
          <Pill icon="Save" label={saving ? m.native_orchestration_saving() : m.native_orchestration_save()}
            onPress={() => { if (!reloadRequired) save(d); }} />
        </View>
      </View>
    );
  };

  return (
    <Pagina>
      {header}
      <View style={styles.row}><Chip>{m.native_server_scope()}</Chip></View>
      {data.politica.length === 0 ? <InfoNotice text={m.native_orchestration_unrestricted()} /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {saved && !error ? <Text accessibilityRole="text" style={[styles.text, { color: theme.tokens.status.success }]}>{m.native_orchestration_saved()}</Text> : null}
      {reloadRequired ? <View style={styles.row}><Pill icon="RefreshCw" label={m.native_orchestration_reload()} onPress={load} /></View> : null}
      {loading ? <Text style={muted}>{m.native_loading()}</Text> : null}
      {data.inventario.length === 0 ? <Text style={muted}>{m.native_orchestration_empty()}</Text> : null}
      {PROVIDERS.map((provider) => {
        const accounts = data.inventario.filter((a) => a.provider === provider);
        if (!accounts.length) return null;
        return (
          <SectionCard key={provider}>
            <View style={styles.providerHead}>
              <ProviderGlyph provider={provider} size={16} />
              <Text style={[styles.label, { color: c.text }]}>{PROVIDER_NAME[provider]}</Text>
            </View>
            {accounts.map((a) => {
              const policy = data.politica.find((p) => sameAccount(p, a));
              const forbidden = data.politica.length > 0 && !policy;
              const selected = draft?.provider === a.provider && draft.conta === a.conta;
              const n = a.modelos.length;
              const subtitle = n ? `${a.conta} · ${n === 1 ? m.native_orchestration_model_one() : m.native_orchestration_model_many({ n: String(n) })}` : a.conta;
              // O interruptor da linha grava na hora; com rascunho aberto ele trava para não gravar por cima da edição.
              const quick: Draft = { provider: a.provider, conta: a.conta, ligada: !forbidden,
                trocar: policy ? policy.trocar : true, modelos: policy ? [...policy.modelos] : ['*'] };
              return (
                <View key={`${a.provider}:${a.conta}`} style={[styles.account, { borderTopColor: c.border }, forbidden && { backgroundColor: c.inset }]}>
                  <View style={styles.accountRow}>
                    <Pressable onPress={() => choose(a)} disabled={saving} accessibilityRole="button"
                      accessibilityLabel={accountName(a)} accessibilityState={{ expanded: selected }}
                      style={({ pressed }) => [styles.accountMain, pressed && styles.dim]}>
                      <View style={[styles.avatar, { backgroundColor: c.inset, borderColor: selected ? c.accent : c.border }]}>
                        <Text style={[styles.avatarText, { color: forbidden ? c.muted : c.text }]}>{initials(accountName(a))}</Text>
                      </View>
                      <View style={styles.texts}>
                        <Text style={[styles.label, { color: forbidden ? c.muted : c.text }]} numberOfLines={1}>{accountName(a)}</Text>
                        <Text style={[styles.small, { color: c.muted }]} numberOfLines={1}>{subtitle}</Text>
                        <View style={styles.chips}>
                          {a.reduced ? <Chip>{m.native_orchestration_reduced()}</Chip> : null}
                          {forbidden ? <Chip tone="error">{m.native_orchestration_forbidden()}</Chip> : null}
                          {policy && !policy.trocar ? <Chip tone="warning">{m.native_orchestration_locked()}</Chip> : null}
                        </View>
                      </View>
                    </Pressable>
                    <Switch value={!forbidden} disabled={saving || dirty || reloadRequired} accessibilityLabel={accountName(a)}
                      onValueChange={(on) => save({ ...quick, ligada: on })} />
                  </View>
                  {selected && draft ? detail(a, draft) : null}
                </View>
              );
            })}
          </SectionCard>
        );
      })}
    </Pagina>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  text: { fontSize: 15, lineHeight: 20 },
  small: { fontSize: 13.5 },
  label: { fontSize: 15, fontWeight: '500' },
  error: { fontSize: theme.base.text.sm, color: theme.tokens.status.error },
  providerHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  account: { borderTopWidth: 1 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  accountMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 13, fontWeight: '700' },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  detail: { borderTopWidth: 1, paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  dim: { opacity: 0.5 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { height: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 15 },
}));
