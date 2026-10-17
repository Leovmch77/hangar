import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { create } from 'zustand';
import { intlLocale, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { Stack, useRouter } from 'expo-router';
import { HeaderBack, useGlassHeader } from '../../ui/glassHeader';
import { Pagina } from '../config/Pagina';
import { Sheet } from '../../ui/Sheet';
import { Icon, type IconName } from '../../ui/Icon';
import { useSettingsColors } from '../config/colors';
import type { ReportPart } from './useReports';
import * as m from '../../paraglide/messages';

export const useUsagePreferences = create(() => ({ period: '30d', off: [] as string[] }));
export const number = (value: number, digits = 0) => value.toLocaleString(intlLocale(), { maximumFractionDigits: digits });
export const dollars = (value: number) => `US$ ${value.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const percent = (part: number, total: number) => `${number(total > 0 ? part / total * 100 : 0, 1)}%`;

export function useReportSelection() {
  const servers = useServers((s) => s.servers);
  const period = useUsagePreferences((s) => s.period);
  const off = useUsagePreferences((s) => s.off);
  const own = servers.filter((s) => !s.invite && !s.disabled);
  return { period, own, selected: own.filter((s) => !off.includes(s.id)) };
}

export function Copy({ children, title = false, muted = false }: { children: ReactNode; title?: boolean; muted?: boolean }) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  return <Text style={{ color: muted ? c.muted : c.text, fontSize: title ? theme.base.text.lg : theme.base.text.sm, fontWeight: title ? '600' : '400' }}>{children}</Text>;
}

export function Action({ label, onPress, selected = false, disabled = false, icon }: { label: string; onPress: () => void; selected?: boolean; disabled?: boolean; icon?: IconName }) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: theme.base.radius.md, backgroundColor: selected ? c.accentDim : 'transparent', flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled ? 0.45 : 1 }}>
    {icon && <Icon name={icon} size={18} color={c.accentText} />}
    <Text style={{ color: selected ? c.accentText : c.text, fontSize: theme.base.text.sm, flexShrink: 1 }}>{label}</Text>
  </Pressable>;
}

export function Card({ children }: { children: ReactNode }) {
  const c = useSettingsColors();
  const { theme } = useUnistyles();
  return <View style={{ padding: 16, gap: 10, backgroundColor: c.inset, borderRadius: theme.base.radius.lg }}>{children}</View>;
}

export function Search({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const c = useSettingsColors();
  const { theme } = useUnistyles();
  return <TextInput accessibilityLabel={m.uso_busca()} placeholder={m.uso_busca()} placeholderTextColor={c.muted} value={value} onChangeText={onChange}
    style={{ color: c.text, fontSize: theme.base.text.sm, padding: 12, minHeight: 44, borderWidth: 1, borderColor: c.borderStrong, borderRadius: theme.base.radius.md }} />;
}

export function Paged<T>({ items, render }: { items: T[]; render: (item: T, index: number) => ReactNode }) {
  const [limit, setLimit] = useState(20);
  if (!items.length) return <Copy muted>{m.uso_vazio_secao()}</Copy>;
  return <View style={{ gap: 8 }}>{items.slice(0, limit).map((item, index) => <View key={index}>{render(item, index)}</View>)}
    {items.length > limit && <Action label={m.uso_mostrar_mais({ n: items.length - limit })} onPress={() => setLimit((n) => n + 20)} />}
    {limit > 20 && <Action label={m.uso_mostrar_menos()} onPress={() => setLimit(20)} />}
  </View>;
}

export function Choice({ label, options, values, onChange, max }: { label: string; options: { key: string; label?: string | null }[]; values: string[]; onChange: (values: string[]) => void; max?: number }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const all = [...options];
  for (const key of values) if (!all.some((item) => item.key === key)) all.push({ key });
  const matches = all.filter((item) => `${item.key} ${item.label ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <Action label={label} icon="ListFilter" selected={values.length > 0} onPress={() => setOpen(true)} />
    {values.length > 0 && <Copy muted>{values.map((key) => all.find((item) => item.key === key)?.label ?? key).join(' · ')}</Copy>}
    {open && <Sheet open onDismiss={() => setOpen(false)} sizes={['large']} scrollable>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
        <Copy title>{label}</Copy>
        <Search value={query} onChange={setQuery} />
        <Action label={m.uso_limpar()} onPress={() => onChange([])} />
        <Paged key={query} items={matches} render={(item) => <Action label={`${label}: ${item.label ?? item.key}`} selected={values.includes(item.key)}
          disabled={!values.includes(item.key) && max !== undefined && max > 1 && values.length >= max}
          icon={values.includes(item.key) ? 'CheckSquare' : 'Square'} onPress={() => onChange(values.includes(item.key) ? values.filter((v) => v !== item.key) : max === 1 ? [item.key] : [...values, item.key])} />} />
        <Action label={m.native_close()} icon="X" onPress={() => setOpen(false)} />
      </ScrollView>
    </Sheet>}
  </>;
}

export function ReportFrame({ title, back, sibling, onSibling, children }: { title: string; back: () => void; sibling: string; onSibling: () => void; children: ReactNode }) {
  const router = useRouter();
  const header = useGlassHeader();
  return <>
    <Stack.Screen options={{ ...header, title, headerLeft: router.canGoBack() ? undefined : () => <HeaderBack onPress={back} /> }} />
    <Pagina>
      <Action label={sibling} icon="ChartNoAxesCombined" onPress={onSibling} />{children}
    </Pagina>
  </>;
}

export function ReportControls({ own, refresh }: { own: Server[]; refresh: () => void }) {
  const period = useUsagePreferences((s) => s.period);
  const off = useUsagePreferences((s) => s.off);
  const periods = [['1d', m.custos_periodo_1d()], ['7d', m.custos_periodo_7d()], ['30d', m.custos_periodo_30d()], ['90d', m.custos_periodo_90d()], ['all', m.custos_periodo_tudo()]];
  return <Card><Copy title>{m.custos_periodo()}</Copy>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{periods.map(([key, label]) => <Action key={key} label={label} selected={period === key} onPress={() => useUsagePreferences.setState({ period: key })} />)}</View>
    <Choice label={m.custos_servidores_relatorio()} options={own.map((s) => ({ key: s.id, label: s.label }))} values={own.filter((s) => !off.includes(s.id)).map((s) => s.id)} onChange={(chosen) => useUsagePreferences.setState({ off: own.filter((s) => !chosen.includes(s.id)).map((s) => s.id) })} />
    <Action label={m.custos_atualizar()} icon="RefreshCw" onPress={refresh} />
  </Card>;
}

export function ReportStatus<R>({ parts, loading, accepted, selected }: { parts: ReportPart<R>[]; loading: boolean; accepted: boolean; selected: number }) {
  return <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
    {loading && <><ActivityIndicator /><Copy>{m.custos_carregando_maquinas({ n: parts.filter((p) => p.pending).length || selected })}</Copy></>}
    {parts.some((p) => p.error) && accepted && <Copy>{m.custos_total_parcial()}</Copy>}
    {parts.map((part) => part.warming ? <Copy key={part.id}>{m.custos_aquecendo_progresso({ maquina: part.label, lidos: part.warming.read, total: part.warming.total })}</Copy> : part.error ? <Copy key={part.id}>{`${part.label}: ${part.error}`}</Copy> : null)}
    {!selected && <Copy>{m.custos_sem_dados_periodo()}</Copy>}
    {!!selected && !loading && !accepted && <Copy>{m.home_usage_load_failed()}</Copy>}
  </View>;
}

export function Bar({ label, value, max, detail, onPress, color }: { label: string; value: number; max: number; detail: string; onPress?: () => void; color?: string }) {
  const c = useSettingsColors();
  const body = <View style={{ gap: 6, paddingVertical: 8 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><View style={{ flex: 1 }}><Copy>{label}</Copy></View><Copy>{detail}</Copy></View>
    <View style={{ height: 5, backgroundColor: c.hover, borderRadius: 3 }}><View style={{ height: 5, width: `${Math.max(0, Math.min(100, max > 0 ? value / max * 100 : 0))}%`, backgroundColor: color ?? c.accent, borderRadius: 3 }} /></View>
  </View>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${detail}`} onPress={onPress} style={{ minHeight: 44 }}>{body}</Pressable> : <View accessible accessibilityLabel={`${label}: ${detail}`}>{body}</View>;
}
