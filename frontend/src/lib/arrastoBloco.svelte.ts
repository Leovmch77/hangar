// Arrasto de um bloco do desktop até a borda de outro — o gesto do MonoCode (punho no cabeçalho,
// solta na borda do painel de destino). Borda lateral reordena; borda de cima/baixo empilha.
//
// Vive num store de módulo porque são DOIS lados: o punho (dentro do bloco) começa e conduz, e o
// shell desenha a marca no alvo. Passar isso por props atravessaria o Chat inteiro.

import { shellLayout, bordaDoPonto, type BlocoShell, type BordaSolta } from './shellLayout.svelte';

export type Alvo = { bloco: BlocoShell; borda: BordaSolta; rect: DOMRect };

export const arrasto = $state({
  /** Bloco sendo arrastado. `null` = ninguém arrastando. */
  bloco: null as BlocoShell | null,
  /** Onde ele cairia se soltasse agora. `null` = fora de qualquer bloco (soltar não faz nada). */
  alvo: null as Alvo | null,
});

function alvoDoPonto(x: number, y: number, arrastado: BlocoShell): Alvo | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-bloco]') as HTMLElement | null;
  const bloco = el?.dataset.bloco as BlocoShell | undefined;
  // Soltar em si mesmo não é movimento — sem marca, pra não prometer o que não acontece.
  if (!el || !bloco || bloco === arrastado) return null;
  const rect = el.getBoundingClientRect();
  return { bloco, borda: bordaDoPonto(x, y, rect), rect };
}

/** Chamado no `pointerdown` do punho. Cuida de tudo até o soltar. */
export function iniciarArrasto(bloco: BlocoShell, ev: PointerEvent): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const punho = ev.currentTarget as HTMLElement;
  // A captura mantém os eventos chegando com o ponteiro longe do punho; `elementFromPoint` não
  // depende dela, então o alvo continua sendo lido certo por baixo do cursor.
  try { punho.setPointerCapture(ev.pointerId); } catch { /* segue pelos eventos normais */ }
  arrasto.bloco = bloco;
  arrasto.alvo = null;

  const mover = (e: PointerEvent) => { arrasto.alvo = alvoDoPonto(e.clientX, e.clientY, bloco); };
  const soltar = (e: PointerEvent) => {
    const destino = alvoDoPonto(e.clientX, e.clientY, bloco);
    fim();
    if (destino) shellLayout.soltar(bloco, destino.bloco, destino.borda);
  };
  const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') fim(); };
  const fim = () => {
    arrasto.bloco = null;
    arrasto.alvo = null;
    window.removeEventListener('pointermove', mover);
    window.removeEventListener('pointerup', soltar);
    window.removeEventListener('pointercancel', fim);
    window.removeEventListener('keydown', tecla, true);
  };

  window.addEventListener('pointermove', mover);
  window.addEventListener('pointerup', soltar);
  window.addEventListener('pointercancel', fim);
  window.addEventListener('keydown', tecla, true);
}
