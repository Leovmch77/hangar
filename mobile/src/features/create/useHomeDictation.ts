import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeDictationForServer } from '@hangar/core';
import type { Server } from '@hangar/core';
import { useDitado } from '../ditado/useDitado';
import { useDitadoEstiloStore } from '../ditado/ditadoEstiloStore';
import * as m from '../../paraglide/messages';

// Ditado antes de a sessão existir: o servidor só transcreve e limpa (rota sem sessão), e o texto
// entra no campo. Falhou, o áudio fica na memória para "transcrever de novo".
export function useHomeDictation(server: Server, onText: (text: string) => void) {
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<File | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const estilo = useRef<string | undefined>(undefined);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const transcribe = useCallback(async (file: File) => {
    if (busy.current) return;
    busy.current = true;
    setTranscribing(true);
    setError('');
    setFailed(null);
    try {
      const { text, aviso } = await transcribeDictationForServer(server, file, estilo.current);
      const trimmed = text.trim();
      if (!trimmed) throw new Error(m.composer_transcricao_vazia());
      if (!mounted.current) return;
      onTextRef.current(trimmed);
      // A limpeza pode desistir e devolver o cru: isso aparece, não passa por limpo.
      if (aviso) setError(aviso);
    } catch (e) {
      if (!mounted.current) return;
      const detail = e instanceof Error ? e.message : m.composer_falha_transcricao();
      setError(/^(501|503):/.test(detail) ? `${m.composer_ditado_indisponivel()}: ${detail}` : detail);
      setFailed(file);
    } finally {
      busy.current = false;
      if (mounted.current) setTranscribing(false);
    }
  }, [server]);

  // Cancelar para o microfone e joga o áudio fora, sem transcrever nem guardar para "de novo".
  const discard = useRef(false);
  const { gravando, rms, iniciar, parar } = useDitado({
    onFim: (file) => {
      if (discard.current) { discard.current = false; return; }
      void transcribe(file);
    },
    onErroParada: (e) => {
      if (mounted.current) setError(e.message === 'ditado_parada_falhou' ? m.composer_falha_gravacao() : e.message || m.composer_falha_gravacao());
    },
  });

  const toggle = useCallback(async () => {
    if (busy.current) return;
    if (gravando) { void parar('botao'); return; }
    setError('');
    setFailed(null);
    discard.current = false;
    // O estilo que a pílula mostra na hora de falar é o que o servidor aplica.
    const style = useDitadoEstiloStore.getState();
    estilo.current = style.pronto ? style.valor : undefined;
    try {
      await iniciar();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setError(msg === 'permission_denied' ? m.composer_sem_acesso_mic() : msg || m.composer_falha_gravacao());
    }
  }, [gravando, iniciar, parar]);

  const retry = useCallback(() => { if (failed) void transcribe(failed); }, [failed, transcribe]);
  const dismiss = useCallback(() => { setError(''); setFailed(null); }, []);
  // Enviar ou trocar de máquina no meio da gravação não pode deixar o microfone aberto.
  const stop = useCallback(() => parar('botao'), [parar]);
  const cancel = useCallback(() => {
    discard.current = true;
    void parar('botao');
  }, [parar]);

  return { gravando, rms, transcribing, error, canRetry: !!failed, toggle, retry, dismiss, stop, cancel };
}
