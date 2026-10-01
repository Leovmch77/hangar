import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Directory } from 'expo-file-system';
import { getDiagFileForServer, getDiagSummaryForServer, type LinhaDiag, type ResumoDiag } from '@hangar/core';
import { Pagina } from '../../src/features/config/Pagina';
import { PageHeader, Pill } from '../../src/features/config/PageHeader';
import { SectionCard } from '../../src/features/config/SectionCard';
import { SettingsRow } from '../../src/features/config/SettingsRow';
import { InfoNotice } from '../../src/features/config/InfoNotice';
import { useSettingsColors } from '../../src/features/config/colors';
import { useServers } from '../../src/stores/servers';
import * as m from '../../src/paraglide/messages';

/** `missing`: servidor anterior à rota do diário; não é falha, só não há o que mostrar. */
type Diary = ResumoDiag & { missing: boolean };
type Download = { state: 'choosing' | 'downloading' } | { state: 'done'; text: string } | { state: 'failed'; text: string };

function sizeText(bytes: number): string {
  const [value, unit] = bytes >= 1 << 20 ? [bytes / (1 << 20), 'MB'] : bytes >= 1024 ? [bytes / 1024, 'KB'] : [bytes, 'B'];
  return `${unit === 'B' ? value.toFixed(0) : value.toFixed(1).replace('.', m.native_decimal())} ${unit}`;
}

/** "2026-09-24T14:37:12-03:00" → "24/09 14:37:12", no relógio de quem gravou. */
function when(ts: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts ?? '');
  return match ? `${match[2]}/${match[1]} ${match[3]}` : '--/-- --:--:--';
}

// O código HTTP só quando não deu certo, como no desktop.
function context(line: LinhaDiag): string {
  const platform = line.so ? [line.so, line.navegador, line.vista, line.tela_px].filter(Boolean).join(' · ') : '';
  const code = line.codigo && line.nivel && line.nivel !== 'ok' ? `#${line.codigo}` : '';
  return [line.detalhe, platform, line.sessao, line.tela, code, line.ms != null ? `${line.ms}ms` : '']
    .filter(Boolean).join(' · ');
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const cancelled = (e: unknown) => /CANCEL/i.test(String((e as { code?: string }).code ?? ''));

export default function UsageLogPage() {
  const server = useServers((s) => s.active());
  const c = useSettingsColors();
  const { theme } = useUnistyles();
  const [diary, setDiary] = useState<Diary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [download, setDownload] = useState<Download | null>(null);
  const generation = useRef(0);

  const load = useCallback(() => {
    const now = ++generation.current;
    if (!server) return;
    setLoading(true);
    setError('');
    // O "Salvo em…" anterior sai: a linha volta a descrever o diário que está chegando.
    setDownload((d) => (d?.state === 'choosing' || d?.state === 'downloading' ? d : null));
    getDiagSummaryForServer(server)
      .then((next) => { if (now === generation.current) setDiary({ ...next, missing: false }); })
      .catch((cause: unknown) => {
        if (now !== generation.current) return;
        if ((cause as { status?: number }).status === 404) {
          setDiary({ dias: 0, bytes: 0, arquivos: [], dias_guardados: 7, ultimas: [], missing: true });
        } else setError(cause instanceof Error ? cause.message : m.native_invalid_response());
      })
      .finally(() => { if (now === generation.current) setLoading(false); });
  }, [server]);

  useEffect(() => {
    setDiary(null);
    setDownload(null);
    load();
    return () => { generation.current++; };
  }, [load, server?.id, server?.baseUrl, server?.token]);

  // Escolhe onde salvar primeiro; só então pede o arquivo ao servidor.
  const save = async () => {
    if (!server || download?.state === 'choosing' || download?.state === 'downloading') return;
    setDownload({ state: 'choosing' });
    let folder: Directory;
    try {
      folder = await Directory.pickDirectoryAsync();
    } catch (e) {
      setDownload(cancelled(e) ? null : { state: 'failed', text: m.native_save_dialog_failed() });
      return;
    }
    setDownload({ state: 'downloading' });
    try {
      const text = await getDiagFileForServer(server);
      const name = `hangar-uso-${stamp()}.jsonl`;
      try {
        folder.createFile(name, 'application/x-ndjson').write(text);
      } catch {
        setDownload({ state: 'failed', text: m.native_save_failed() });
        return;
      }
      setDownload({ state: 'done', text: m.native_saved({ path: `${folder.name}/${name}` }) });
    } catch (cause) {
      setDownload({ state: 'failed', text: cause instanceof Error ? cause.message : m.native_save_failed() });
    }
  };

  const header = (
    <PageHeader
      title={m.native_settings_page_diary()}
      subtitle={m.native_settings_diary_lead({ server: server?.label ?? '' })}
    />
  );
  if (!server) return <Pagina>{header}<InfoNotice text={m.native_settings_offline()} /></Pagina>;

  const keep = diary?.dias_guardados ?? 7;
  const status = download?.state === 'choosing' ? m.native_settings_diary_choosing()
    : download?.state === 'downloading' ? m.native_settings_diary_downloading()
    : download && 'text' in download ? download.text
    : diary && diary.dias > 0 ? m.native_settings_diary_has({ days: String(diary.dias), size: sizeText(diary.bytes) })
    : diary ? (diary.missing ? m.native_diary_missing() : m.native_settings_diary_empty())
    : loading ? m.native_settings_diary_loading() : '';
  const busy = download?.state === 'choosing' || download?.state === 'downloading';
  const levelColor = (l: LinhaDiag['nivel']) =>
    l === 'erro' ? theme.tokens.status.error : l === 'aviso' ? theme.tokens.status.warning : c.text;
  const note = (text: string, color: string, alert = false) => (
    <Text accessibilityRole={alert ? 'alert' : undefined} style={[styles.note, { color }]}>{text}</Text>
  );

  return (
    <Pagina>
      {header}
      <SectionCard icon="ShieldCheck" title={m.native_settings_diary_rules()}>
        <SettingsRow icon="HardDrive" title={m.native_settings_diary_rule_local()} />
        <SettingsRow icon="EyeOff" title={m.native_settings_diary_rule_private()} />
        <SettingsRow icon="Clock" title={m.native_settings_diary_rule_keep({ days: String(keep) })} />
      </SectionCard>
      <SectionCard icon="FileText" title={m.native_settings_diary_file()}>
        <SettingsRow icon="Download" title={m.native_settings_diary_download()} description={download?.state === 'failed' ? undefined : status}>
          {download?.state === 'failed' ? note(download.text, theme.tokens.status.error, true) : null}
          {/* Sem dias gravados não há o que baixar: o botão some em vez de baixar um arquivo vazio. */}
          {diary && diary.dias > 0 && !busy ? (
            <View style={styles.row}><Pill icon="Download" label={m.native_settings_diary_download()} onPress={() => { void save(); }} /></View>
          ) : null}
        </SettingsRow>
      </SectionCard>
      <SectionCard
        icon="List"
        title={m.native_settings_diary_recent()}
        extra={<Pill icon="RefreshCw" label={loading ? m.native_settings_diary_reloading() : m.native_settings_diary_reload()} onPress={() => { if (!loading) load(); }} />}
      >
        {diary && diary.ultimas.length ? (
          <ScrollView style={styles.lines} nestedScrollEnabled>
            {diary.ultimas.map((line, n) => (
              <View key={`${line.ts}-${n}`} style={[styles.line, { borderTopColor: c.border }]}>
                <View style={styles.lineHead}>
                  <Text style={[styles.mono, { color: c.muted }]}>{when(line.ts)}</Text>
                  <Text style={[styles.mono, styles.event, { color: levelColor(line.nivel) }]} numberOfLines={1}>{line.evento || '?'}</Text>
                </View>
                {context(line) ? <Text style={[styles.mono, { color: c.muted }]}>{context(line)}</Text> : null}
              </View>
            ))}
          </ScrollView>
        ) : diary ? note(diary.missing ? m.native_diary_missing() : m.native_settings_diary_empty(), c.muted)
          : error && !loading ? note(error, theme.tokens.status.error, true)
          : note(m.native_settings_diary_loading(), c.muted)}
        {diary && error ? note(error, theme.tokens.status.error, true) : null}
      </SectionCard>
    </Pagina>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 14 },
  lines: { maxHeight: 420 },
  line: { borderTopWidth: 1, paddingHorizontal: 16, paddingVertical: 8, gap: 2 },
  lineHead: { flexDirection: 'row', gap: 10, alignItems: 'baseline' },
  event: { flexShrink: 1, fontWeight: '600' },
  mono: { fontFamily: theme.base.fontMono, fontSize: 13 },
}));
