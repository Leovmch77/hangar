// Servidor que não responde é marcado como DESLIGADO e para de ser procurado. Volta a ser tentado
// quando a pessoa mandar — não sozinho, por relógio.
//
// A primeira versão disto tinha escala de espera (3 falhas, 1/2/5/15 min, retomada automática).
// Medido no iPhone em 16/09/2026: não bastou. No iOS o sistema descarrega e recarrega o PWA em
// segundo plano o tempo todo, e cada retomada zerava o contador em memória — o aparelho voltava a
// tentar três vezes por servidor, de novo e de novo. As tentativas caíram de 24/min para 7–15/min
// e nunca chegaram a zero.
//
// Por que zero importa: cada tentativa para máquina morta é uma conexão TCP pendurada até o prazo
// (VPN não recusa, engole), e no iPhone isso mora dentro da extensão de rede do Tailscale, que tem
// teto de 50 MB. Medida subindo de 35 para 45 MB enquanto a varredura corria; passando de certo
// ponto, o laço de rede da extensão para, a VPN "cai" e só religando volta.
//
// Daí as duas decisões: UMA falha de rede basta (não três), e não há retomada por tempo — some o
// relógio. E o estado é gravado, para o recarregamento do app não apagar o que já foi aprendido.

import { registrar as registrarDiag } from './diag';

const CHAVE = 'hangar_servidores_desligados';

type Estado = { desligado: boolean };

const estados = new Map<string, Estado>();
let carregado = false;
let avisouArmazem = false;
// Servidor que nunca pode ser marcado (o ativo, o que serve esta página): a regra mora AQUI, não
// em quem chama — `registrarFalha` também é chamado pelo apiFetch, e ali não há como saber.
let protegido: (id: string) => boolean = () => false;

/** Quem decide se um servidor é intocável (o app web registra o ativo e o dono da página). */
export function definirProtegido(fn: (id: string) => boolean): void {
  protegido = fn;
}

/** O pedaço de `Storage` que este módulo usa. O core não toca DOM: quem tem `localStorage` (o web)
 *  entrega por `definirArmazem`; no app nativo e nos testes o estado é só de memória. */
export interface ArmazemEsfriamento {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}
let armazemAtual: ArmazemEsfriamento | null = null;

export function definirArmazem(a: ArmazemEsfriamento | null): void {
  armazemAtual = a;
  carregado = false;   // armazém novo, estado gravado novo
  // Marca feita ANTES da injeção (só em memória) não pode se perder: funde com o que está
  // gravado e persiste — `registrarFalha` só grava na transição, não gravaria de novo.
  if ([...estados.values()].some((e) => e.desligado)) {
    carregar();
    gravar();
  }
}

function armazem(): ArmazemEsfriamento | null {
  return armazemAtual;
}

function carregar(): void {
  if (carregado) return;
  carregado = true;
  let bruto: string | null | undefined;
  try {
    bruto = armazem()?.getItem(CHAVE);
  } catch (e) {
    // Armazém que existe mas não responde (modo privado): é "sem armazém", não conteúdo inválido.
    avisarSemArmazem(e);
    return;
  }
  if (!bruto) return;
  try {
    const ids: unknown = JSON.parse(bruto);
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') estados.set(id, { desligado: true });
  } catch (e) {
    // Conteúdo estragado não pode impedir o app de subir: começa limpo — mas fica no diário,
    // senão "voltou a procurar todo mundo" não tem explicação.
    registrarDiag({ evento: 'esfriamento.estado_invalido', nivel: 'aviso', detalhe: e instanceof Error ? e.message : String(e) });
  }
}

function gravar(): void {
  const ids = [...estados.entries()].filter(([, e]) => e.desligado).map(([id]) => id);
  try {
    if (ids.length) armazem()?.setItem(CHAVE, JSON.stringify(ids));
    else armazem()?.removeItem(CHAVE);
  } catch (e) {
    // Cota cheia ou modo privado: o estado segue valendo em memória nesta sessão, e NÃO sobrevive
    // ao recarregamento — no iPhone é exatamente o caso que a feature existe pra cobrir. Uma vez
    // por sessão no diário, pra a volta das tentativas ter causa.
    avisarSemArmazem(e);
  }
}

/** Uma vez por sessão: o armazém está indisponível e a marca não sobrevive ao recarregamento. */
export function avisarSemArmazem(e: unknown): void {
  if (avisouArmazem) return;
  avisouArmazem = true;
  registrarDiag({ evento: 'esfriamento.sem_armazem', nivel: 'aviso', detalhe: e instanceof Error ? e.message : String(e) });
}

/** Este servidor está marcado como desligado (e portanto não deve ser procurado)? */
export function estaDesligado(id: string): boolean {
  carregar();
  return estados.get(id)?.desligado === true;
}

/** Falha de REDE (nenhuma resposta): marca como desligado na primeira vez. */
export function registrarFalha(id: string): void {
  carregar();
  if (protegido(id) || estados.get(id)?.desligado) return;
  estados.set(id, { desligado: true });
  gravar();
}

/** Respondeu: está de pé. */
export function registrarSucesso(id: string): void {
  carregar();
  if (!estados.delete(id)) return;
  gravar();
}

/** "Buscar agora": a pessoa mandou procurar. É o ÚNICO jeito de um servidor desligado voltar. */
export function retentarAgora(id?: string): void {
  carregar();
  if (id === undefined) estados.clear();
  else estados.delete(id);
  gravar();
}

/** Servidor saiu da lista: some com o estado dele. */
export function esquecerServidor(id: string): void {
  carregar();
  if (estados.delete(id)) gravar();
}

export function _limparEsfriamentoParaTestes(): void {
  estados.clear();
  carregado = false;
  try {
    armazem()?.removeItem(CHAVE);
  } catch {
    /* sem armazém nos testes de nó */
  }
}
