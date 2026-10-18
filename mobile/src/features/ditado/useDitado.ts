import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  requestNotificationPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import type { AudioRecorder, RecordingEvents, RecordingStatus } from 'expo-audio';
import type { SharedObject } from 'expo';
import { runtimeVersion } from 'expo-updates';
import { useSharedValue } from 'react-native-reanimated';
import { novoEstadoVad, passoVad, registrarDiag } from '@hangar/core';
import type { EstadoVad, MotivoFim, Server } from '@hangar/core';
import * as m from '../../paraglide/messages';
import { dictationStyleStore } from './ditadoEstiloStore';
import { beginVoiceDictation } from '../voice/audioSession';

const STOP_STATUS_TIMEOUT_MS = 5_000;

// O serviço de segundo plano precisa existir no binário, não só na atualização JS.
const backgroundRecording = () => Platform.OS === 'ios'
  || (Platform.OS === 'android' && Number(/^native-(\d+)$/.exec(runtimeVersion ?? '')?.[1]) >= 3);

// O tipo do áudio não resolve a base quando o core do Expo fica aninhado no SDK.
type ManagedRecorder = AudioRecorder & InstanceType<SharedObject<RecordingEvents>>;

interface Opts {
  onFim: (file: File, motivo: MotivoFim, uri: string) => void;
  onErroParada?: (e: Error) => void;
  /** Máquina da conversa: o teto da gravação é o configurado nela. */
  server?: Server | null;
}

interface Recording {
  recorder: ManagedRecorder | null;
  releaseAudio: () => void;
  phase: 'permission' | 'preparing' | 'recording' | 'stopping';
  interrupted: boolean;
  onFim: Opts['onFim'];
  onErroParada: Opts['onErroParada'];
  reason?: MotivoFim;
  stopping?: Promise<void>;
  finished: Promise<RecordingStatus>;
  error?: Error;
  errorReported?: boolean;
  ceilingMs?: number;
  subscription?: { remove(): void };
}

function reportRecordingError(recording: Recording, error: unknown) {
  if (recording.errorReported) return;
  recording.errorReported = true;
  try {
    recording.onErroParada?.(error instanceof Error ? error : new Error('ditado_parada_falhou'));
  } catch (callbackError) {
    console.error(callbackError);
  }
}

export function useDitado({ onFim, onErroParada, server }: Opts) {
  const [gravando, setGravando] = useState(false);
  const rms = useSharedValue(0);

  const vadRef = useRef<EstadoVad>(novoEstadoVad());
  const recordingRef = useRef<Recording | null>(null);
  const mountedRef = useRef(true);
  const appStateRef = useRef(AppState.currentState);
  const intervaloRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tetoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inicioRef = useRef<number>(0);

  const limparTimers = useCallback(() => {
    if (intervaloRef.current) {
      clearInterval(intervaloRef.current);
      intervaloRef.current = null;
    }
    if (tetoRef.current) {
      clearTimeout(tetoRef.current);
      tetoRef.current = null;
    }
  }, []);

  const releaseRecording = useCallback((recording: Recording) => {
    try {
      recording.subscription?.remove();
    } catch (e) {
      reportRecordingError(recording, e);
    }
    try {
      recording.recorder?.release();
    } catch (e) {
      reportRecordingError(recording, e);
    } finally {
      if (recordingRef.current === recording) recordingRef.current = null;
      recording.releaseAudio();
    }
  }, []);

  const finishRecording = useCallback(
    (recording: Recording, motivo: MotivoFim): Promise<void> => {
      recording.interrupted = true;
      if (!recording.reason || motivo === 'escondeu') recording.reason = motivo;
      if (recording.stopping) return recording.stopping;
      // A preparação pendente termina antes de liberar o objeto nativo.
      if (recording.phase !== 'recording' || !recording.recorder) return Promise.resolve();
      const recorder = recording.recorder;
      recording.phase = 'stopping';
      limparTimers();
      recording.stopping = (async () => {
        let statusTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Sem confirmação nativa, falha em vez de entregar áudio incerto.
          const status = await Promise.race([
            (async () => { await recorder.stop(); return recording.finished; })(),
            new Promise<never>((_, reject) => {
              statusTimer = setTimeout(() => {
                reject(new Error('ditado_parada_falhou', { cause: 'recording_status_timeout' }));
              }, STOP_STATUS_TIMEOUT_MS);
            }),
          ]);
          if (recording.error) throw recording.error;
          const uri = status.url ?? recorder.uri;
          if (!uri) throw new Error('ditado_parada_falhou');
          const res = await fetch(uri);
          const blob = await res.blob();
          if (recording.error) throw recording.error;
          const file = new File([blob], 'ditado.m4a', { type: 'audio/m4a' });
          recording.onFim(file, recording.reason ?? motivo, uri);
        } catch (e) {
          reportRecordingError(recording, e);
        } finally {
          if (statusTimer !== undefined) clearTimeout(statusTimer);
          releaseRecording(recording);
          if (mountedRef.current) {
            setGravando(false);
            rms.value = 0;
          }
        }
      })();
      return recording.stopping;
    },
    [limparTimers, releaseRecording, rms],
  );

  const parar = useCallback((motivo: MotivoFim) => {
    const recording = recordingRef.current;
    return recording ? finishRecording(recording, motivo) : Promise.resolve();
  }, [finishRecording]);

  const pararRef = useRef(parar);
  pararRef.current = parar;

  const iniciar = useCallback(async () => {
    if (recordingRef.current || !mountedRef.current || appStateRef.current !== 'active') return;
    let complete!: (status: RecordingStatus) => void;
    const finished = new Promise<RecordingStatus>((resolve) => { complete = resolve; });
    const recording: Recording = {
      recorder: null, releaseAudio: beginVoiceDictation(),
      phase: 'permission', interrupted: false, onFim, onErroParada, finished,
    };
    recordingRef.current = recording;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (recording.interrupted) return;
      if (!perm.granted) throw new Error('permission_denied');
      const background = backgroundRecording();
      if (background && Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        const notifications = await requestNotificationPermissionsAsync();
        if (recording.interrupted) return;
        if (!notifications.granted) throw new Error(m.push_permissao_negada());
      }
      recording.phase = 'preparing';
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: background });
      if (recording.interrupted) return;

      const options = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
      // O hook do Expo libera no unmount antes da parada assíncrona; este objeto vive até a leitura.
      const recorder = new AudioModule.AudioRecorder({
        ...options,
        ...(Platform.OS === 'ios' ? options.ios : Platform.OS === 'android' ? options.android : options.web),
      }) as ManagedRecorder;
      recording.recorder = recorder;
      recording.subscription = recorder.addListener('recordingStatusUpdate', (status) => {
        if (status.hasError || status.mediaServicesDidReset) {
          if (!recording.error) {
            registrarDiag({ evento: 'dictation.recording_failed', nivel: 'erro',
              codigo: status.mediaServicesDidReset ? 'media_services_reset' : 'recording_error', detalhe: status.error ?? undefined });
            recording.error = new Error(m.composer_falha_gravacao());
          }
          recording.interrupted = true;
        }
        if (status.isFinished || recording.error) {
          complete(status);
          if (recording.phase === 'recording') {
            const atCeiling = recording.ceilingMs !== undefined && Date.now() - inicioRef.current >= recording.ceilingMs;
            void finishRecording(recording, atCeiling ? 'teto' : 'escondeu');
          }
        }
      });
      const styleStore = dictationStyleStore(server);
      await Promise.all([recorder.prepareToRecordAsync(), styleStore.getState().refreshCeiling()]);
      if (recording.interrupted) return;
      const ceilingMs = styleStore.getState().ceilingMs;
      recording.ceilingMs = ceilingMs;
      // O teto nativo continua valendo quando o sistema suspende os timers JS.
      recorder.record({ forDuration: ceilingMs / 1000 });
      if (recording.interrupted) return;
      recording.phase = 'recording';
      vadRef.current = novoEstadoVad();
      inicioRef.current = Date.now();
      setGravando(true);
      rms.value = 0;

      tetoRef.current = setTimeout(() => {
        void finishRecording(recording, 'teto');
      }, ceilingMs);

      intervaloRef.current = setInterval(() => {
        if (appStateRef.current !== 'active') return;
        const st = recorder.getStatus();
        const dB = (st as unknown as { metering?: number }).metering;
        let rmsVal = 0;
        let raw = 0;
        if (typeof dB === 'number' && Number.isFinite(dB)) {
          raw = Math.pow(10, dB / 20);
          if (!Number.isFinite(raw)) raw = 0;
          // para exibição, amplia como no front (*5) para a barra não ficar invisível
          rmsVal = Math.min(1, raw * 5);
          // VAD usa o raw (0..1), não o ampliado
          const r = passoVad(vadRef.current, raw, Date.now());
          if (r === 'encerra') {
            void finishRecording(recording, 'silencio');
            return;
          }
        } else {
          // sem metering (Android sem suporte ou falha) → VAD desligado, só botão/teto
          rmsVal = 0;
        }
        rms.value = rmsVal;
        if (Date.now() - inicioRef.current >= ceilingMs) {
          void finishRecording(recording, 'teto');
        }
      }, 55);
    } catch (e) {
      if (recording.error) reportRecordingError(recording, recording.error);
      else throw e;
    } finally {
      if (recording.phase === 'permission' || recording.phase === 'preparing') {
        try {
          if (recording.error) reportRecordingError(recording, recording.error);
        } finally {
          releaseRecording(recording);
        }
      }
    }
  }, [onFim, onErroParada, server, finishRecording, releaseRecording, rms]);

  useEffect(() => {
    mountedRef.current = true;
    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      const recording = recordingRef.current;
      if (!recording || recording.phase === 'permission') return;
      if (next !== 'active') {
        vadRef.current = novoEstadoVad();
        if (recording.phase !== 'recording' || !backgroundRecording()) void pararRef.current('escondeu');
      } else if (recording.phase === 'recording' && recording.recorder) {
        // Uma interrupção real do microfone não pode deixar a onda fingindo que ainda capta.
        try {
          if (recording.recorder.getStatus().isRecording === false) void pararRef.current('escondeu');
        } catch (error) {
          registrarDiag({ evento: 'dictation.recording_failed', nivel: 'erro', codigo: 'recording_status_failed' });
          recording.error = error instanceof Error ? error : new Error(m.composer_falha_gravacao());
          void pararRef.current('escondeu');
        }
      }
    });
    return () => {
      sub.remove();
      mountedRef.current = false;
      void pararRef.current('escondeu');
    };
  }, []);

  return { gravando, rms, iniciar, parar };
}
