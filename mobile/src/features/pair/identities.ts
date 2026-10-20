import { useEffect, useMemo, useReducer } from 'react';
import { GROUP_IDENTITY_RETRY_MS, readGroupIdentity, type Server } from '@hangar/core';

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Uma releitura agendada por vez, para a falha que vence primeiro; sem falha pendente, nada fica agendado.
    const retryIn = (ms: number) => {
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; read(); }, ms);
    };
    const failed = (key: string) => {
      failedUntil.set(key, Date.now() + GROUP_IDENTITY_RETRY_MS);
      retryIn(GROUP_IDENTITY_RETRY_MS);
    };
    const read = () => {
      for (const server of own) {
        const key = cacheKey(server);
        if (known.has(key)) continue;
        const wait = (failedUntil.get(key) ?? 0) - Date.now();
        if (wait > 0) { retryIn(wait); continue; }
        failedUntil.delete(key);
        readGroupIdentity(server, controller.signal).then(
          (id) => { known.set(key, id); },
          () => { if (!controller.signal.aborted) failed(key); },
        ).finally(() => { if (!controller.signal.aborted) bump(); });
      }
    };
    read();
    return () => { controller.abort(); clearTimeout(timer); };
    // `keys` resume `own`: o array novo a cada render reabriria a leitura sem mudar máquina.
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
    // `version` avisa que os mapas do módulo mudaram; `own` já entra por `keys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, version]);
}
