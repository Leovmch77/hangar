// Layout teclado-safe: a tela acompanha a ALTURA da viewport visível. Com o teclado aberto, vv.height
// encolhe e o container encolhe junto, deixando o composer colado no topo do teclado. O pan do iOS
// (offsetTop) é bugado, então a tela ancora em top=0 e zera o scroll da janela. Sem `transform`: ele
// promove camada que renderiza preto e prende os sheets fixed. Devolve a função de limpeza.
export function fitKeyboard(el: HTMLElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  function fit() {
    if (!vv) return;
    // A animação do teclado reporta alturas minúsculas por 1 quadro.
    if (vv.height < 120) return;
    const h = vv.height + 'px';
    // Só rola se houver scroll real: scrollTo a cada tecla dispara o "Desfazer" (shake-to-undo) do iOS.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    if (el.style.height !== h) el.style.height = h;
    if (el.style.top !== '0px') el.style.top = '0px';
    if (el.style.transform) el.style.transform = '';
    // Teclado aberto: zera a safe-area de baixo (home indicator) que deixava um vão.
    if (vv.height < window.innerHeight - 100) el.style.setProperty('--composer-pb', 'var(--space-2)');
    else el.style.removeProperty('--composer-pb');
  }
  function onFocusIn() {
    requestAnimationFrame(fit);
    setTimeout(fit, 300); // o iOS às vezes só estabiliza após a animação do teclado
  }
  // O iOS nem sempre zera offsetTop/height ao fechar o teclado: sem campo focado, volta ao estado limpo.
  function onFocusOut() {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
      el.style.top = '0px';
      el.style.height = '';
      el.style.transform = '';
    }, 50);
  }
  fit();
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  el.addEventListener('focusin', onFocusIn);
  el.addEventListener('focusout', onFocusOut);
  return () => {
    vv.removeEventListener('resize', fit);
    vv.removeEventListener('scroll', fit);
    el.removeEventListener('focusin', onFocusIn);
    el.removeEventListener('focusout', onFocusOut);
  };
}

// Action Svelte: `use:keyboardInset`.
export function keyboardInset(el: HTMLElement) {
  const off = fitKeyboard(el);
  return { destroy: off };
}
