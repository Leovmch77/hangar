import { useCallback, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getSubagents, type SubagentRun } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { ActivityTimeout, useActivityRequest } from './useActivityRequest';
import * as m from '../../paraglide/messages';

const EMPTY: SubagentRun[] = [];

export function useAgentSubagents(serverId: string | undefined, name: string | undefined, enabled: boolean) {
  const server = useServers(state => state.servers.find(item => item.id === serverId));
  const key = `${serverId}::${name}`;
  const [snapshot, setSnapshot] = useState({ key, subs: EMPTY, error: '' });
  const [attempt, setAttempt] = useState(0);
  const read = useActivityRequest();
  const retry = useCallback(() => {
    setSnapshot(current => ({ ...current, error: '' }));
    setAttempt(current => current + 1);
  }, []);

  useFocusEffect(useCallback(() => {
    if (!enabled || !server || !name) return;
    let stopped = false;
    let busy = false;
    let timedOut = false;
    const refresh = async () => {
      if (stopped || busy || timedOut || AppState.currentState !== 'active') return;
      busy = true;
      try {
        const subs = await read(getSubagents(name, server));
        if (!stopped) setSnapshot(current => {
          const models = (rows: SubagentRun[]) => rows.map(sub => [sub.agentId, sub.prompt, sub.model]);
          if (current.key === key && !current.error && JSON.stringify(models(current.subs)) === JSON.stringify(models(subs))) return current;
          return { key, subs, error: '' };
        });
      } catch (error) {
        timedOut = error instanceof ActivityTimeout;
        if (!stopped) setSnapshot(current => ({ key, subs: current.key === key ? current.subs : EMPTY,
          error: error instanceof ActivityTimeout ? error.message : m.atividade_erro_subagentes() }));
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5_000);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { stopped = true; clearInterval(timer); appState.remove(); };
  }, [enabled, server, name, key, read, attempt]));

  return { ...(snapshot.key === key ? snapshot : { key, subs: EMPTY, error: '' }), retry };
}
