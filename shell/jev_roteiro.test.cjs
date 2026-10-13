const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rodarComRoteiro, relocalizar, elementoDe, arquivo } = require('./jev_roteiro.cjs');
const { parsarSnapshot } = require('./jev_objetivo.cjs');

const OBJETIVO = 'incluir uma alergia com descrição {descricao}';
const pastaNova = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roteiro-'));
const lerUnico = (pasta) => {
  const nomes = fs.readdirSync(pasta).filter((n) => n.endsWith('.json'));
  assert.equal(nomes.length, 1);
  return JSON.parse(fs.readFileSync(path.join(pasta, nomes[0]), 'utf8'));
};

/** Lista de alergias -> formulário -> salvo. `base` muda a numeração das refs entre corridas. */
function site({ base = 1, abrir = 2, campo = 'Descrição' } = {}) {
  const st = { tela: 'lista', descricao: '', salvo: false, aberto: 0, cliques: [] };
  const elementos = () => {
    let r = base;
    if (st.tela === 'lista') {
      return [['button', 'Incluir'], ...Array.from({ length: abrir }, () => ['button', 'Abrir'])]
        .map(([papel, nome], i) => ({ papel, nome, ref: `e${r + i}`, i }));
    }
    if (st.tela === 'form') return [{ papel: 'textbox', nome: campo, ref: `e${r + 10}` }, { papel: 'button', nome: 'Salvar', ref: `e${r + 11}` }];
    return [{ papel: 'link', nome: 'Voltar', ref: `e${r + 20}` }];
  };
  const executar = async (verbo, args = []) => {
    if (verbo === 'snapshot') return elementos().map((e) => `- ${e.papel} "${e.nome}" [ref=@${e.ref}]`).join('\n');
    if (verbo === 'url') return st.tela === 'detalhe' ? 'ok: "http://local/detalhe"' : `ok: "http://local/alergia${st.tela === 'form' ? '/nova' : ''}?x=${base}"`;
    if (verbo === 'text') return st.salvo ? 'Registro salvo' : 'Alergias';
    if (verbo === 'eval') return args[0] === 'document.title' ? 'ok: "Alergia"' : 'ok';
    if (verbo === 'click' || verbo === 'fill') {
      const e = elementos().find((x) => `@${x.ref}` === args[0]);
      if (!e) return `erro: ref ${args[0]} nao existe`;
      st.cliques.push(args[0]);
      if (verbo === 'fill') st.descricao = args[1];
      else if (e.nome === 'Incluir') st.tela = 'form';
      else if (e.nome === 'Salvar') { st.tela = 'lista'; st.salvo = true; }
      else if (e.nome === 'Abrir') { st.tela = 'detalhe'; st.aberto = e.i; }
    }
    return 'ok';
  };
  return { st, executar, ref: (nome, n = 0) => elementos().filter((e) => e.nome === nome)[n]?.ref, refPapel: (papel) => elementos().find((e) => e.papel === papel)?.ref };
}

const nao = { noul: 0.1 };
/** O Jev de mentira olha o estado do site, como o de verdade olha a página. */
const jevDoSite = (s, { abrirN } = {}) => async () => {
  const { st } = s;
  if (st.tela === 'detalhe' || (st.tela === 'lista' && st.salvo)) return { operacao: { choice: 'DONE', confidence: 0.95 }, concluido: { noul: 0.9 } };
  const clique = (ref) => ({ operacao: { choice: 'CLICK', confidence: 0.9 }, click_target: { choice: ref, confidence: 0.9 }, concluido: nao });
  if (st.tela === 'lista') return clique(abrirN ? s.ref('Abrir', abrirN - 1) : s.ref('Incluir'));
  if (!st.descricao) {
    const ref = s.refPapel('textbox');
    return { operacao: { choice: 'TYPE_TEXT', confidence: 0.9 }, type_text_target: { choice: ref, confidence: 0.9 }, [`valor_${ref}`]: { choice: 'descricao', confidence: 0.9 }, concluido: nao };
  }
  return clique(s.ref('Salvar'));
};
/** Na repetição o Jev só pode ser perguntado se acabou; pergunta de ação derruba o teste. */
const soVerifica = (noul = 0.9) => async (_, perguntas) => {
  if (Object.keys(perguntas).join() !== 'concluido') throw new Error('o Jev nao pode decidir acao na repeticao');
  return { concluido: { noul } };
};
const proibido = soVerifica();

test('grava so o que deu certo, no formato do desktop, com o valor por chave', async () => {
  const pasta = pastaNova();
  const falha = site();
  const r0 = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: falha.executar,
    perguntar: async () => ({ operacao: { choice: 'BLOCKED', confidence: 0.95 } }) });
  assert.equal(r0.sucesso, false);
  assert.equal(fs.readdirSync(pasta).length, 0, 'corrida sem sucesso nao grava');

  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /gravado em/);
  assert.equal(r.jev.acoes, 4);
  const g = lerUnico(pasta);
  assert.equal(g.versao, 1);
  assert.deepEqual(g.passos.map((p) => p.acao.op), ['click', 'fill', 'click']);
  assert.deepEqual(g.passos[1].valor, { dados: 'descricao' });
  assert.deepEqual(g.passos[1].janela, { classe: 'http://local/alergia/nova', titulo: 'Alergia' });
  assert.deepEqual(g.passos[0].alvo.elemento.ordem, { indice: 0, de: 1 });
  assert.deepEqual(g.passos.map((p) => p.mudou_tela), [true, false, true]);
  assert.ok(!JSON.stringify(g).includes('"A"') && !JSON.stringify(g).includes('@e'), 'nem valor nem ref no arquivo');
});

test('repete sem perguntar ao Jev, com outro valor e outra numeracao de refs', async () => {
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s1.executar, perguntar: jevDoSite(s1) });
  const s2 = site({ base: 40 });
  const r = await rodarComRoteiro({ pasta, objetivo: `  Incluir uma ALERGIA   com descrição {descricao}`, dados: { descricao: 'B' }, executar: s2.executar, perguntar: proibido });
  assert.equal(r.sucesso, true, r.parou);
  assert.deepEqual(r.jev, { acoes: 0, verificacao: 1 });
  assert.equal(s2.st.descricao, 'B');
  assert.deepEqual(s2.st.cliques, ['@e40', '@e50', '@e51']);
  assert.match(r.roteiro, /repetidos 3 de 3/);
});

test('entre gemeos, a repeticao escolhe pela ordem gravada', async () => {
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: 'abrir o segundo', executar: s1.executar, perguntar: jevDoSite(s1, { abrirN: 2 }) });
  assert.deepEqual(lerUnico(pasta).passos[0].alvo.elemento.ordem, { indice: 1, de: 2 });
  const s2 = site({ base: 7 });
  const r = await rodarComRoteiro({ pasta, objetivo: 'abrir o segundo', executar: s2.executar, perguntar: proibido });
  assert.equal(r.sucesso, true);
  assert.equal(s2.st.aberto, 2, 'Incluir e o 0; o segundo Abrir e o 2');

  const cs = parsarSnapshot('- button "Abrir" [ref=@e3]\n- button "Abrir *" [ref=@e9]');
  assert.equal(relocalizar(cs, elementoDe(cs, 'e9').elemento).ref, 'e9');
});

test('gemeos em outra quantidade: o Jev segue da pagina atual e regrava', async () => {
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: 'abrir o segundo', executar: s1.executar, perguntar: jevDoSite(s1, { abrirN: 2 }) });
  const s2 = site({ abrir: 3 });
  const r = await rodarComRoteiro({ pasta, objetivo: 'abrir o segundo', executar: s2.executar, perguntar: jevDoSite(s2, { abrirN: 2 }) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /repetidos 0 de 1 passos; parou no passo 1: button "Abrir" \(2 de 2\)/);
  assert.ok(r.jev.acoes > 0);
  assert.deepEqual(lerUnico(pasta).passos[0].alvo.elemento.ordem, { indice: 1, de: 3 });
});

test('elemento que sumiu: o Jev continua com os passos ja repetidos', async () => {
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s1.executar, perguntar: jevDoSite(s1) });
  const s2 = site({ campo: 'Observação' });
  const vistos = [];
  const jev = jevDoSite(s2);
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'C' }, executar: s2.executar,
    perguntar: async (estado, q) => { vistos.push(estado.ja_feito); return jev(estado, q); } });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /repetidos 1 de 3 passos; parou no passo 2/);
  assert.deepEqual(vistos[0], ['CLICK button "Incluir"'], 'o Jev sabe o que a repeticao ja fez');
  assert.equal(s2.st.descricao, 'C');
  assert.equal(lerUnico(pasta).passos[1].alvo.elemento.name, 'Observação');
});

test('dado secreto: nada vai a disco', async () => {
  const pasta = pastaNova();
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A', senha: 'x' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /não gravado: contém um valor secreto/);
  assert.equal(fs.readdirSync(pasta).length, 0);
});

test('roteiro ilegivel: avisa, roda pelo Jev e regrava', async () => {
  const pasta = pastaNova();
  const arq = arquivo(pasta, 'http://local', OBJETIVO, { descricao: 'A' });
  fs.writeFileSync(arq, '{ quebrado');
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /roteiro ilegível, seguindo pelo Jev/);
  assert.equal(lerUnico(pasta).versao, 1);
});

test('--refazer ignora o roteiro', async () => {
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s1.executar, perguntar: jevDoSite(s1) });
  const s2 = site();
  const r = await rodarComRoteiro({ pasta, refazer: true, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s2.executar, perguntar: jevDoSite(s2) });
  assert.equal(r.jev.acoes, 4);
});

test('repeticao sem a pagina confirmar nao e sucesso: o Jev segue e regrava', async () => {
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s1.executar, perguntar: jevDoSite(s1) });
  const arq = path.join(pasta, fs.readdirSync(pasta)[0]);
  fs.writeFileSync(arq, JSON.stringify({ ...lerUnico(pasta), passos: lerUnico(pasta).passos.slice(0, 2) }));
  // Roteiro parou antes de salvar, mas a pagina final tem o mesmo endereco gravado em `fim`.
  const s2 = site();
  const jev = jevDoSite(s2);
  let primeira = true;
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s2.executar,
    perguntar: async (e, q) => { if (primeira) { primeira = false; return soVerifica(0.2)(e, q); } return jev(e, q); } });
  assert.equal(r.sucesso, true);
  assert.equal(s2.st.salvo, true, 'quem salvou foi o Jev, depois da verificacao negar');
  assert.deepEqual(r.jev, { acoes: 2, verificacao: 1 });
  assert.match(r.roteiro, /não confirmou o fim \(0\.20\).*gravado em/);
  assert.equal(lerUnico(pasta).passos.length, 3);
});
