import { create } from 'zustand';

export const useVoiceAudioState = create<{ voiceActive: boolean; dictations: number }>(() => ({
  voiceActive: false,
  dictations: 0,
}));

export function setLiveVoiceAudioActive(active: boolean): void {
  useVoiceAudioState.setState({ voiceActive: active });
}

export function beginVoiceDictation(): () => void {
  let released = false;
  useVoiceAudioState.setState((state) => ({ dictations: state.dictations + 1 }));
  return () => {
    if (released) return;
    released = true;
    useVoiceAudioState.setState((state) => ({ dictations: Math.max(0, state.dictations - 1) }));
  };
}
