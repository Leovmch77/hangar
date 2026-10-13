// jev_roteiro — grava o objetivo que deu certo e o repete sem perguntar ao Jev a cada passo.
//
// Formato comum com o gravador do desktop (hangar-computer-control, crates/hcc-laco/src/roteiro.rs):
// mudou um lado, muda o outro e sobe `versao`. Nunca guarda ref @eN nem coordenada: cada passo é
// reencontrado na página por papel + nome (+ ordem entre gêmeos). Valor de `dados` vai pela CHAVE.

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jev = require('./jev_objetivo.cjs');

const VERSAO = 2;
const PASTA = path.join(os.homedir(), '.cache', 'hangar', 'roteiros');

const normal = (t) => String(t).split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** A resposta do navegador vem como `ok: "..."` ou crua. */
function limpar(saida) {
  const t = String(saida).replace(/^ok:\s*/, '').trim();
  if (!t.startsWith('"')) return t;
  try { return JSON.parse(t); } catch { return t; }
}

/**
 * Só o caminho: sem a query (a mesma tela com outro paciente é a mesma tela) e sem a origem (o
 * mesmo roteiro vale no localhost:3000 do dev e no :8116 da VM).
 */
function classeDe(url) {
  const t = limpar(url);
  try {
    const u = new URL(t);
    return u.origin === 'null' ? u.href.split(/[?#]/)[0] : u.pathname;
  } catch {
    return t.split(/[?#]/)[0];
  }
}

const slug = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'objetivo';

/** Mesma tela de partida, mesmo texto do objetivo e mesmas chaves de `dados`: os valores podem mudar. */
function arquivo(pasta, tela, objetivo, dados) {
  const semente = JSON.stringify([tela, normal(objetivo), Object.keys(dados ?? {}).sort()]);
  return path.join(pasta, `${slug(objetivo)}-${createHash('sha256').update(semente).digest('hex').slice(0, 8)}.json`);
}

/** `.hangar/roteiros` na raiz do git de `cwd`, para o roteiro ir junto com o projeto; fora de repo, o cache. */
function pastaDe(cwd) {
  try {
    const raiz = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (raiz) return path.join(raiz, '.hangar', 'roteiros');
  } catch { /* fora de repositório git */ }
  return PASTA;
}

/** null só quando ainda não há roteiro; qualquer outra coisa ilegível é erro que o resultado mostra. */
function carregar(arq) {
  let texto;
  try {
    texto = fs.readFileSync(arq, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const r = JSON.parse(texto);
  // A versão 1 tinha um caminho só: vira a única variante.
  if (r?.versao === 1 && Array.isArray(r.passos)) return { versao: VERSAO, objetivo: r.objetivo, variantes: [{ passos: r.passos, fim: r.fim ?? null }] };
  if (r?.versao !== VERSAO) throw new Error(`versão ${r?.versao} do formato, esperada ${VERSAO}`);
  if (!Array.isArray(r.variantes) || r.variantes.some((v) => !Array.isArray(v?.passos))) throw new Error('roteiro sem variantes');
  return r;
}

const MAX_VARIANTES = 5;
const sequencia = (v) => JSON.stringify(v.passos.map((p) => [p.janela?.classe, p.alvo, p.acao]));

/** A corrida que deu certo vai à frente; a variante de mesma sequência sai; ficam as 5 mais recentes. */
function juntar(antigas, nova) {
  return [nova, ...antigas.filter((v) => sequencia(v) !== sequencia(nova))].slice(0, MAX_VARIANTES);
}

function salvar(arq, roteiro) {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  // Escreve e renomeia: um salvamento interrompido nunca deixa meio roteiro.
  const tmp = `${arq}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(roteiro, null, 2));
  fs.renameSync(tmp, arq);
}

// O nome de campo sem rótulo carrega a ref ("campo de texto sem rotulo e4"): fora do arquivo.
const nomeDe = (c) => (jev.semRotulo(c.nome) ? '' : c.nome);
const chave = (papel, nome) => `${papel}\n${normal(jev.normalizar(nome))}`;
const candidatosDe = (snapshot) => jev.parsarSnapshot(snapshot, Infinity);
const assinatura = (cs) => cs.map((c) => chave(c.papel, nomeDe(c))).join('\n');

function elementoDe(candidatos, ref) {
  const c = candidatos.find((x) => x.ref === ref);
  if (!c) return null;
  const gemeos = candidatos.filter((x) => chave(x.papel, nomeDe(x)) === chave(c.papel, nomeDe(c)));
  return {
    elemento: {
      role: c.papel, name: nomeDe(c), text: null, placeholder: null, test_id: null,
      ordem: { indice: gemeos.indexOf(c), de: gemeos.length },
    },
  };
}

/** O elemento gravado na página de agora, ou null quando a contagem de gêmeos mudou. */
function relocalizar(candidatos, elemento, nome = elemento.name) {
  const gemeos = candidatos.filter((x) => chave(x.papel, nomeDe(x)) === chave(elemento.role, nome));
  if (gemeos.length !== elemento.ordem?.de) return null;
  return gemeos[elemento.ordem.indice] ?? null;
}

const ROTULO_DO_SELECT = /const rotulo = ("(?:[^"\\]|\\.)*");/;
const ehSelect = (verbo, args) => verbo === 'eval' && String(args[0]).includes(JSON.stringify(jev.SEM_SELECT));

/**
 * Envolve o `executar` e anota cada ação que deu certo, com o alvo tirado da última árvore lida.
 * O laço sempre age sobre a ref da leitura mais recente, então ela é a que identifica o alvo.
 */
function gravador(executar, dados) {
  const cofre = dados && typeof dados === 'object' ? dados : {};
  const passos = [];
  const pendentes = [];
  let candidatos = [];
  let classe = '';
  let problema = null;
  const titulos = new Map();
  const valorDe = (v) => {
    const k = Object.keys(cofre).find((x) => cofre[x] === v);
    return k === undefined ? { literal: v } : { dados: k };
  };
  // Opção de lista escolhida por ser igual a um valor de `dados`: na próxima vez o valor pode ser outro.
  const nomeVemDeDados = (nome) => {
    const k = Object.keys(cofre).find((x) => typeof cofre[x] === 'string' && normal(cofre[x]) === normal(nome));
    return k === undefined ? null : { dados: k };
  };
  const titulo = async () => {
    if (!titulos.has(classe)) titulos.set(classe, String(limpar(await executar('eval', ['document.title']))));
    return titulos.get(classe);
  };

  const embrulhado = async (verbo, args = []) => {
    const acao = ['click', 'fill', 'type', 'press'].includes(verbo) || ehSelect(verbo, args);
    const janela = acao ? { classe, titulo: await titulo() } : null;
    const antes = acao ? assinatura(candidatos) : null;
    const saida = await executar(verbo, args);
    const s = String(saida);
    if (s.startsWith('erro:')) return saida;
    if (verbo === 'url') classe = classeDe(s);
    if (verbo === 'snapshot') {
      candidatos = candidatosDe(s);
      const agora = assinatura(candidatos);
      for (const p of pendentes.splice(0)) p.passo.mudou_tela = p.antes !== agora;
    }
    if (!acao) return saida;
    let passo;
    if (verbo === 'click' || verbo === 'fill') {
      const alvo = elementoDe(candidatos, String(args[0]).replace(/^@/, ''));
      if (!alvo) problema = `alvo ${args[0]} fora da última leitura da página`;
      passo = {
        janela, alvo, acao: { op: verbo },
        valor: verbo === 'fill' ? valorDe(args[1]) : (alvo ? nomeVemDeDados(alvo.elemento.name) : null),
      };
    } else if (verbo === 'type') {
      passo = { janela, alvo: null, acao: { op: 'type' }, valor: valorDe(args[0]) };
    } else if (verbo === 'press') {
      passo = { janela, alvo: null, acao: { op: 'press', key: args[0] }, valor: null };
    } else {
      const m = String(args[0]).match(ROTULO_DO_SELECT);
      const nome = m ? JSON.parse(m[1]) : '';
      const c = candidatos.find((x) => x.papel === 'option' && x.nome === nome);
      const alvo = c ? elementoDe(candidatos, c.ref) : null;
      if (!alvo) problema = `opção "${nome}" fora da última leitura da página`;
      passo = { janela, alvo, acao: { op: 'select' }, valor: nomeVemDeDados(nome) };
    }
    passo.mudou_tela = null;
    passos.push(passo);
    pendentes.push({ passo, antes });
    return saida;
  };

  return {
    executar: embrulhado,
    classe: () => classe,
    candidatos: () => candidatos,
    /** A variante desta corrida, ou o motivo de não gravar. */
    variante() {
      if (problema) return { motivo: problema };
      if (!passos.length) return { motivo: 'nenhuma ação a gravar' };
      // Credencial nunca vai a disco: com chave secreta em `dados` ou campo de senha preenchido, nada é gravado.
      if (Object.keys(cofre).some((k) => jev.CHAVE_SECRETA.test(k))
        || passos.some((p) => p.valor && jev.CHAVE_SECRETA.test(p.alvo?.elemento?.name ?? ''))) {
        return { motivo: 'contém um valor secreto' };
      }
      // `fim` é só dado: em que tela o objetivo terminou. Sucesso continua exigindo a página confirmar.
      return { variante: { passos, fim: { classe, titulo: titulos.get(classe) ?? '' } } };
    },
  };
}

const FEITO = {
  click: (c) => `CLICK ${jev.rotulo(c)}`,
  fill: (c) => `TYPE_TEXT "${c.nome}"`,
  type: () => 'TYPE_TEXT',
  select: (c) => `SELECT "${c.nome}"`,
  press: (_, key) => (key === 'Enter' ? 'PRESS_ENTER' : key === 'PageDown' ? 'SCROLL_DOWN' : `PRESS ${key}`),
};

async function olhar(executar) {
  const [snap, url] = await Promise.all([executar('snapshot', jev.SNAPSHOT_DO_LACO), executar('url', [])]);
  for (const [v, s] of [['snapshot', snap], ['url', url]]) {
    if (String(s).startsWith('erro:')) return { erro: `o navegador falhou no ${v}: ${s}` };
  }
  return { candidatos: candidatosDe(snap), classe: classeDe(url) };
}

/** Primeira leitura: espera a página em branco carregar e duas leituras iguais seguidas. */
async function lerPaginaInicial(executar) {
  let vista = await olhar(executar);
  if (vista.erro) return vista;
  if (!vista.candidatos.length) {
    await executar('wait', ['--idle', '--timeout', '5000']);
    vista = await olhar(executar);
    if (vista.erro) return vista;
  }
  // Página recém-aberta ainda carregando: clicar antes dela assentar não faz nada, e a carga
  // muda a árvore como se o clique tivesse funcionado.
  for (let i = 0; i < 6; i += 1) {
    await executar('wait', ['400']);
    const outra = await olhar(executar);
    if (outra.erro) return outra;
    const igual = assinatura(outra.candidatos) === assinatura(vista.candidatos);
    vista = outra;
    if (igual) break;
  }
  return vista;
}

/** Valor e elemento do passo nesta página, sem ler de novo; `motivo` quando não resolve. */
function resolver(p, vista, cofre) {
  if (vista.classe !== p.janela?.classe) return { motivo: `página ${vista.classe}, gravada ${p.janela?.classe}` };
  let valor = null;
  if (p.valor?.dados !== undefined) {
    valor = cofre[p.valor.dados];
    if (typeof valor !== 'string') return { motivo: `dados.${p.valor.dados} não veio` };
  } else if (p.valor?.literal !== undefined) valor = String(p.valor.literal);
  if (p.alvo && !p.alvo.elemento) return { motivo: 'alvo de janela não existe no navegador' };
  if (!p.alvo) return { alvo: null, valor };
  // Clique em opção escolhida pelo valor de `dados`: procura a opção do valor DESTA vez.
  const nome = p.acao?.op !== 'fill' && p.valor?.dados !== undefined ? valor : p.alvo.elemento.name;
  const alvo = relocalizar(vista.candidatos, p.alvo.elemento, nome);
  if (!alvo) {
    const { role, ordem } = p.alvo.elemento;
    return { motivo: `${role} "${nome}" (${ordem?.indice + 1} de ${ordem?.de}) não está na página do mesmo jeito` };
  }
  return { alvo, valor };
}

/**
 * Repete os passos enquanto a página bate com a gravada; para na primeira divergência. O passo 1
 * usa `vista`, a leitura que escolheu esta variante.
 */
async function repetir({ passos, executar, dados, log, vista: primeira }) {
  const cofre = dados && typeof dados === 'object' ? dados : {};
  const feito = [];
  let antes = null;
  for (const [n, p] of passos.entries()) {
    const parar = (motivo) => ({ feito, repetidos: n, parou: `parou no passo ${n + 1}: ${motivo}` });
    let vista = n === 0 && primeira ? primeira : await olhar(executar);
    if (vista.erro) return parar(vista.erro);
    // O passo anterior mudou a tela na gravação: espera um pouco pela mudança antes de chamar de divergência.
    if (n > 0 && passos[n - 1].mudou_tela === true) {
      for (let i = 0; i < 4 && assinatura(vista.candidatos) === antes; i += 1) {
        await executar('wait', ['500']);
        vista = await olhar(executar);
        if (vista.erro) return parar(vista.erro);
      }
      if (assinatura(vista.candidatos) === antes) return parar('a tela não mudou depois do passo anterior');
    }
    let r = resolver(p, vista, cofre);
    // Diálogo ou lista que ainda está chegando: olha de novo antes de chamar de divergência.
    for (let i = 0; i < 4 && r.motivo && p.alvo?.elemento && vista.classe === p.janela?.classe; i += 1) {
      await executar('wait', ['500']);
      vista = await olhar(executar);
      if (vista.erro) return parar(vista.erro);
      r = resolver(p, vista, cofre);
    }
    if (r.motivo) return parar(r.motivo);
    const { alvo, valor } = r;
    const op = p.acao?.op;
    const args = {
      click: () => ['click', [`@${alvo?.ref}`]],
      fill: () => ['fill', [`@${alvo?.ref}`, valor]],
      type: () => ['type', [valor]],
      press: () => ['press', [p.acao.key]],
      select: () => ['eval', [jev.jsDeSelecionar(alvo?.nome)]],
    }[op];
    if (!args || (['click', 'fill', 'select'].includes(op) && !alvo) || (['fill', 'type'].includes(op) && valor === null)) {
      return parar(`ação ${JSON.stringify(p.acao)} sem o que precisa`);
    }
    antes = assinatura(vista.candidatos);
    const [verbo, a] = args();
    const saida = String(await executar(verbo, a));
    // No <select> nativo ausente, o clique gravado logo depois escolhe na listbox ARIA.
    if (saida.startsWith('erro:') || (op === 'select' && saida.includes('erro:'))) return parar(`${verbo} falhou: ${saida.slice(0, 200)}`);
    feito.push(FEITO[op](alvo, p.acao.key));
    log(`jev-objetivo roteiro ${n + 1}/${passos.length}: ${feito.at(-1)}`);
    if (op === 'type') await executar('eval', [jev.JS_ESPERAR_OPCOES]);
    await executar('wait', jev.ESPERA_ASSENTAR);
  }
  return { feito, repetidos: passos.length, parou: null };
}

/**
 * O `rodar` com roteiro: escolhe a primeira variante cujo passo 1 casa com a página, repete sem
 * perguntar ao Jev e, na divergência, o Jev continua da página de agora — nunca outra variante
 * depois de uma ter agido. Toda corrida que dá certo vira a variante 0. `jev` conta por fase.
 */
async function rodarComRoteiro({ objetivo, dados, perguntar, executar, refazer = false, pasta = PASTA, log = () => {}, ...resto }) {
  const jevConta = { acoes: 0, verificacao: 0 };
  let fase = 'acoes';
  const contado = async (estado, perguntas) => { jevConta[fase] += 1; return perguntar(estado, perguntas); };
  const cofre = dados && typeof dados === 'object' ? dados : {};
  const g = gravador(executar, cofre);
  const arq = arquivo(pasta, classeDe(await g.executar('url', [])), objetivo, cofre);
  const avisos = [];
  let gravado = null;
  try {
    gravado = carregar(arq);
  } catch (err) {
    avisos.push(`roteiro ilegível, seguindo pelo Jev: ${String(err?.message ?? err).slice(0, 200)}`);
    log(`jev-objetivo: ${avisos.at(-1)}`);
  }
  const fechar = (resultado) => {
    if (resultado.sucesso) {
      const { variante, motivo } = g.variante();
      if (variante) {
        try {
          salvar(arq, { versao: VERSAO, objetivo, variantes: juntar(gravado?.variantes ?? [], variante) });
          avisos.push(`gravado em ${arq}`);
        } catch (err) {
          avisos.push(`não gravado: ${err.message}`);
        }
      } else avisos.push(`não gravado: ${motivo}`);
    }
    return { ...resultado, roteiro: avisos.join('; ') || null, jev: jevConta };
  };
  let feito = [];
  if (gravado && !refazer) {
    const vista = await lerPaginaInicial(g.executar);
    const i = vista.erro ? -1 : gravado.variantes.findIndex((v) => v.passos.length && !resolver(v.passos[0], vista, cofre).motivo);
    if (i < 0) {
      avisos.push(`nenhuma das ${gravado.variantes.length} variantes casa com a página${vista.erro ? ` (${vista.erro})` : ''}; o Jev segue`);
      log(`jev-objetivo: ${avisos.at(-1)}`);
    } else {
      const { passos } = gravado.variantes[i];
      const r = await repetir({ passos, executar: g.executar, dados: cofre, log, vista });
      feito = r.feito;
      avisos.push(`variante ${i + 1} de ${gravado.variantes.length}: repetidos ${r.repetidos} de ${passos.length} passos${r.parou ? `; ${r.parou}` : ''}`);
      if (r.parou) log(`jev-objetivo: ${avisos.at(-1)}; o Jev segue daqui`);
      else {
        // Sempre a pergunta de conclusão: a página final igual à gravada não prova que salvou
        // (formulário em diálogo fica no mesmo endereço).
        const url = await g.executar('url', []);
        fase = 'verificacao';
        const texto = await g.executar('text', []);
        const { concluido } = await contado(jev.montarEstado(objetivo, url, feito, texto, {}, cofre), { concluido: jev.montarPerguntas([]).concluido });
        const prova = typeof concluido?.noul === 'number' ? concluido.noul : 0;
        fase = 'acoes';
        if (prova >= jev.LIMIARES.conclusao) {
          return fechar({ feito, sucesso: true, parou: `roteiro repetido; página confirma (${prova.toFixed(2)})` });
        }
        avisos.push(`a página não confirmou o fim (${prova.toFixed(2)}); o Jev segue`);
      }
    }
  }
  return fechar(await jev.rodar({ ...resto, objetivo, dados, log, perguntar: contado, executar: g.executar, feitoInicial: feito }));
}

module.exports = { rodarComRoteiro, gravador, repetir, relocalizar, elementoDe, arquivo, pastaDe, carregar, salvar, juntar, classeDe, VERSAO, MAX_VARIANTES, PASTA };
