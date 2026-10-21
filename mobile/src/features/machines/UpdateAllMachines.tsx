import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ownUpdatableServers, updateAll } from '@hangar/core';
import type { Server, UpdateAllResult, UpdateAllState } from '@hangar/core';
import { SectionCard } from '../config/SectionCard';
import { SettingsRow } from '../config/SettingsRow';
import { useSettingsColors } from '../config/colors';
import { MachineSheet, Notice } from './parts';
import { haptic } from '../../ui/haptics';
import * as m from '../../paraglide/messages';

function statusText(value: UpdateAllState): string {
  switch (value.status) {
    case 'consultando': return m.update_all_checking();
    case 'iniciando': return m.update_all_starting();
    case 'rodando': return m.update_all_running({ texto: value.state?.texto ?? '', passo: String(value.state?.passo ?? 0), total: String(value.state?.total ?? 0) });
    case 'esperando': return m.update_all_waiting();
    case 'em_dia': return m.update_all_up_to_date();
    case 'travado':
      switch (value.reason) {
        case 'branch': return m.update_all_held_branch();
        case 'mudancas': return m.update_all_held_changes();
        case 'rodando': return m.update_all_held_running();
        default: return m.update_all_held_missing();
      }
    case 'fora_do_ar': return m.update_all_offline();
    case 'atualizado': return m.update_all_updated();
    case 'atualizado_manual': return m.update_all_updated_manual();
    case 'falhou': return m.update_all_failed({ erro: value.errorCode === 'silent' ? m.update_all_silent()
      : value.errorCode === 'timeout' ? m.update_all_timeout() : value.error || m.erro_desconhecido() });
  }
}

const needsAttention = (value: UpdateAllState) => ['falhou', 'fora_do_ar', 'travado'].includes(value.status);

export function UpdateAllMachines({ servers }: { servers: readonly Server[] }) {
  const c = useSettingsColors();
  const candidates = ownUpdatableServers(servers);
  const alive = useRef(true);
  const running = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [rows, setRows] = useState<UpdateAllResult[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const start = async () => {
    setOpen(true);
    if (running.current) return;
    running.current = true;
    setBusy(true); setCount(candidates.length); setRows([]); setError('');
    try {
      const results = await updateAll(candidates, (id, state) => {
        if (!alive.current) return;
        const server = candidates.find((entry) => entry.id === id);
        if (!server) return;
        // O core só publica representantes depois de tirar endereços da mesma máquina.
        setRows((previous) => previous.some((row) => row.server.id === id)
          ? previous.map((row) => row.server.id === id ? { server, state } : row)
          : [...previous, { server, state }]);
      });
      if (!alive.current) return;
      setRows(results);
      if (!results.length || results.some((row) => needsAttention(row.state))) haptic.error();
      else haptic.success();
    } catch (cause) {
      if (!alive.current) return;
      setError(m.update_all_failed({ erro: cause instanceof Error ? cause.message : String(cause) }));
      haptic.error();
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };

  if (candidates.length < 2 && !busy && !open) return null;
  const buttonLabel = m.update_all_button({ n: String(busy ? count : candidates.length) });
  return <>
    {candidates.length >= 2 || busy ? <Pressable accessibilityRole="button" accessibilityLabel={buttonLabel}
      onPress={() => void start()} style={({ pressed }) => [styles.button, { borderColor: c.borderStrong }, pressed && { backgroundColor: c.hover }]}>
      <Text style={[styles.label, { color: c.text }]}>{buttonLabel}</Text>
    </Pressable> : null}
    {open ? <MachineSheet title={m.update_all_title()} onClose={() => setOpen(false)}>
      {busy && rows.length === 0 ? <Notice text={m.update_all_checking()} /> : null}
      <Notice text={error} error />
      {!busy && !error && rows.length === 0 ? <Notice text={m.maquinas_vazio()} /> : null}
      {rows.length ? <SectionCard>
        {rows.map(({ server, state }) => <SettingsRow key={server.id} title={server.label} description={server.baseUrl}>
          <Notice text={statusText(state)} error={needsAttention(state)} />
          {state.status === 'travado' && state.reason === 'falta' && state.preflight?.faltando.length
            ? <Notice text={state.preflight.faltando.join(', ')} /> : null}
          {state.warnings.length ? <View style={styles.warnings}>
            <Notice text={m.update_all_warnings()} />
            {state.warnings.map((warning, index) => <Notice key={index} text={warning} />)}
          </View> : null}
        </SettingsRow>)}
      </SectionCard> : null}
    </MachineSheet> : null}
  </>;
}

const styles = StyleSheet.create((theme) => ({
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[3], paddingVertical: theme.base.space[2], borderWidth: 1, borderRadius: theme.base.radius.md },
  label: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.medium },
  warnings: { gap: theme.base.space[2], marginTop: theme.base.space[2] },
}));
