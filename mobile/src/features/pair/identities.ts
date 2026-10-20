import { useEffect, useMemo, useReducer } from 'react';
import type { Server } from '@hangar/core';
import { readIdentifier } from '../machines/api';

// Identificador de cada máquina, lido sob demanda e guardado por endereço, como a PWA (sessionsStore).
const known = new Map<string, string>();
const failedUntil = new Map<string, number>();
const cacheKey = (s: Server) => `${s.id}\n${s.baseUrl}`;
const RETRY_MS = 30_000;

/** Máquina do app → identificador; `loading` são as que ainda não responderam. Falha repete em 30 s. */
export function useIdentities(servers: Server[]) {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const own = servers.filter((s) => !s.invite);
  const keys = own.map(cacheKey).join('\0');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Uma releitura agendada por vez, para a falha que vence primeiro; sem falha pendente, nada fica agendado.
    const retryIn = (ms: number) => {
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; read(); }, ms);
    };
    const failed = (key: string) => {
      failedUntil.set(key, Date.now() + RETRY_MS);
      retryIn(RETRY_MS);
    };
    const read = () => {
      for (const server of own) {
        const key = cacheKey(server);
        if (known.has(key)) continue;
        const wait = (failedUntil.get(key) ?? 0) - Date.now();
        if (wait > 0) { retryIn(wait); continue; }
        failedUntil.delete(key);
        readIdentifier(server, controller.signal).then(
          // Vazio é máquina sem CP_SERVER_ID: falha relida no mesmo intervalo, para o conserto aparecer sem reabrir.
          (value) => { if (value.identificador) known.set(key, value.identificador); else if (!controller.signal.aborted) failed(key); },
          () => { if (!controller.signal.aborted) failed(key); },
        ).finally(() => { if (!controller.signal.aborted) bump(); });
      }
    };
    read();
    return () => { controller.abort(); clearTimeout(timer); };
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
