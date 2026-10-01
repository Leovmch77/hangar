interface ComGlass {
  tokens: { glass: { rgb: readonly number[] } };
  panelAlpha: number;
  surfaceAlpha: number;
}

// Caixa DENTRO de um painel (card, bolha, chip, campo). Nunca `bg.elevated`/`bg.base` cru: cor
// chapada não acompanha o slider de Solidez e vira retângulo opaco boiando sobre o papel de parede.
// k é o degrau: 0.6 no lugar do antigo `bg.surface`, 0.8 no lugar do `bg.elevated`.
// A Solidez INTERPOLA entre o vidro do painel (0) e sólido (1), como na PWA: multiplicar direto
// fazia a caixa sumir por inteiro no 0 e o texto boiar solto sobre a foto.
export const superficie = (t: ComGlass, k = 0.6) =>
  `rgba(${t.tokens.glass.rgb.join(',')},${k * (t.panelAlpha + (1 - t.panelAlpha) * t.surfaceAlpha)})`;

// O slider Transparência guarda a OPACIDADE do vidro (0.3 a 1), mas mostra o contrário: 0 = vidro
// opaco, 1 = o máximo de foto que ainda deixa ler.
export const transparenciaDe = (panelAlpha: number) => Math.max(0, Math.min(1, (1 - panelAlpha) / 0.7));
export const opacidadeDe = (transparencia: number) => 1 - 0.7 * Math.max(0, Math.min(1, transparencia));
