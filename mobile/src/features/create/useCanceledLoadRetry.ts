import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { isNativeCancellation } from './loadError';

// A época permite recuperar também a rejeição que o iOS entrega depois do active.
export function useCanceledLoadRetry(retry: () => void) {
  const epoch = useRef(0);
  const pending = useRef<(() => void) | null>(null);
  const state = useRef(AppState.currentState);
  const focused = useRef(false);
  const resume = useCallback(() => {
    epoch.current++;
    if (state.current === 'active' && focused.current) pending.current?.();
  }, []);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    resume();
    return () => { focused.current = false; };
  }, [resume]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const previous = state.current;
      state.current = next;
      if (next === 'active' && previous !== 'active') resume();
    });
    return () => { subscription.remove(); pending.current = null; };
  }, [resume]);

  return useCallback(() => {
    pending.current = null;
    const started = epoch.current;
    let disposed = false;
    const run = () => {
      pending.current = null;
      if (!disposed) retry();
    };
    return {
      failed(error: unknown) {
        if (disposed || !isNativeCancellation(error)) return;
        pending.current = run;
        if (epoch.current > started && state.current === 'active' && focused.current) run();
      },
      cancel() {
        disposed = true;
        if (pending.current === run) pending.current = null;
      },
    };
  }, [retry]);
}
