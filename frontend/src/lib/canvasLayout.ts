// Posições iniciais dos cards do canvas livre (#/canvas). Puro (testável no vitest node): o
// componente Canvas passa o layout salvo + as linhas novas e recebe onde nasce cada card.
// Convenções: 1 coluna por servidor (ordem de serverOrder), card novo empilha abaixo do mais
// fundo que intersecta a coluna; pareados (mesmo gid) nascem consecutivos.
export interface CardBox { x: number; y: number; w: number; h: number }
export type CanvasLayout = Record<string, CardBox>;

export const CARD_W = 320;
// 380: altura padrão precisa mostrar conversa DE VERDADE (300 mal cabia header+sub+2 linhas+composer).
export const CARD_H = 380;
export const GAP = 16;
export const PAD = 24;

export const MIN_W = 240;
export const MIN_H = 160;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 1.5;

export interface CanvasPoint { x: number; y: number }
export interface CanvasConnection { from: CanvasPoint; to: CanvasPoint; path: string }

// Alvo de "soltar pra parear" no arrasto livre do canvas (Task 5): a faixa de CABEÇALHO (topo) de
// cada card, não o corpo inteiro — sobrepor o corpo continua sendo só mover. Vale também pro card
// de grupo recolhido (decisão mantida de propósito: ali o card compacto inteiro É o cabeçalho).
export const HEADER_HIT_H = 34;

export type CanvasDropTarget =
  | { kind: 'card'; key: string }
  | { kind: 'group'; gid: string; key: string };   // key = um membro representante (canPair/soltar)

/** Converte um ponto de TELA (clientX/Y) pra coordenada do PLANO do canvas (unidade pré-zoom,
 *  a mesma de CardBox) — ABSOLUTA, via o retângulo do container rolável + o scroll atual (não
 *  incremental como o delta que o próprio drag usa pra mover o tile). */
export function planePoint(
  clientX: number, clientY: number,
  rect: { left: number; top: number }, scrollLeft: number, scrollTop: number, zoom: number,
): CanvasPoint {
  return { x: (clientX - rect.left + scrollLeft) / zoom, y: (clientY - rect.top + scrollTop) / zoom };
}

/** Alvo de pareamento sob o ponto (px,py), ou null fora de qualquer cabeçalho. Varre `cards` e
 *  `groups` na ordem INVERSA da lista recebida (== ordem de renderização): cards e grupos
 *  recolhidos têm o mesmo z-index no Canvas, então quem foi desenhado por ÚLTIMO fica visualmente
 *  por CIMA — sem inverter, dois cabeçalhos sobrepostos pareavam com o card de BAIXO, que a pessoa
 *  nem está vendo. `cards` é sempre varrido antes de `groups`: o Canvas desenha os cards
 *  individuais DEPOIS dos compactos, então qualquer card individual já fica acima de qualquer
 *  grupo recolhido — não precisa intercalar as duas listas por posição de tela. */
export function findDropTarget(
  px: number, py: number, dragKey: string,
  cards: { key: string; box: CardBox }[],
  groups: { gid: string; key: string; box: CardBox }[],
): CanvasDropTarget | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const { key, box } = cards[i];
    if (key === dragKey) continue;
    if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + HEADER_HIT_H) {
      return { kind: 'card', key };
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    const { gid, key, box } = groups[i];
    if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + HEADER_HIT_H) {
      return { kind: 'group', gid, key };
    }
  }
  return null;
}

export function canvasBounds(boxes: CardBox[]): CardBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Curva sem direção entre as bordas mais próximas de dois cards. */
export function connectBoxes(a: CardBox, b: CardBox): CanvasConnection {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y)) {
    const forward = bc.x >= ac.x;
    const from = { x: forward ? a.x + a.w : a.x, y: ac.y };
    const to = { x: forward ? b.x : b.x + b.w, y: bc.y };
    const control = (from.x + to.x) / 2;
    return { from, to, path: `M ${from.x} ${from.y} C ${control} ${from.y}, ${control} ${to.y}, ${to.x} ${to.y}` };
  }
  const forward = bc.y >= ac.y;
  const from = { x: ac.x, y: forward ? a.y + a.h : a.y };
  const to = { x: bc.x, y: forward ? b.y : b.y + b.h };
  const control = (from.y + to.y) / 2;
  return { from, to, path: `M ${from.x} ${from.y} C ${from.x} ${control}, ${to.x} ${control}, ${to.x} ${to.y}` };
}

/** Escala que cabe o conteúdo inteiro, com folga, sem ampliar acima de 100%. */
export function fitCanvasScale(viewportW: number, viewportH: number, contentW: number, contentH: number): number {
  const scale = Math.min((viewportW - 40) / contentW, (viewportH - 40) / contentH, 1);
  return Math.max(MIN_SCALE, Math.round(scale * 100) / 100);
}

/** Nova caixa ao arrastar uma borda/canto (`dir` com n/s/e/w). O CSS `resize` nativo só dá o canto
 *  inferior-direito, então o canvas desenha as 8 alças e chama isto. Puxar a borda oeste/norte move
 *  x/y junto; clampa no mínimo do card E em x/y >= 0 (senão o card sai do plano rolável). */
export function resizeBox(box: CardBox, dir: string, dx: number, dy: number): CardBox {
  let { x, y, w, h } = box;
  if (dir.includes('e')) w = Math.max(MIN_W, box.w + dx);
  if (dir.includes('s')) h = Math.max(MIN_H, box.h + dy);
  if (dir.includes('w')) {
    w = Math.min(Math.max(MIN_W, box.w - dx), box.x + box.w);
    x = box.x + box.w - w;
  }
  if (dir.includes('n')) {
    h = Math.min(Math.max(MIN_H, box.h - dy), box.y + box.h);
    y = box.y + box.h - h;
  }
  return { x, y, w, h };
}

export function placeNew(
  layout: CanvasLayout,
  rows: { key: string; serverId: string; pairGid: string | null }[],
  serverOrder: string[],
): CanvasLayout {
  const fresh = rows.filter((r) => !layout[r.key]);
  if (fresh.length === 0) return {};

  // Pareados consecutivos: reordena por (servidor, gid na 1ª aparição), estável no resto.
  const gidOrder = new Map<string, number>();
  for (const r of fresh) if (r.pairGid && !gidOrder.has(r.pairGid)) gidOrder.set(r.pairGid, gidOrder.size);
  const ordered = [...fresh].sort((a, b) => {
    const sa = serverOrder.indexOf(a.serverId), sb = serverOrder.indexOf(b.serverId);
    if (sa !== sb) return sa - sb;
    const ga = a.pairGid ? gidOrder.get(a.pairGid)! : Number.MAX_SAFE_INTEGER;
    const gb = b.pairGid ? gidOrder.get(b.pairGid)! : Number.MAX_SAFE_INTEGER;
    return ga - gb;
  });

  const out: CanvasLayout = {};
  const colX = (serverId: string) => {
    const i = Math.max(0, serverOrder.indexOf(serverId));   // desconhecido -> coluna 0
    return PAD + i * (CARD_W + GAP);
  };
  // Fundo da coluna: maior y+h entre caixas (salvas OU recém-colocadas) que intersectam a faixa
  // [x, x+CARD_W). ponytail: varredura O(n) por card — layout tem dezenas de entradas, não milhares.
  const bottom = (x: number) => {
    let max = PAD - GAP;
    for (const box of [...Object.values(layout), ...Object.values(out)]) {
      if (box.x < x + CARD_W && box.x + box.w > x) max = Math.max(max, box.y + box.h);
    }
    return max;
  };
  for (const r of ordered) {
    const x = colX(r.serverId);
    out[r.key] = { x, y: bottom(x) + GAP, w: CARD_W, h: CARD_H };
  }
  return out;
}
