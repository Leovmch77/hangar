// Mic "morno" do app inteiro: o stream NAO e encerrado ao parar de gravar, so desabilitado
// (track.enabled=false -> silencio). No PWA do iPhone o WebKit volta a perguntar a permissao quando a
// captura para (bugs.webkit.org #215884); mantendo UMA captura viva por abertura do app, a pergunta e
// uma so — inclusive trocando de sessao, que desmonta o Composer. O iOS encerra a captura em segundo
// plano: ai `takeWarmMic` devolve undefined e a proxima gravacao pede de novo.
let warm: MediaStream | undefined;

/** Stream pronto pra gravar (tracks reabilitadas), ou undefined se nao ha / morreu. */
export function takeWarmMic(): MediaStream | undefined {
  const s = warm;
  warm = undefined;
  if (!s) return undefined;
  const vivas = s.getTracks().filter((t) => t.readyState === 'live');
  if (!vivas.length) return undefined;
  vivas.forEach((t) => { t.enabled = true; });
  return s;
}

/** Guarda o stream desabilitado pra proxima gravacao, em qualquer tela. */
export function keepWarmMic(s: MediaStream) {
  if (warm && warm !== s) stopWarmMic();
  s.getTracks().forEach((t) => { t.enabled = false; });
  warm = s;
}

export function stopWarmMic() {
  warm?.getTracks().forEach((t) => t.stop());
  warm = undefined;
}
