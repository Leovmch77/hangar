import { NativeModule, requireNativeModule } from 'expo';

export type LiveVoiceAudioOptions = {
  title: string;
  body: string;
  stopLabel: string;
};

export type LiveVoiceAudioEvents = {
  interruption: (event: { reason: string }) => void;
  tick: () => void;
};

declare class LiveVoiceAudioModule extends NativeModule<LiveVoiceAudioEvents> {
  start(options: LiveVoiceAudioOptions): Promise<void>;
  stop(): Promise<void>;
}

export default requireNativeModule<LiveVoiceAudioModule>('LiveVoiceAudio');
