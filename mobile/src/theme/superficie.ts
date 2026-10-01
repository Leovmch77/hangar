interface ComGlass {
  tokens: { glass: { rgb: readonly number[] } };
  surfaceAlpha: number;
}

// Sem painel em volta (as caixas ficam direto sobre o fundo), a Solidez tem faixa própria: do piso
// até sólido. Partir do vidro do painel deixava o slider mexer só ~14% e parecer quebrado; partir de
// zero fazia a caixa sumir e o texto boiar solto sobre a foto.
const PISO_SOLIDEZ = 0.25;
export const solidezDe = (surfaceAlpha: number) => PISO_SOLIDEZ + (1 - PISO_SOLIDEZ) * Math.max(0, Math.min(1, surfaceAlpha));

// Caixa DENTRO de um painel (card, bolha, chip, campo). Nunca `bg.elevated`/`bg.base` cru: cor
// chapada não acompanha o slider de Solidez e vira retângulo opaco boiando sobre o papel de parede.
// k é o degrau: 0.6 no lugar do antigo `bg.surface`, 0.8 no lugar do `bg.elevated`.
export const superficie = (t: ComGlass, k = 0.6) =>
  `rgba(${t.tokens.glass.rgb.join(',')},${k * solidezDe(t.surfaceAlpha)})`;

// O slider Transparência guarda a OPACIDADE do vidro (0.3 a 1), mas mostra o contrário: 0 = vidro
// opaco, 1 = o máximo de foto que ainda deixa ler.
export const transparenciaDe = (panelAlpha: number) => Math.max(0, Math.min(1, (1 - panelAlpha) / 0.7));
export const opacidadeDe = (transparencia: number) => 1 - 0.7 * Math.max(0, Math.min(1, transparencia));
