import { describe, expect, it } from 'vitest';
import {
  canvasBounds, connectBoxes, fitCanvasScale, placeNew, resizeBox, planePoint, findDropTarget,
  MIN_W, MIN_H, CARD_W, CARD_H, GAP, PAD, HEADER_HIT_H, type CanvasLayout,
} from './canvasLayout';

const row = (key: string, serverId: string, pairGid: string | null = null) => ({ key, serverId, pairGid });

describe('placeNew', () => {
  it('canvas vazio: primeiro card no PAD, servidor seguinte na coluna seguinte', () => {
    const out = placeNew({}, [row('a::x', 'a'), row('b::y', 'b')], ['a', 'b']);
    expect(out['a::x']).toEqual({ x: PAD, y: PAD, w: CARD_W, h: CARD_H });
    expect(out['b::y'].x).toBe(PAD + CARD_W + GAP);
    expect(out['b::y'].y).toBe(PAD);
  });

  it('empilha abaixo do card mais fundo que intersecta a coluna', () => {
    const existing: CanvasLayout = { 'a::x': { x: PAD, y: PAD, w: CARD_W, h: 400 } };
    const out = placeNew(existing, [row('a::z', 'a')], ['a']);
    expect(out['a::z'].y).toBe(PAD + 400 + GAP);
    expect(out['a::z'].x).toBe(PAD);
  });

  it('não devolve chaves que já têm posição', () => {
    const existing: CanvasLayout = { 'a::x': { x: 10, y: 10, w: 300, h: 200 } };
    expect(placeNew(existing, [row('a::x', 'a')], ['a'])).toEqual({});
  });

  it('pareados do mesmo servidor nascem consecutivos (mesmo com intrusos no meio)', () => {
    const out = placeNew({}, [row('a::p1', 'a', 'g1'), row('a::solo', 'a'), row('a::p2', 'a', 'g1')], ['a']);
    expect(out['a::p2'].y).toBe(out['a::p1'].y + CARD_H + GAP);      // p2 logo abaixo de p1
    expect(out['a::solo'].y).toBe(out['a::p2'].y + CARD_H + GAP);    // solo depois do grupo
  });

  it('card arrastado pra dentro da coluna conta pro fundo dela', () => {
    const existing: CanvasLayout = { 'x': { x: PAD + 50, y: 600, w: CARD_W, h: 100 } }; // sobrepõe a coluna 0
    const out = placeNew(existing, [row('a::n', 'a')], ['a']);
    expect(out['a::n'].y).toBe(600 + 100 + GAP);
  });

  it('servidor desconhecido em serverOrder cai na coluna 0 (defensivo)', () => {
    const out = placeNew({}, [row('z::n', 'z')], []);
    expect(out['z::n'].x).toBe(PAD);
  });

  it('adjacência exata (borda direita em PAD) não conta como interseção', () => {
    // Box à esquerda com x+w === PAD: encosta na coluna 0 mas não a sobrepõe -> não empurra o card novo.
    const existing: CanvasLayout = { 'x': { x: PAD - CARD_W, y: 600, w: CARD_W, h: 200 } };
    const out = placeNew(existing, [row('a::n', 'a')], ['a']);
    expect(out['a::n'].y).toBe(PAD);
  });

  it('coluna B cheia não muda o y de um card novo na coluna A', () => {
    const bx = PAD + CARD_W + GAP;   // x da coluna do servidor b
    const existing: CanvasLayout = { 'b::deep': { x: bx, y: 900, w: CARD_W, h: 300 } };
    const out = placeNew(existing, [row('a::n', 'a')], ['a', 'b']);
    expect(out['a::n'].x).toBe(PAD);
    expect(out['a::n'].y).toBe(PAD);
  });
});

describe('resizeBox', () => {
  const b = { x: 100, y: 100, w: 400, h: 300 };

  it('leste/sul só crescem w/h, x/y ficam', () => {
    expect(resizeBox(b, 'se', 50, 40)).toEqual({ x: 100, y: 100, w: 450, h: 340 });
  });

  it('oeste/norte movem x/y junto com o tamanho', () => {
    expect(resizeBox(b, 'nw', 60, 30)).toEqual({ x: 160, y: 130, w: 340, h: 270 });
  });

  it('clampa no mínimo sem deslocar a borda oposta', () => {
    const out = resizeBox(b, 'nw', 9999, 9999);
    expect(out.w).toBe(MIN_W);
    expect(out.h).toBe(MIN_H);
    expect(out.x + out.w).toBe(b.x + b.w);   // borda leste parada
    expect(out.y + out.h).toBe(b.y + b.h);   // borda sul parada
  });

  it('borda oeste/norte não passa de 0 (card sairia do plano)', () => {
    const out = resizeBox(b, 'nw', -9999, -9999);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.w).toBe(500);   // x0 + w0
    expect(out.h).toBe(400);
  });
});

describe('connectBoxes', () => {
  it('liga pelas bordas laterais quando os cards estão lado a lado', () => {
    const link = connectBoxes(
      { x: 20, y: 30, w: 200, h: 100 },
      { x: 320, y: 70, w: 180, h: 120 },
    );
    expect(link.from).toEqual({ x: 220, y: 80 });
    expect(link.to).toEqual({ x: 320, y: 130 });
    expect(link.path).toBe('M 220 80 C 270 80, 270 130, 320 130');
  });

  it('liga pelas bordas verticais quando um card fica abaixo do outro', () => {
    const link = connectBoxes(
      { x: 100, y: 40, w: 200, h: 120 },
      { x: 130, y: 300, w: 160, h: 100 },
    );
    expect(link.from).toEqual({ x: 200, y: 160 });
    expect(link.to).toEqual({ x: 210, y: 300 });
    expect(link.path).toBe('M 200 160 C 200 230, 210 230, 210 300');
  });
});

describe('fitCanvasScale', () => {
  it('reduz para caber nos dois eixos e nunca amplia acima de 100%', () => {
    expect(fitCanvasScale(1000, 700, 1200, 800)).toBe(0.8);
    expect(fitCanvasScale(1600, 1000, 900, 600)).toBe(1);
  });

  it('respeita o piso de 10%', () => {
    expect(fitCanvasScale(100, 80, 2000, 1400)).toBe(0.1);
  });
});

describe('canvasBounds', () => {
  it('mede só a área realmente ocupada pelos cards', () => {
    expect(canvasBounds([
      { x: 100, y: 300, w: 200, h: 100 },
      { x: 500, y: 200, w: 100, h: 250 },
    ])).toEqual({ x: 100, y: 200, w: 500, h: 250 });
  });
});

describe('planePoint', () => {
  it('sem zoom nem scroll: ponto de tela == ponto do plano, deslocado só pelo retângulo do container', () => {
    expect(planePoint(120, 80, { left: 20, top: 10 }, 0, 0, 1)).toEqual({ x: 100, y: 70 });
  });

  it('zoom reduzido amplia a distância em unidades de plano (1px de tela = 1/zoom de plano)', () => {
    expect(planePoint(100, 0, { left: 0, top: 0 }, 0, 0, 0.5)).toEqual({ x: 200, y: 0 });
  });

  it('scroll soma antes de dividir pelo zoom — rolar a página não desloca o alvo sob o cursor', () => {
    // clientX=100 seria x=100 sem rolar; com scrollLeft=300 o mesmo ponto de tela está 300px mais
    // adiante no plano (zoom 1: 100 + 300 = 400).
    expect(planePoint(100, 0, { left: 0, top: 0 }, 300, 0, 1)).toEqual({ x: 400, y: 0 });
  });
});

describe('findDropTarget', () => {
  const card = (key: string, x: number, y: number, w = 300, h = 200) => ({ key, box: { x, y, w, h } });

  it('ponto no cabeçalho (topo, < HEADER_HIT_H) pareia com o card', () => {
    const cards = [card('a', 0, 0), card('b', 400, 0)];
    expect(findDropTarget(410, HEADER_HIT_H - 1, 'a', cards, [])).toEqual({ kind: 'card', key: 'b' });
  });

  it('ponto no corpo (abaixo da faixa de cabeçalho) não pareia — só mover', () => {
    const cards = [card('a', 0, 0), card('b', 400, 0)];
    expect(findDropTarget(410, HEADER_HIT_H + 1, 'a', cards, [])).toBeNull();
  });

  it('o próprio card arrastado nunca é alvo de si mesmo', () => {
    const cards = [card('a', 0, 0)];
    expect(findDropTarget(10, 10, 'a', cards, [])).toBeNull();
  });

  it('card recolhido (grupo) também é alvo, pela mesma faixa de cabeçalho', () => {
    const groups = [{ gid: 'g1', key: 'a::líder', box: { x: 0, y: 0, w: 300, h: 100 } }];
    expect(findDropTarget(10, 10, 'x', [], groups)).toEqual({ kind: 'group', gid: 'g1', key: 'a::líder' });
  });

  it('dois cabeçalhos sobrepostos: vence o desenhado por ÚLTIMO (visualmente por cima) — o de baixo some do hit-test', () => {
    // Mesmo retângulo pros dois; 'baixo' é o primeiro da lista (renderizado antes, portanto sob os
    // demais no mesmo z-index), 'cima' é o último (renderizado depois, por cima na tela).
    const cards = [card('baixo', 0, 0), card('cima', 0, 0)];
    expect(findDropTarget(10, 10, 'x', cards, [])).toEqual({ kind: 'card', key: 'cima' });
  });

  it('card individual sempre vence grupo recolhido na mesma posição (cards são desenhados depois)', () => {
    const cards = [card('a', 0, 0)];
    const groups = [{ gid: 'g1', key: 'g::líder', box: { x: 0, y: 0, w: 300, h: 200 } }];
    expect(findDropTarget(10, 10, 'x', cards, groups)).toEqual({ kind: 'card', key: 'a' });
  });
});
