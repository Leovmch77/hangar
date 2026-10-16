import { afterEach, describe, expect, it } from 'vitest';
import { beginVoiceDictation, setLiveVoiceAudioActive, useVoiceAudioState } from './audioSession';

afterEach(() => useVoiceAudioState.setState({ voiceActive: false, dictations: 0 }));

describe('coexistência de áudio', () => {
  it('começa sem chamada nem ditado e mantém uma única chamada ativa', () => {
    expect(useVoiceAudioState.getState()).toEqual({ voiceActive: false, dictations: 0 });
    setLiveVoiceAudioActive(true);
    setLiveVoiceAudioActive(true);
    expect(useVoiceAudioState.getState()).toEqual({ voiceActive: true, dictations: 0 });
    setLiveVoiceAudioActive(false);
    expect(useVoiceAudioState.getState()).toEqual({ voiceActive: false, dictations: 0 });
  });

  it('conta ditados imediatamente e cada liberação só desconta uma vez', () => {
    const first = beginVoiceDictation();
    expect(useVoiceAudioState.getState().dictations).toBe(1);
    const second = beginVoiceDictation();
    expect(useVoiceAudioState.getState().dictations).toBe(2);
    first();
    first();
    expect(useVoiceAudioState.getState().dictations).toBe(1);
    second();
    second();
    expect(useVoiceAudioState.getState().dictations).toBe(0);
  });

  it('mudar a chamada não perde os ditados nem sua liberação muda a chamada', () => {
    const release = beginVoiceDictation();
    setLiveVoiceAudioActive(true);
    expect(useVoiceAudioState.getState()).toEqual({ voiceActive: true, dictations: 1 });
    release();
    expect(useVoiceAudioState.getState()).toEqual({ voiceActive: true, dictations: 0 });
    setLiveVoiceAudioActive(false);
    expect(useVoiceAudioState.getState()).toEqual({ voiceActive: false, dictations: 0 });
  });
});
