import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { deleteEngineForServer, getEnginesForServer, type EnginesResponse, type Server } from '@hangar/core';
import * as m from '../../paraglide/messages';

export function useEngines(server: Server | null, onChanged: () => void) {
  const [data, setData] = useState<EnginesResponse | null>(null);
  const [loading, setLoading] = useState(!!server);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const deletingNow = useRef(new Set<string>());
  const seq = useRef(0);
  const alive = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const reload = useCallback(async () => {
    if (!server || !alive.current) return;
    const turn = ++seq.current;
    setLoading(true); setError('');
    try {
      const response = await getEnginesForServer(server);
      if (alive.current && turn === seq.current) setData(response);
    } catch (cause) {
      if (alive.current && turn === seq.current) {
        setData(null);
        setError(cause instanceof Error ? cause.message : m.erro_desconhecido());
      }
    } finally { if (alive.current && turn === seq.current) setLoading(false); }
  }, [server?.id, server?.baseUrl, server?.token]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; seq.current++; };
  }, [reload]);
  const ready = !!data && !data.arquivo_corrompido && !loading && !error;
  function remove(name: string) {
    if (!server || !ready || deletingNow.current.has(name)) return;
    const target = server;
    Alert.alert(m.mobile_accounts_engine_delete_confirm({ name }), '', [
      { text: m.comum_cancelar(), style: 'cancel' },
      { text: m.mobile_accounts_engine_delete(), style: 'destructive', onPress: () => {
        if (!alive.current || deletingNow.current.has(name)) return;
        deletingNow.current.add(name); setDeleting(new Set(deletingNow.current)); setError(''); setNotice('');
        void deleteEngineForServer(target, name).then(result => {
          if (!alive.current) return;
          if (!result.ok) throw new Error(m.erro_desconhecido());
          void reload(); changed.current();
        }).catch((cause: unknown) => {
          if (alive.current) setError(cause instanceof Error ? cause.message : m.erro_desconhecido());
        }).finally(() => {
          deletingNow.current.delete(name);
          if (alive.current) setDeleting(new Set(deletingNow.current));
        });
      } },
    ]);
  }
  function saved() {
    if (!alive.current) return;
    setEditing(null); setNotice(m.mobile_accounts_engine_saved());
    void reload(); changed.current();
  }
  return { data, loading, error, notice, ready, editing, setEditing, deleting, reload, remove, saved };
}

export function EngineStatus({ state }: { state: ReturnType<typeof useEngines> }) {
  if (state.loading) return <Text style={styles.muted}>{m.comum_carregando()}</Text>;
  if (state.error) return <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text>;
  if (state.data?.arquivo_corrompido) return <Text accessibilityRole="alert" style={styles.error}>
    {m.mobile_accounts_engine_corrupt({ path: state.data.arquivo_caminho })}
  </Text>;
  if (state.ready && !Object.keys(state.data!.motores).length) return <Text style={styles.muted}>{m.mobile_accounts_engine_empty()}</Text>;
  return state.notice ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{state.notice}</Text> : null;
}

const styles = StyleSheet.create(theme => ({
  error: { color: theme.tokens.status.error, fontSize: 14, paddingHorizontal: 4 },
  muted: { color: theme.tokens.text.muted, fontSize: 14, paddingHorizontal: 4 },
}));
