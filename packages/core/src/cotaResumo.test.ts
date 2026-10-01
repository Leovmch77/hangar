import { describe, it, expect } from 'vitest';
import { contaComFolga, cotaDaConta, resumoCota, type CotaContaResumo } from './cotaResumo';

describe('contaComFolga', () => {
  const cota = (path: string, janelas: CotaContaResumo['janelas'], estado: CotaContaResumo['estado'] = 'lida'): CotaContaResumo =>
    ({ id: `claude:${path}`, estado, janelas });
  const now = 1000;
  const cheia = [{ rotulo: '5h', pct: 100, reset_ts: 2000 }];
  it('esgotada vai para a de mais folga, contando todas as janelas; sem leitura não entra', () => {
    const cotas = [cota('/a', cheia), cota('/b', [{ rotulo: '5h', pct: 70 }, { rotulo: '7d', pct: 10 }]),
      cota('/c', [{ rotulo: '5h', pct: 20 }, { rotulo: '7d opus', pct: 40, por_modelo: true }])];
    expect(contaComFolga('/a', [{ path: '/a', active: true }, { path: '/b' }, { path: '/c' }, { path: '/d' }], cotas, now)).toBe('/c');
  });
  it('fica onde está: janela por modelo cheia, reset já passado, nenhuma serve ou sem conta', () => {
    const livre = cota('/c', [{ rotulo: '5h', pct: 20 }]);
    expect(contaComFolga('/a', [{ path: '/a' }, { path: '/c' }], [cota('/a', [{ rotulo: '7d opus', pct: 100, por_modelo: true }]), livre], now)).toBeNull();
    expect(contaComFolga('/a', [{ path: '/a' }, { path: '/c' }], [cota('/a', [{ rotulo: '5h', pct: 100, reset_ts: 900 }]), livre], now)).toBeNull();
    expect(contaComFolga('/a', [{ path: '/a' }, { path: '/b' }], [cota('/a', cheia), cota('/b', cheia)], now)).toBeNull();
    expect(contaComFolga(null, [{ path: '/a' }, { path: '/c' }], [cota('/a', cheia), livre], now)).toBeNull();
  });
  it('empate fica com a ativa, em qualquer ordem', () => {
    const cotas = [cota('/a', cheia), cota('/c', [{ rotulo: '5h', pct: 20 }]), cota('/e', [{ rotulo: '5h', pct: 20 }])];
    expect(contaComFolga('/a', [{ path: '/a' }, { path: '/c', active: true }, { path: '/e' }], cotas, now)).toBe('/c');
    expect(contaComFolga('/a', [{ path: '/a' }, { path: '/e' }, { path: '/c', active: true }], cotas, now)).toBe('/c');
  });
});

const lida: CotaContaResumo = {
  id: 'claude:/home/x/.claude',
  estado: 'lida',
  janelas: [{ rotulo: '5h', pct: 42.4 }, { rotulo: '7d', pct: 17.6 }, { rotulo: 'Fable', pct: 100, por_modelo: true }],
};

describe('cotaDaConta', () => {
  it('casa pelo config dir com o prefixo claude:', () => {
    expect(cotaDaConta([lida], '/home/x/.claude')).toBe(lida);
    expect(cotaDaConta([lida], '/home/x/.claude-b')).toBeUndefined();
  });
});

describe('resumoCota', () => {
  it('uma janela por trecho, arredondada', () => {
    expect(resumoCota(lida)).toBe('5h 42% · 7d 18% · Fable 100%');
  });
  it('vazio sem leitura, sem conta ou sem janela', () => {
    expect(resumoCota(undefined)).toBe('');
    expect(resumoCota({ ...lida, estado: 'expirada' })).toBe('');
    expect(resumoCota({ ...lida, janelas: [] })).toBe('');
    expect(resumoCota({ ...lida, janelas: [{ rotulo: '5h', pct: NaN }] })).toBe('');
  });
});
