import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MenuView } from '@react-native-menu/menu';
import {
  CONFIG_SYNC_ITEMS, applyConfigSyncForServer, configSyncItemLabel, configSyncReportStep, configSyncRows,
  configSyncStepText, configSyncWarningText, diffManifests, getConfigSyncBundleForServer,
  getConfigSyncManifestForServer, serverColor, translateConfigSyncTextsForServer,
  type ConfigSyncDiff, type ConfigSyncGroup, type ConfigSyncItem, type ConfigSyncMachineStep,
  type ConfigSyncManifest, type ConfigSyncReport, type ConfigSyncRow, type Server,
} from '@hangar/core';
import { Pagina } from '../../src/features/config/Pagina';
import { PageHeader, Pill } from '../../src/features/config/PageHeader';
import { InfoNotice } from '../../src/features/config/InfoNotice';
import { Box, Chip, Disclosure } from '../../src/features/config/ServerConfigParts';
import { useSettingsColors } from '../../src/features/config/colors';
import { superficie } from '../../src/theme/superficie';
import { Icon } from '../../src/ui/Icon';
import { useServers } from '../../src/stores/servers';
import { getLocale } from '../../src/paraglide/runtime';
import * as m from '../../src/paraglide/messages';

type Diffs = Partial<Record<ConfigSyncItem, ConfigSyncDiff>>;
type Outcome<T> = { ok: T } | { error: string };
type Machine = { id: string; label: string; origin: boolean; step: ConfigSyncMachineStep };
type Preview = { item: ConfigSyncItem; changes: ConfigSyncRow[]; same: ConfigSyncRow[]; onlyTarget: ConfigSyncRow[]; line: string };
type Picked = Partial<Record<ConfigSyncItem, string[]>>;

const status = (e: unknown) => (e as { status?: number } | null)?.status;
const message = (e: unknown) => (e instanceof Error && e.message ? e.message : m.erro_desconhecido());
// 404 na rota = o Hangar de lá ainda não tem a configuração compartilhada.
const failureText = (e: unknown, label: string) => (status(e) === 404 ? m.shared_config_outdated({ machine: label }) : message(e));
const machineError = (e: unknown, label: string) =>
  status(e) === 404 ? failureText(e, label) : m.shared_config_error({ machine: label, error: failureText(e, label) });

const GROUPS: Array<[ConfigSyncGroup, (() => string) | null, (() => string) | null]> = [
  ['settings', m.shared_config_group_settings, m.shared_config_group_settings_hint],
  ['files', m.shared_config_group_files, null],
  ['entries', null, null],
  ['refs', m.shared_config_group_refs, m.shared_config_group_refs_hint],
];

export default function SharedConfig() {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  const servers = useServers((s) => s.servers);
  const activeId = useServers((s) => s.activeId);
  // Convite e máquina desligada ficam fora, como no seletor de servidor.
  const own = useMemo(() => servers.filter((s) => !s.invite && !s.disabled), [servers]);

  const [originId, setOriginId] = useState<string | null>(null);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [items, setItems] = useState<ConfigSyncItem[]>([...CONFIG_SYNC_ITEMS]);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState<ConfigSyncManifest | null>(null);
  const [diffs, setDiffs] = useState<Record<string, Outcome<Diffs>>>({});
  const [reports, setReports] = useState<Record<string, Outcome<ConfigSyncReport>>>({});
  // Sem comparação não há escolha: o item vai inteiro.
  const [picked, setPicked] = useState<Picked>({});
  const [translated, setTranslated] = useState<Record<string, string>>({});
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState('');
  const [open, setOpen] = useState<Partial<Record<ConfigSyncItem, boolean>>>({});
  const [restOpen, setRestOpen] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Machine[]>([]);
  // Número da rodada: resposta de uma comparação ou envio anterior é descartada.
  const run = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => {
    run.current++;
    controller.current?.abort();
  }, []);

  // Começa na máquina ativa, como o desktop começa na conectada.
  useEffect(() => {
    if (own.some((s) => s.id === originId)) return;
    setOriginId((own.find((s) => s.id === activeId) ?? own[0])?.id ?? null);
  }, [own, activeId, originId]);

  const origin = own.find((s) => s.id === originId) ?? null;
  const targets = own.filter((s) => s.id !== originId && targetIds.includes(s.id));
  const candidates = own.filter((s) => s.id !== originId);
  const ready = !!origin && targets.length > 0 && items.length > 0;

  const preview: Preview[] = (() => {
    const ok = targets.map((t) => diffs[t.id]).filter((d): d is { ok: Diffs } => !!d && 'ok' in d).map((d) => d.ok);
    return CONFIG_SYNC_ITEMS.filter((item) => items.includes(item) && ok.some((d) => d[item])).flatMap((item) => {
      const meta = base?.items[item];
      const descriptions = Object.fromEntries(Object.entries(meta?.descriptions ?? {}).map(([k, v]) => [k, translated[v] ?? v]));
      const rows = configSyncRows(item, ok.map((d) => d[item]).filter((d): d is ConfigSyncDiff => !!d), { labels: meta?.labels, descriptions });
      if (!rows.length) return [];
      const count = (s: ConfigSyncRow['status']) => rows.filter((r) => r.status === s).length;
      const line = m.shared_config_diff_line({ added: count('added'), changed: count('changed'), same: count('same'), onlyTarget: count('onlyTarget') });
      return [{
        item, line,
        changes: rows.filter((r) => r.status === 'added' || r.status === 'changed'),
        same: rows.filter((r) => r.status === 'same'),
        onlyTarget: rows.filter((r) => r.status === 'onlyTarget'),
      }];
    });
  })();

  // Prévia feita com outra origem ou outros itens decidiria a sobrescrita errada.
  const clearResults = () => {
    run.current++;
    controller.current?.abort();
    controller.current = null;
    setBase(null);
    setDiffs({});
    setReports({});
    setPicked({});
    setTranslated({});
    setTranslating(false);
    setTranslateError('');
    setOpen({});
    setRestOpen(new Set());
    setProgress([]);
  };

  const pickOrigin = (id: string) => {
    if (busy || id === originId) return;
    setOriginId(id);
    clearResults();
  };
  const toggleTarget = (id: string | null) => {
    if (busy) return;
    const ids = candidates.map((s) => s.id);
    if (id === null) setTargetIds(ids.every((x) => targetIds.includes(x)) ? [] : ids);
    else setTargetIds(targetIds.includes(id) ? targetIds.filter((x) => x !== id) : [...targetIds, id]);
  };
  const toggleItem = (item: ConfigSyncItem) => {
    if (busy) return;
    setItems(items.includes(item) ? items.filter((i) => i !== item) : [...items, item]);
    clearResults();
  };
  const togglePick = (item: ConfigSyncItem, key: string) => {
    if (busy) return;
    const list = picked[item] ?? [];
    setPicked({ ...picked, [item]: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] });
  };
  const pickAll = (p: Preview, on: boolean) => {
    if (busy) return;
    setPicked({ ...picked, [p.item]: on ? p.changes.filter((r) => r.selectable).map((r) => r.key) : [] });
  };

  const step = (id: string, next: ConfigSyncMachineStep, r: number) => {
    if (r !== run.current) return;
    setProgress((list) => list.map((x) => (x.id === id ? { ...x, step: next } : x)));
  };

  // Descrições no idioma da tela, pela origem; até chegarem vale o original.
  const translate = (from: Server, manifest: ConfigSyncManifest, r: number, signal: AbortSignal) => {
    const texts = [...new Set(Object.values(manifest.items).flatMap((i) => Object.values(i?.descriptions ?? {})))];
    if (!texts.length) return;
    setTranslating(true);
    translateConfigSyncTextsForServer(from, texts, getLocale() === 'en' ? 'en' : 'pt', signal)
      .then((res) => {
        if (r !== run.current) return;
        setTranslated(Object.fromEntries(texts.map((t, i) => [t, res.texts?.[i] ?? t])));
        setTranslateError(res.error || '');
      })
      .catch((e: unknown) => {
        // 404 = Hangar de lá sem a tradução: os originais já estão na tela, não é erro.
        if (r === run.current && status(e) !== 404) setTranslateError(message(e));
      })
      .finally(() => { if (r === run.current) setTranslating(false); });
  };

  const compare = () => {
    if (busy || !ready || !origin) return;
    clearResults();
    const r = run.current;
    const ctl = new AbortController();
    controller.current = ctl;
    const from = origin;
    const to = targets;
    const chosen = items;
    setBusy(true);
    setProgress([from, ...to].map((s, i) => ({ id: s.id, label: s.label, origin: i === 0, step: { stage: 'connecting' } })));
    const fetch = (s: Server) => getConfigSyncManifestForServer(s, ctl.signal).then(
      (manifest) => { step(s.id, { stage: 'read_done' }, r); return { ok: manifest } as const; },
      (e: unknown) => { step(s.id, { stage: 'failed', error: failureText(e, s.label) }, r); return { e } as const; },
    );
    void Promise.all([fetch(from), Promise.all(to.map(fetch))]).then(([head, rest]) => {
      if (r !== run.current) return;
      setBusy(false);
      if (!('ok' in head)) return;
      const next: Record<string, Outcome<Diffs>> = {};
      to.forEach((t, i) => {
        const res = rest[i];
        next[t.id] = 'ok' in res ? { ok: diffManifests(head.ok, res.ok, chosen) } : { error: machineError(res.e, t.label) };
      });
      setBase(head.ok);
      setDiffs(next);
      // Começa marcado o que o envio muda; o igual não precisa ir.
      const ok = Object.values(next).filter((d): d is { ok: Diffs } => 'ok' in d).map((d) => d.ok);
      const initial: Picked = {};
      for (const item of chosen) {
        const rows = configSyncRows(item, ok.map((d) => d[item]).filter((d): d is ConfigSyncDiff => !!d));
        if (rows.length) initial[item] = rows.filter((x) => (x.status === 'added' || x.status === 'changed') && x.selectable).map((x) => x.key);
      }
      setPicked(initial);
      translate(from, head.ok, r, ctl.signal);
    });
  };

  // O pacote sai UMA vez da origem e vai, em sequência, para cada destino.
  // ponytail: etapas grossas por máquina; o progresso por entrada exige o NDJSON em stream, que o fetch do RN não lê.
  const send = async () => {
    if (busy || !ready || !origin) return;
    const r = run.current;
    const from = origin;
    const to = targets;
    const chosen = CONFIG_SYNC_ITEMS.filter((i) => items.includes(i));
    const keys = Object.keys(picked).length ? picked : undefined;
    setBusy(true);
    setReports({});
    setProgress([
      { id: from.id, label: from.label, origin: true, step: { stage: 'packing' } },
      ...to.map((t) => ({ id: t.id, label: t.label, origin: false, step: { stage: 'waiting' as const } })),
    ]);
    // Sem AbortController: sair da tela não interrompe um envio no meio da lista de destinos.
    let bundle: Blob;
    try {
      bundle = await getConfigSyncBundleForServer(from, chosen, undefined, keys);
      step(from.id, { stage: 'packed' }, r);
    } catch (e) {
      // Sem pacote nenhum destino recebe nada: "Na fila" pararia na tela como se ainda fosse.
      if (r === run.current) {
        setProgress((list) => list.filter((x) => x.origin).map((x) => ({ ...x, step: { stage: 'failed', error: failureText(e, from.label) } })));
        setBusy(false);
      }
      return;
    }
    for (const t of to) {
      step(t.id, { stage: 'uploading' }, r);
      try {
        const report = await applyConfigSyncForServer(t, chosen, bundle);
        step(t.id, configSyncReportStep(report), r);
        if (r === run.current) setReports((prev) => ({ ...prev, [t.id]: { ok: report } }));
      } catch (e) {
        step(t.id, { stage: 'failed', error: failureText(e, t.label) }, r);
        if (r === run.current) setReports((prev) => ({ ...prev, [t.id]: { error: machineError(e, t.label) } }));
      }
    }
    if (r === run.current) setBusy(false);
  };

  const confirmSend = () => {
    if (busy || !ready || !origin) return;
    Alert.alert(
      m.shared_config_confirm_title(),
      m.shared_config_confirm_message({ origin: origin.label, targets: targets.map((t) => t.label).join(', ') }),
      [
        { text: m.comum_cancelar(), style: 'cancel' },
        { text: m.shared_config_confirm_label(), style: 'destructive', onPress: () => { void send(); } },
      ],
    );
  };

  if (own.length < 2) {
    return (
      <Pagina>
        <PageHeader title={m.shared_config_title()} subtitle={m.shared_config_intro()} />
        <InfoNotice text={m.shared_config_need_two()} />
      </Pagina>
    );
  }

  const allTargets = candidates.length > 0 && candidates.every((s) => targetIds.includes(s.id));
  const okCount = targets.filter((t) => diffs[t.id] && 'ok' in diffs[t.id]).length;
  const errorColor = theme.tokens.status.error;

  const originLabel = (
    <View style={[styles.origin, { borderColor: c.borderStrong }, busy && styles.disabled]}>
      {origin ? <View style={[styles.dot, { backgroundColor: serverColor(origin.id) }]} /> : null}
      <Text style={[styles.body, { color: c.text }]} numberOfLines={1}>{origin?.label ?? ''}</Text>
      <Icon name="ChevronDown" size={14} color={c.muted} />
    </View>
  );

  return (
    <Pagina>
      <PageHeader title={m.shared_config_title()} subtitle={m.shared_config_intro()} />

      <Field label={m.shared_config_origin()}>
        {busy ? originLabel : (
          <MenuView
            title={m.shared_config_origin()}
            actions={own.map((s) => ({
              id: s.id,
              title: s.label,
              state: s.id === originId ? ('on' as const) : ('off' as const),
              // O menu nativo do Android só aceita ícone de recurso; a bolinha de cor fica no iOS.
              ...(Platform.OS === 'ios' ? { image: 'circle.fill', imageColor: serverColor(s.id) } : {}),
            }))}
            onPressAction={({ nativeEvent }) => pickOrigin(nativeEvent.event)}
          >
            <Pressable accessibilityRole="button" accessibilityLabel={m.shared_config_origin()} hitSlop={6} style={styles.self}>
              {originLabel}
            </Pressable>
          </MenuView>
        )}
      </Field>

      <Field label={m.shared_config_targets()}>
        <Box>
          <CheckRow label={m.shared_config_all_targets()} checked={allTargets} disabled={busy} onPress={() => toggleTarget(null)} />
          {candidates.map((s) => (
            <CheckRow key={s.id} label={s.label} checked={targetIds.includes(s.id)} disabled={busy} onPress={() => toggleTarget(s.id)} />
          ))}
        </Box>
      </Field>

      <Field label={m.shared_config_items()}>
        <Box>
          {CONFIG_SYNC_ITEMS.map((item) => (
            <CheckRow key={item} label={configSyncItemLabel(item)} checked={items.includes(item)} disabled={busy} onPress={() => toggleItem(item)} />
          ))}
        </Box>
      </Field>

      {!ready ? <Text style={[styles.note, { color: c.muted }]}>{m.shared_config_pick()}</Text> : null}
      <View style={styles.buttons}>
        <Button label={m.shared_config_compare()} disabled={!ready || busy} onPress={compare} />
        <Button label={m.shared_config_send()} primary disabled={!ready || busy} onPress={confirmSend} />
      </View>

      {progress.length ? (
        <Field label={m.shared_config_progress_title()}>
          <Box>
            {progress.map((x) => {
              const failed = x.step.stage === 'failed' || x.step.stage === 'partial';
              return (
                <View key={x.id} style={[styles.row, { borderTopColor: c.border }]}>
                  <View style={styles.line}>
                    <Text style={[styles.strong, { color: c.text }]} numberOfLines={1}>{x.label}</Text>
                    <Chip text={x.origin ? m.shared_config_role_origin() : m.shared_config_role_target()} tone={x.origin ? 'accent' : 'muted'} />
                    <Text accessibilityLiveRegion="polite" style={[styles.small, styles.right, { color: failed ? errorColor : c.muted }]}>
                      {configSyncStepText(x.step)}
                    </Text>
                  </View>
                  {x.step.error ? <Text accessibilityRole="alert" style={[styles.small, { color: errorColor }]}>{x.step.error}</Text> : null}
                </View>
              );
            })}
          </Box>
        </Field>
      ) : null}

      {translating ? <Text accessibilityLiveRegion="polite" style={[styles.small, { color: c.muted }]}>{m.shared_config_translating()}</Text> : null}
      {translateError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.small, { color: c.muted }]}>{m.shared_config_translate_failed({ error: translateError })}</Text>
      ) : null}

      {preview.map((p) => {
        const choice = picked[p.item];
        const isOpen = open[p.item] ?? (preview.length === 1 && p.changes.length > 0);
        const selectable = p.changes.filter((r) => r.selectable).length;
        return (
          <Card key={p.item}>
            <Disclosure open={isOpen} label={configSyncItemLabel(p.item)} onChange={(v) => setOpen({ ...open, [p.item]: v })} />
            <Text style={[styles.small, { color: c.muted }]}>{p.line}</Text>
            {choice ? (
              <Text style={[styles.small, { color: c.accentText }]}>{m.shared_config_picked({ picked: choice.length, total: selectable })}</Text>
            ) : null}
            {isOpen && choice && p.changes.length ? (
              <View style={styles.buttons}>
                <Pill label={m.shared_config_pick_all()} onPress={() => pickAll(p, true)} />
                <Pill label={m.shared_config_pick_none()} onPress={() => pickAll(p, false)} />
              </View>
            ) : null}
            {isOpen ? GROUPS.map(([group, title, hint]) => {
              const rows = p.changes.filter((r) => r.group === group);
              if (!rows.length) return null;
              return (
                <View key={group} style={styles.group}>
                  {title ? <Text style={[styles.groupTitle, { color: c.faint }]}>{title()}</Text> : null}
                  {hint && choice ? <Text style={[styles.small, { color: c.faint }]}>{hint()}</Text> : null}
                  {rows.map((r) => (
                    <CheckRow
                      key={r.key}
                      label={r.name}
                      mono
                      compact
                      checked={!!choice?.includes(r.key)}
                      disabled={busy || !r.selectable}
                      onPress={() => togglePick(p.item, r.key)}
                      badge={r.status === 'added'
                        ? <Chip text={m.shared_config_row_added()} tone="accent" />
                        : <Chip text={m.shared_config_row_changed()} />}
                    >
                      {r.description ? <Text numberOfLines={2} style={[styles.small, { color: c.muted }]}>{r.description}</Text> : null}
                      {r.scripts.map((sc) => (
                        <View key={sc.name} style={[styles.script, { borderLeftColor: c.border }]}>
                          <Text style={[styles.mono, { color: c.text }]}>{sc.name}</Text>
                          {sc.description ? <Text numberOfLines={2} style={[styles.small, { color: c.muted }]}>{sc.description}</Text> : null}
                        </View>
                      ))}
                    </CheckRow>
                  ))}
                </View>
              );
            }) : null}
            {isOpen ? ([[false, p.same, m.shared_config_same], [true, p.onlyTarget, m.shared_config_only_target]] as const).map(([onlyTarget, rows, text]) => {
              if (!rows.length) return null;
              const key = `${p.item}:${onlyTarget}`;
              const restIsOpen = restOpen.has(key);
              return (
                <View key={key} style={styles.group}>
                  <Disclosure
                    small
                    open={restIsOpen}
                    label={text({ count: rows.length })}
                    onChange={(v) => {
                      const next = new Set(restOpen);
                      if (v) next.add(key); else next.delete(key);
                      setRestOpen(next);
                    }}
                  />
                  {restIsOpen ? <Text style={[styles.mono, { color: c.faint }]}>{rows.map((r) => r.name).join(' · ')}</Text> : null}
                </View>
              );
            }) : null}
          </Card>
        );
      })}

      {targets.map((t) => {
        const report = reports[t.id];
        const diff = diffs[t.id];
        if (!report && !(diff && 'error' in diff) && !(diff && 'ok' in diff && okCount > 1)) return null;
        const error = report && 'error' in report ? report.error : !report && diff && 'error' in diff ? diff.error : '';
        return (
          <Card key={t.id}>
            <Text style={[styles.strong, { color: c.text }]}>{t.label}</Text>
            {error ? <Text accessibilityRole="alert" style={[styles.body, { color: errorColor }]}>{error}</Text> : null}
            {report && 'ok' in report ? (
              <>
                {CONFIG_SYNC_ITEMS.filter((item) => report.ok.items[item]).map((item) => {
                  const res = report.ok.items[item]!;
                  const text = res.status === 'applied' ? m.shared_config_status_applied()
                    : res.status === 'failed' ? m.shared_config_status_failed() : m.shared_config_status_same();
                  return (
                    <View key={item} style={styles.result}>
                      <View style={styles.line}>
                        <Text style={[styles.strong, { color: c.text }]}>{configSyncItemLabel(item)}</Text>
                        <Text style={[styles.body, { color: res.status === 'failed' ? errorColor : c.muted }]}>{text}</Text>
                      </View>
                      {res.changed.length ? <Text style={[styles.small, { color: c.faint }]}>{res.changed.join(', ')}</Text> : null}
                      {res.warnings.map((w, i) => <Text key={i} style={[styles.small, { color: c.faint }]}>{configSyncWarningText(w)}</Text>)}
                    </View>
                  );
                })}
                {report.ok.backup ? <Text style={[styles.small, { color: c.muted }]}>{m.shared_config_backup({ path: report.ok.backup })}</Text> : null}
              </>
            ) : null}
            {!report && diff && 'ok' in diff ? items.filter((item) => diff.ok[item]).map((item) => {
              const d = diff.ok[item]!;
              return (
                <View key={item} style={styles.line}>
                  <Text style={[styles.strong, { color: c.text }]}>{configSyncItemLabel(item)}</Text>
                  <Text style={[styles.small, { color: c.muted }]}>
                    {m.shared_config_diff_line({ added: d.added.length, changed: d.changed.length, same: d.same.length, onlyTarget: d.onlyTarget.length })}
                  </Text>
                </View>
              );
            }) : null}
          </Card>
        );
      })}
    </Pagina>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const c = useSettingsColors();
  return (
    <View style={styles.field}>
      <Text accessibilityRole="header" style={[styles.fieldLabel, { color: c.text }]}>{label}</Text>
      {children}
    </View>
  );
}

function Card({ children }: { children: ReactNode }) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  return <View style={[styles.card, { borderColor: c.border, backgroundColor: superficie(theme, 0.6) }]}>{children}</View>;
}

function CheckRow({ label, checked, disabled, onPress, mono, compact, badge, children }: {
  label: string; checked: boolean; disabled?: boolean; onPress: () => void; mono?: boolean; compact?: boolean; badge?: ReactNode; children?: ReactNode;
}) {
  const c = useSettingsColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: !!disabled }}
      style={({ pressed }) => [styles.check, { borderTopColor: c.border }, compact && styles.compact, pressed && { backgroundColor: c.hover }, disabled && styles.disabled]}
    >
      <Icon name={checked ? 'SquareCheck' : 'Square'} size={20} color={checked ? c.accentText : c.muted} />
      <View style={styles.checkBody}>
        <View style={styles.line}>
          <Text style={[mono ? styles.mono : styles.body, { color: c.text }]}>{label}</Text>
          {badge}
        </View>
        {children}
      </View>
    </Pressable>
  );
}

function Button({ label, primary, disabled, onPress }: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const c = useSettingsColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: c.accent, borderColor: c.accent } : { borderColor: c.borderStrong },
        pressed && { opacity: 0.7 },
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? '#fff' : c.text }]}>{label}</Text>
    </Pressable>
  );
}

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  field: { gap: 8 },
  fieldLabel: { fontSize: 15, fontWeight: '600', paddingHorizontal: 4 },
  self: { alignSelf: 'flex-start' },
  origin: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderWidth: 1, borderRadius: 9999, alignSelf: 'flex-start', maxWidth: '100%' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  body: { fontSize: 15 },
  strong: { fontSize: 15, fontWeight: '600' },
  small: { fontSize: 13.5, lineHeight: 17 },
  mono: { fontSize: 13.5, fontFamily: MONO },
  note: { fontSize: 14, paddingHorizontal: 4 },
  right: { marginLeft: 'auto' },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { height: 40, paddingHorizontal: 18, borderRadius: 9999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  row: { borderTopWidth: 1, paddingVertical: 12, paddingHorizontal: 16, gap: 4 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: 48, borderTopWidth: 1, paddingVertical: 12, paddingHorizontal: 16 },
  // Dentro do cartão da prévia o recuo já é o do cartão.
  compact: { paddingHorizontal: 0 },
  checkBody: { flex: 1, minWidth: 0, gap: 4 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 10 },
  group: { gap: 2 },
  groupTitle: { fontSize: 13, fontWeight: '600', paddingTop: 4 },
  script: { marginTop: 4, paddingLeft: 10, borderLeftWidth: 1, gap: 2 },
  result: { gap: 2 },
});
