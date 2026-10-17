// Hook incremental para derivar Activity a partir do fluxo de ChatEvent.
// Porte do padrão de Chat.svelte:831 — createActivityFolder() alimentado evento a evento.
import { useMemo, useRef } from 'react';
import { createActivityFolder } from '@hangar/core';
import type { Activity, ChatEvent } from '@hangar/core';

type Folder = ReturnType<typeof createActivityFolder>;
export type FeedCursor = { count: number; firstId: string | undefined; eventsRevision: number };

// Revisão mudou ou histórico entrou na frente: não é append, e só ler a cauda perderia alterações.
export function feedFolder(folder: Folder, cursor: FeedCursor, events: ChatEvent[], eventsRevision: number): FeedCursor {
  const firstId = events[0]?.id;
  if (eventsRevision !== cursor.eventsRevision || events.length < cursor.count || firstId !== cursor.firstId) {
    folder.reset(events);
  } else {
    for (let i = cursor.count; i < events.length; i++) {
      const ev = events[i];
      if (ev) folder.push(ev);
    }
  }
  return { count: events.length, firstId, eventsRevision };
}

export function useActivity(events: ChatEvent[], eventsRevision: number): Activity {
  const folder = useRef(createActivityFolder());
  const cursor = useRef<FeedCursor>({ count: 0, firstId: undefined, eventsRevision });

  // precisa acontecer durante o render, antes do snapshot — é o que evita re-varrer tudo
  cursor.current = feedFolder(folder.current, cursor.current, events, eventsRevision);

  return useMemo(() => folder.current.snapshot(), [events, eventsRevision]);
}
