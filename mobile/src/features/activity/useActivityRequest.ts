import { useCallback, useEffect, useRef } from 'react';
import * as m from '../../paraglide/messages';

export class ActivityTimeout extends Error {
  constructor() {
    super(m.chat_historico_sem_resposta());
  }
}

export function useActivityRequest() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);

  // A API compartilhada não aceita AbortSignal nestas leituras; a folha limita a própria espera.
  return useCallback(async <T,>(request: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ActivityTimeout()), 15_000);
      timers.current.add(timer);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer!);
      timers.current.delete(timer!);
    }
  }, []);
}
