import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { Server } from '@hangar/core';
import { prefs } from '../stores/prefs';
import * as m from '../paraglide/messages';
import { readQueueJev, type DeliveryControls, type DeliveryMode, type JevStatus } from './queueDelivery';

const KEY = 'queue.deliveryMode';
const saved = prefs.getString(KEY);
export const useDeliveryMode = create<{ mode: DeliveryMode; setMode: (mode: DeliveryMode) => void }>((set) => ({
  mode: saved === 'direct' || saved === 'jev' ? saved : 'queued',
  setMode: (mode) => { prefs.set(KEY, mode); set({ mode }); },
}));

type Availability = { identity: string; status: JevStatus; error?: string };
export function useQueueDelivery(server: Server | undefined, enabled: boolean): DeliveryControls {
  const mode = useDeliveryMode((s) => s.mode);
  const identity = JSON.stringify([server?.id, server?.baseUrl, server?.token]);
  const [availability, setAvailability] = useState<Availability | null>(null);
  useEffect(() => {
    if (!server || !enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const available = await readQueueJev(server!, controller.signal);
        if (!controller.signal.aborted) setAvailability({ identity, status: available ? 'ready' : 'setup' });
      } catch (error) {
        if (!controller.signal.aborted) setAvailability({ identity, status: (error as { status?: number })?.status === 404 ? 'unsupported' : 'error',
          error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 30_000);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [identity, enabled]);
  const current = availability?.identity === identity ? availability : null;
  const status = current?.status ?? 'loading';
  const help = status === 'ready' ? m.native_queue_jev_help() : status === 'setup' ? m.native_queue_jev_setup()
    : status === 'unsupported' ? m.native_queue_jev_unsupported() : status === 'error'
      ? m.native_queue_jev_read_error({ error: current?.error ?? '' }) : m.native_queue_jev_loading();
  return { mode, status, help };
}
