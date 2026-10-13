// jev_roteiro — grava o objetivo que deu certo e o repete sem perguntar ao Jev a cada passo.
//
// Formato comum com o gravador do desktop (hangar-computer-control, crates/hcc-laco/src/roteiro.rs):
// mudou um lado, muda o outro e sobe `versao`. Nunca guarda ref @eN nem coordenada: cada passo é
// reencontrado na página por papel + nome (+ ordem entre gêmeos). Valor de `dados` vai pela CHAVE.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jev = require('./jev_objetivo.cjs');

const VERSAO = 1;
const PASTA = path.join(os.homedir(), '.cache', 'hangar', 'roteiros');

const normal = (t) => String(t).split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** A resposta do navegador vem como `ok: "..."` ou crua. */
function limpar(saida) {
  const t = String(saida).replace(/^ok:\s*/, '').trim();
  if (!t.startsWith('"')) return t;
  try { return JSON.parse(t); } catch { return t; }
}

/** Origem + caminho, sem a query: a mesma tela com outro paciente na URL é a mesma tela. */
function classeDe(url) {
  const t = limpar(url);
  try {
    const u = new URL(t);
    return u.origin === 'null' ? u.href.split(/[?#]/)[0] : u.origin + u.pathname;
  } catch {
    return t.split(/[?#]/)[0];
  }
}

function origemDe(url) {
  try { return new URL(limpar(url)).origin; } catch { return limpar(url); }
}

/** Mesmo site, mesmo texto do objetivo e mesmas chaves de `dados`: os valores podem mudar. */
function arquivo(pasta, origem, objetivo, dados) {
  const semente = JSON.stringify([origem, normal(objetivo), Object.keys(dados ?? {}).sort()]);
  return path.join(pasta, `${createHash('sha256').update(semente).digest('hex').slice(0, 16)}.json`);
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
  if (r?.versao !== VERSAO) throw new Error(`versão ${r?.versao} do formato, esperada ${VERSAO}`);
  if (!Array.isArray(r.passos)) throw new Error('roteiro sem passos');
  return r;
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
    /** O roteiro, ou o motivo de não gravar. */
    roteiro(objetivo) {
      if (problema) return { motivo: problema };
      if (!passos.length) return { motivo: 'nenhuma ação a gravar' };
      // Credencial nunca vai a disco: com chave secreta em `dados` ou campo de senha preenchido, nada é gravado.
      if (Object.keys(cofre).some((k) => jev.CHAVE_SECRETA.test(k))
        || passos.some((p) => p.valor && jev.CHAVE_SECRETA.test(p.alvo?.elemento?.name ?? ''))) {
        return { motivo: 'contém um valor secreto' };
      }
      // `fim` fica fora do formato do desktop (ele ignora): diz em que tela o objetivo terminou.
      return { roteiro: { versao: VERSAO, objetivo, passos, fim: { classe, titulo: titulos.get(classe) ?? '' } } };
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

/** Repete os passos enquanto a página bate com a gravada; para na primeira divergência. */
async function repetir({ roteiro, executar, dados, log }) {
  const cofre = dados && typeof dados === 'object' ? dados : {};
  const feito = [];
  let antes = null;
  for (const [n, p] of roteiro.passos.entries()) {
    const parar = (motivo) => ({ feito, repetidos: n, parou: `parou no passo ${n + 1}: ${motivo}` });
    let vista = await olhar(executar);
    if (vista.erro) return parar(vista.erro);
    if (!vista.candidatos.length) {
      await executar('wait', ['--idle', '--timeout', '5000']);
      vista = await olhar(executar);
      if (vista.erro) return parar(vista.erro);
    }
    // Página recém-aberta ainda carregando: clicar antes dela assentar não faz nada, e a carga
    // muda a árvore como se o clique tivesse funcionado. Espera duas leituras iguais seguidas.
    for (let i = 0; n === 0 && i < 6; i += 1) {
      await executar('wait', ['400']);
      const outra = await olhar(executar);
      if (outra.erro) return parar(outra.erro);
      const igual = assinatura(outra.candidatos) === assinatura(vista.candidatos);
      vista = outra;
      if (igual) break;
    }
    // O passo anterior mudou a tela na gravação: espera um pouco pela mudança antes de chamar de divergência.
    if (n > 0 && roteiro.passos[n - 1].mudou_tela === true) {
      for (let i = 0; i < 4 && assinatura(vista.candidatos) === antes; i += 1) {
        await executar('wait', ['500']);
        vista = await olhar(executar);
        if (vista.erro) return parar(vista.erro);
      }
      if (assinatura(vista.candidatos) === antes) return parar('a tela não mudou depois do passo anterior');
    }
    if (vista.classe !== p.janela?.classe) return parar(`página ${vista.classe}, gravada ${p.janela?.classe}`);
    let valor = null;
    if (p.valor?.dados !== undefined) {
      valor = cofre[p.valor.dados];
      if (typeof valor !== 'string') return parar(`dados.${p.valor.dados} não veio`);
    } else if (p.valor?.literal !== undefined) valor = String(p.valor.literal);
    let alvo = null;
    if (p.alvo?.elemento) {
      // Clique em opção escolhida pelo valor de `dados`: procura a opção do valor DESTA vez.
      const nome = p.acao?.op !== 'fill' && p.valor?.dados !== undefined ? valor : p.alvo.elemento.name;
      alvo = relocalizar(vista.candidatos, p.alvo.elemento, nome);
      // Diálogo ou lista que ainda está chegando: olha de novo antes de chamar de divergência.
      for (let i = 0; i < 4 && !alvo; i += 1) {
        await executar('wait', ['500']);
        vista = await olhar(executar);
        if (vista.erro) return parar(vista.erro);
        alvo = relocalizar(vista.candidatos, p.alvo.elemento, nome);
      }
      if (!alvo) return parar(`${p.alvo.elemento.role} "${nome}" (${p.alvo.elemento.ordem?.indice + 1} de ${p.alvo.elemento.ordem?.de}) não está na página do mesmo jeito`);
    } else if (p.alvo) return parar('alvo de janela não existe no navegador');
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
    log(`jev-objetivo roteiro ${n + 1}/${roteiro.passos.length}: ${feito.at(-1)}`);
    if (op === 'type') await executar('eval', [jev.JS_ESPERAR_OPCOES]);
    await executar('wait', jev.ESPERA_ASSENTAR);
  }
  return { feito, repetidos: roteiro.passos.length, parou: null };
}

/**
 * O `rodar` com roteiro: repete o gravado sem perguntar ao Jev e, na divergência, o Jev continua da
 * página de agora. Sucesso pelo Jev regrava. `jev` conta as perguntas por fase.
 */
async function rodarComRoteiro({ objetivo, dados, perguntar, executar, refazer = false, pasta = PASTA, log = () => {}, ...resto }) {
  const jevConta = { acoes: 0, verificacao: 0 };
  let fase = 'acoes';
  const contado = async (estado, perguntas) => { jevConta[fase] += 1; return perguntar(estado, perguntas); };
  const cofre = dados && typeof dados === 'object' ? dados : {};
  const g = gravador(executar, cofre);
  const arq = arquivo(pasta, origemDe(await g.executar('url', [])), objetivo, cofre);
  const avisos = [];
  let gravado = null;
  if (!refazer) {
    try {
      gravado = carregar(arq);
    } catch (err) {
      avisos.push(`roteiro ilegível, seguindo pelo Jev: ${String(err?.message ?? err).slice(0, 200)}`);
      log(`jev-objetivo: ${avisos.at(-1)}`);
    }
  }
  let feito = [];
  if (gravado) {
    const r = await repetir({ roteiro: gravado, executar: g.executar, dados: cofre, log });
    feito = r.feito;
    avisos.push(`repetidos ${r.repetidos} de ${gravado.passos.length} passos${r.parou ? `; ${r.parou}` : ''}`);
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
        return { feito, sucesso: true, parou: `roteiro repetido; página confirma (${prova.toFixed(2)})`, roteiro: avisos.join('; '), jev: jevConta };
      }
      avisos.push(`a página não confirmou o fim (${prova.toFixed(2)}); o Jev segue`);
    }
  }
  const resultado = await jev.rodar({ ...resto, objetivo, dados, log, perguntar: contado, executar: g.executar, feitoInicial: feito });
  if (resultado.sucesso) {
    const { roteiro, motivo } = g.roteiro(objetivo);
    if (roteiro) {
      try {
        salvar(arq, roteiro);
        avisos.push(`gravado em ${arq}`);
      } catch (err) {
        avisos.push(`não gravado: ${err.message}`);
      }
    } else avisos.push(`não gravado: ${motivo}`);
  }
  return { ...resultado, roteiro: avisos.join('; ') || null, jev: jevConta };
}

module.exports = { rodarComRoteiro, gravador, repetir, relocalizar, elementoDe, arquivo, carregar, salvar, classeDe, VERSAO, PASTA };
