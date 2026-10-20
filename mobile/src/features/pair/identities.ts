import { useEffect, useMemo, useReducer } from 'react';
import type { Server } from '@hangar/core';
import { readIdentifier } from '../machines/api';

// Identificador de cada máquina, lido sob demanda e guardado por endereço, como a PWA (sessionsStore).
const known = new Map<string, string>();
const failedUntil = new Map<string, number>();
const cacheKey = (s: Server) => `${s.id}\n${s.baseUrl}`;

/** Máquina do app → identificador; `loading` são as que ainda não responderam. Falha repete em 30 s. */
export function useIdentities(servers: Server[]) {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const own = servers.filter((s) => !s.invite);
  const keys = own.map(cacheKey).join('\0');
  useEffect(() => {
    const controller = new AbortController();
    for (const server of own) {
      const key = cacheKey(server);
      if (known.has(key) || Date.now() < (failedUntil.get(key) ?? 0)) continue;
      failedUntil.delete(key);
      readIdentifier(server, controller.signal).then(
        (value) => { known.set(key, value.identificador); },
        () => { if (!controller.signal.aborted) failedUntil.set(key, Date.now() + 30_000); },
      ).finally(() => { if (!controller.signal.aborted) bump(); });
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return useMemo(() => {
    const identities = new Map<string, string>();
    const loading = new Set<string>();
    for (const server of own) {
      const id = known.get(cacheKey(server));
      if (id) identities.set(server.id, id);
      else if (!failedUntil.has(cacheKey(server))) loading.add(server.id);
    }
    return { identities, loading };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, version]);
}
