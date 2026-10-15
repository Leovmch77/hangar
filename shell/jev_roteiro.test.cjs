const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { rodarComRoteiro, relocalizar, elementoDe, arquivo, pastaDe, reservaDe, juntar, salvar, gravador, PASTA } = require('./jev_roteiro.cjs');
const { parsarSnapshot, jsDeSelecionar } = require('./jev_objetivo.cjs');

const OBJETIVO = 'incluir uma alergia com descrição {descricao}';
const pastaNova = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roteiro-'));
const lerUnico = (pasta) => {
  const nomes = fs.readdirSync(pasta).filter((n) => n.endsWith('.json'));
  assert.equal(nomes.length, 1);
  const r = JSON.parse(fs.readFileSync(path.join(pasta, nomes[0]), 'utf8'));
  // A variante 0 a mao, para os testes de um caminho so.
  return { ...r, ...r.variantes[0] };
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
  assert.equal(g.versao, 2);
  assert.equal(g.variantes.length, 1);
  assert.deepEqual(g.passos.map((p) => p.acao.op), ['click', 'fill', 'click']);
  assert.deepEqual(g.passos[1].valor, { dados: 'descricao' });
  assert.deepEqual(g.passos[1].janela, { classe: '/alergia/nova', titulo: 'Alergia' });
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

test('roteiro da pasta antiga (reserva) repete e passa a morar na pasta nova', async () => {
  const antiga = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta: antiga, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s1.executar, perguntar: jevDoSite(s1) });
  const nova = pastaNova();
  const s2 = site({ base: 40 });
  const r = await rodarComRoteiro({ pasta: nova, reserva: antiga, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s2.executar, perguntar: proibido });
  assert.equal(r.sucesso, true, r.parou);
  assert.match(r.roteiro, /repetidos 3 de 3/);
  assert.equal(lerUnico(nova).variantes.length, 1, 'regravado na pasta nova');
});

test('roteiro antigo ilegivel na reserva nao impede gravar na pasta nova', async () => {
  const antiga = pastaNova();
  const s0 = site();
  await rodarComRoteiro({ pasta: antiga, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s0.executar, perguntar: jevDoSite(s0) });
  const [quebrado] = fs.readdirSync(antiga);
  fs.writeFileSync(path.join(antiga, quebrado), '{ quebrado');
  const nova = pastaNova();
  const s = site();
  const r = await rodarComRoteiro({ pasta: nova, reserva: [antiga], objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true, r.parou);
  assert.match(r.roteiro, /gravado em/);
  assert.equal(lerUnico(nova).variantes.length, 1);
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
  assert.match(r.roteiro, /nenhuma das 1 variantes casa com a página; o Jev segue/);
  assert.ok(r.jev.acoes > 0);
  const g = lerUnico(pasta);
  assert.deepEqual(g.variantes.map((v) => v.passos[0].alvo.elemento.ordem.de), [3, 2], 'a nova na frente, a antiga fica');
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
  const arq = arquivo(pasta, '/alergia', OBJETIVO, { descricao: 'A' });
  fs.writeFileSync(arq, '{ quebrado');
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /roteiro ilegível, seguindo pelo Jev/);
  assert.match(r.roteiro, /ilegível guardado em .*\.bak/);
  assert.equal(fs.readFileSync(`${arq}.bak`, 'utf8'), '{ quebrado');
  assert.equal(lerUnico(pasta).versao, 2);
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
  const curto = lerUnico(pasta);
  fs.writeFileSync(arq, JSON.stringify({ versao: 2, objetivo: curto.objetivo, variantes: [{ ...curto.variantes[0], passos: curto.passos.slice(0, 2) }] }));
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

test('nome legivel, sem a origem: o mesmo roteiro vale em outra porta', async () => {
  assert.match(path.basename(arquivo('/x', '/pss/alergia', 'Incluir uma alergia com nome {nome}', { nome: 'a' })),
    /^incluir-uma-alergia-com-nome-nome-[0-9a-f]{8}\.json$/);
  assert.equal(arquivo('/x', '/a', 'Ação  É', {}), arquivo('/x', '/a', 'ação é', {}));
  const pasta = pastaNova();
  const s1 = site();
  await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s1.executar, perguntar: jevDoSite(s1) });
  const s2 = site();
  const outraPorta = async (verbo, args) => {
    const r = await s2.executar(verbo, args);
    return verbo === 'url' ? String(r).replace('http://local/', 'http://local:3000/') : r;
  };
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: outraPorta, perguntar: proibido });
  assert.equal(r.sucesso, true, r.parou);
  assert.match(r.roteiro, /repetidos 3 de 3/);
});

test('pasta: automacao/gravacoes na raiz do git de qualquer subpasta; fora de repo, o cache; as antigas só como reserva', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'src'));
  const raiz = fs.realpathSync(repo);
  assert.equal(pastaDe(path.join(repo, 'src')), path.join(raiz, 'automacao', 'gravacoes'));
  assert.equal(pastaDe(fs.mkdtempSync(path.join(os.tmpdir(), 'solto-'))), PASTA);
  assert.deepEqual(reservaDe(path.join(repo, 'src')), [], 'sem pasta antiga, nada de reserva');
  fs.mkdirSync(path.join(repo, '.hangar', 'roteiros'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'e2e', 'roteiros'), { recursive: true });
  assert.deepEqual(reservaDe(path.join(repo, 'src')), [path.join(raiz, 'e2e', 'roteiros'), path.join(raiz, '.hangar', 'roteiros')]);
});

/** Grava a corrida boa e devolve o arquivo e a variante dela, para montar outras à mão. */
async function gravarBoa() {
  const pasta = pastaNova();
  const s = site();
  await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: s.executar, perguntar: jevDoSite(s) });
  const arq = path.join(pasta, fs.readdirSync(pasta)[0]);
  const boa = JSON.parse(fs.readFileSync(arq, 'utf8')).variantes[0];
  return { pasta, arq, boa };
}
const comNome = (v, n, nome) => ({ ...v, passos: v.passos.map((p, i) => (i === n ? { ...p, alvo: { elemento: { ...p.alvo.elemento, name: nome } } } : p)) });
const escrever = (arq, variantes) => fs.writeFileSync(arq, JSON.stringify({ versao: 2, objetivo: OBJETIVO, variantes }));

test('variantes: vale a primeira cujo passo 1 casa com a pagina, e ela vai a frente', async () => {
  const { pasta, arq, boa } = await gravarBoa();
  const outra = comNome(boa, 0, 'Novo registro');
  escrever(arq, [outra, boa]);
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: proibido });
  assert.equal(r.sucesso, true, r.parou);
  assert.match(r.roteiro, /variante 2 de 2: repetidos 3 de 3/);
  assert.deepEqual(lerUnico(pasta).variantes.map((v) => v.passos[0].alvo.elemento.name), ['Incluir', 'Novo registro']);
});

test('variantes: depois de uma agir, a divergencia vai ao Jev, nunca a outra variante', async () => {
  const { pasta, arq, boa } = await gravarBoa();
  const quebra = comNome(boa, 1, 'Campo que nao existe');
  escrever(arq, [quebra, boa]);
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /variante 1 de 2: repetidos 1 de 3 passos; parou no passo 2/);
  assert.ok(r.jev.acoes > 0, 'o Jev seguiu');
  // A corrida refez a sequencia da `boa`: ela sai como duplicata e a nova fica a frente.
  const g = lerUnico(pasta);
  assert.deepEqual(g.variantes.map((v) => v.passos[1].alvo.elemento.name), ['Descrição', 'Campo que nao existe']);
});

test('variantes: igual sai, no maximo 5, a mais recente primeiro', () => {
  const v = (n) => ({ passos: [{ janela: { classe: '/a', titulo: 't' }, alvo: null, acao: { op: 'press', key: `K${n}` }, valor: null, mudou_tela: n % 2 === 0 }], fim: null });
  const lista = [1, 2, 3, 4, 5].map(v);
  assert.deepEqual(juntar(lista, v(3)).map((x) => x.passos[0].acao.key), ['K3', 'K1', 'K2', 'K4', 'K5'], 'mudou_tela e valor nao contam');
  assert.deepEqual(juntar(lista, v(9)).map((x) => x.passos[0].acao.key), ['K9', 'K1', 'K2', 'K3', 'K4']);
});

test('arquivo da versao 1 e lido como uma variante e regravado na 2', async () => {
  const { pasta, arq, boa } = await gravarBoa();
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, objetivo: OBJETIVO, passos: boa.passos, fim: boa.fim }));
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: proibido });
  assert.equal(r.sucesso, true, r.parou);
  assert.match(r.roteiro, /variante 1 de 1: repetidos 3 de 3/);
  const g = lerUnico(pasta);
  assert.equal(g.versao, 2);
  assert.equal(g.variantes.length, 1);
});

const navegar = (classe) => ({ janela: { classe, titulo: 't' }, alvo: null, acao: { op: 'goto' }, valor: null, mudou_tela: true });

test('escolha em 3 passes: navegacao ja na pagina, depois passo que casa, por ultimo navegacao cega', async () => {
  const { pasta, arq, boa } = await gravarBoa();
  // Leva a outra pagina: casaria com qualquer uma.
  const cega = { passos: [navegar('/inicio')], fim: { classe: '/outra', titulo: 't' } };
  const jaAberta = { passos: [navegar('/inicio'), ...boa.passos], fim: boa.fim };
  // (b) vence (c): a navegacao cega casaria com qualquer pagina.
  escrever(arq, [cega, boa]);
  let s = site();
  let r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: proibido });
  assert.match(r.roteiro, /variante 2 de 2: repetidos 3 de 3/);
  // (a) vence (b): a navegacao leva a pagina ja aberta e e pulada.
  escrever(arq, [boa, jaAberta]);
  s = site();
  r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: proibido });
  assert.equal(r.sucesso, true, r.parou);
  assert.match(r.roteiro, /variante 2 de 2: repetidos 4 de 4/);
  // (c) so sem outra: escolhida, mas sem endereco para navegar, o Jev segue.
  escrever(arq, [cega]);
  s = site();
  r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /variante 1 de 1: repetidos 0 de 1 passos; parou no passo 1: navegação para \/outra/);
});

test('arquivo em versao desconhecida nunca e sobrescrito; a corrida segue valendo', async () => {
  const { pasta, arq } = await gravarBoa();
  const futuro = JSON.stringify({ versao: 3, objetivo: OBJETIVO, coisa: [] });
  fs.writeFileSync(arq, futuro);
  const s = site();
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /não gravado: arquivo em versão 3/);
  assert.equal(fs.readFileSync(arq, 'utf8'), futuro);
});

test('salvar: tmp unico por escrita e nenhum tmp sobra quando falha', () => {
  const pasta = pastaNova();
  const arq = path.join(pasta, 'r.json');
  // Outro escritor com o tmp "fixo" aberto não atrapalha.
  fs.mkdirSync(`${arq}.tmp`);
  salvar(arq, { versao: 2, variantes: [] });
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).versao, 2);
  const preso = path.join(pasta, 'dir.json');
  fs.mkdirSync(path.join(preso, 'x'), { recursive: true });
  assert.throws(() => salvar(preso, { versao: 2, variantes: [] }));
  assert.deepEqual(fs.readdirSync(pasta).filter((n) => n.startsWith('dir.json.')), [], 'tmp removido na falha');
});

test('corridas simultaneas: a gravacao rele o arquivo e junta, nunca apaga a outra', async () => {
  const { pasta, arq, boa } = await gravarBoa();
  fs.rmSync(arq);
  const s = site();
  const jev = jevDoSite(s);
  let uma = true;
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar,
    perguntar: async (e, q) => {
      // Outra corrida grava no meio desta.
      if (uma) { uma = false; escrever(arq, [comNome(boa, 0, 'Da outra')]); }
      return jev(e, q);
    } });
  assert.equal(r.sucesso, true);
  assert.deepEqual(lerUnico(pasta).variantes.map((v) => v.passos[0].alvo.elemento.name), ['Incluir', 'Da outra']);
});

test('url com erro: roda pelo Jev sem gravar nem repetir, e diz por que', async () => {
  const pasta = pastaNova();
  const s = site();
  let primeira = true;
  const executar = async (verbo, args) => {
    if (verbo === 'url' && primeira) { primeira = false; return 'erro: navegador fora do ar'; }
    return s.executar(verbo, args);
  };
  const r = await rodarComRoteiro({ pasta, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar, perguntar: jevDoSite(s) });
  assert.equal(r.sucesso, true);
  assert.match(r.roteiro, /^sem página \(erro: navegador fora do ar\)$/);
  assert.deepEqual(fs.readdirSync(pasta), []);
});

test('select que devolveu erro nao vira passo', async () => {
  const g = gravador(async () => 'ok: "erro: opcao sumiu"', {});
  await g.executar('eval', [jsDeSelecionar('Penicilina')]);
  assert.deepEqual(g.variante(), { motivo: 'nenhuma ação a gravar' });
});

test('pasta global: o host (sem porta) entra na chave e na conferencia da pagina', async () => {
  const pasta = pastaNova();
  const comHost = (s, host) => async (verbo, args) => {
    const r = await s.executar(verbo, args);
    return verbo === 'url' ? String(r).replace('http://local/', `http://${host}/`) : r;
  };
  const s1 = site();
  await rodarComRoteiro({ pasta, comHost: true, objetivo: OBJETIVO, dados: { descricao: 'A' }, executar: comHost(s1, 'a.test'), perguntar: jevDoSite(s1) });
  assert.equal(lerUnico(pasta).passos[0].janela.classe, 'a.test/alergia');
  // Outra porta do mesmo host repete.
  const s2 = site();
  const r2 = await rodarComRoteiro({ pasta, comHost: true, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: comHost(s2, 'a.test:3000'), perguntar: proibido });
  assert.match(r2.roteiro, /repetidos 3 de 3/);
  // Outro site com o mesmo caminho nunca usa o arquivo dele.
  const s3 = site();
  const r3 = await rodarComRoteiro({ pasta, comHost: true, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: comHost(s3, 'b.test'), perguntar: jevDoSite(s3) });
  assert.equal(r3.sucesso, true);
  assert.doesNotMatch(r3.roteiro, /variante/);
  assert.equal(fs.readdirSync(pasta).filter((n) => n.endsWith('.json')).length, 2);
});

test('--refazer grava so a variante nova', async () => {
  const { pasta, arq, boa } = await gravarBoa();
  escrever(arq, [comNome(boa, 0, 'Outro'), comNome(boa, 0, 'Mais um')]);
  const s = site();
  await rodarComRoteiro({ pasta, refazer: true, objetivo: OBJETIVO, dados: { descricao: 'B' }, executar: s.executar, perguntar: jevDoSite(s) });
  assert.deepEqual(lerUnico(pasta).variantes.map((v) => v.passos[0].alvo.elemento.name), ['Incluir']);
});
