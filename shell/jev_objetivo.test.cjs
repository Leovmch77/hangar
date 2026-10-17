const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parsarSnapshot, montarPerguntas, montarEstado, decidir, rodar, pedidoDeTexto, valorDoCampo, cabecaDoValor, perguntaDeConfere, chegouNoEstado, destinoDoJev, NENHUM, SEM_SELECT, decidirPeloAuxiliar, pedidoDeAjuda } = require('./jev_objetivo.cjs');

const SNAPSHOT = `- RootWebArea "Cadastro"
  - link "Ver ajuda" [ref=@e1]
  - button "Iniciar cadastro" [ref=@e2]
  - StaticText "Nenhum cadastro em andamento"
  - button [ref=@e3]
  - image "Jefferson"
  - textbox "Nome do paciente" [ref=@e4]
  - textbox "Data de nascimento" [ref=@e5]
  - combobox "Convenio" [ref=@e20]
    - option "Unimed" [ref=@e21]
    - option "Bradesco Saude" [ref=@e22]`;

const CANDIDATOS = parsarSnapshot(SNAPSHOT);
const SO_TEXTO = '- RootWebArea "pronto"\n  - StaticText "Cadastro salvo com sucesso."';

test('parsarSnapshot pega so o que da pra acionar e tem nome', () => {
  assert.deepEqual(CANDIDATOS.map((c) => c.ref), ['e1', 'e2', 'e4', 'e5', 'e20', 'e21', 'e22']);
  assert.equal(parsarSnapshot(SNAPSHOT, 2).length, 2);
});

test('opcao e alvo dos DOIS caminhos: SELECT no <select> nativo, CLICK na listbox ARIA', () => {
  const p = montarPerguntas(CANDIDATOS);
  assert.deepEqual(Object.keys(p.click_target.criteria), ['e1', 'e2', 'e20', 'e21', 'e22', NENHUM]);
  assert.deepEqual(Object.keys(p.select_target.criteria), ['e21', 'e22', NENHUM]);
  assert.ok('SELECT' in p.operacao.criteria);
});

test('sem dropdown na pagina, SELECT nem e oferecida', () => {
  const semOpcao = montarPerguntas(CANDIDATOS.filter((c) => c.papel !== 'option'));
  assert.ok(!('SELECT' in semOpcao.operacao.criteria));
  assert.ok(!('select_target' in semOpcao));
});

test('cada operacao ganha seu head de alvo, so com elementos compativeis', () => {
  const p = montarPerguntas(CANDIDATOS);
  assert.deepEqual(Object.keys(p.click_target.criteria), ['e1', 'e2', 'e20', 'e21', 'e22', NENHUM]);
  assert.deepEqual(Object.keys(p.type_text_target.criteria), ['e4', 'e5', NENHUM]);
  assert.ok('DONE' in p.operacao.criteria && 'BLOCKED' in p.operacao.criteria);
});

test('operacao sem elemento compativel nem e oferecida', () => {
  const soBotoes = montarPerguntas(CANDIDATOS.filter((c) => c.papel === 'button'));
  assert.ok(!('TYPE_TEXT' in soBotoes.operacao.criteria));
  assert.ok(!('type_text_target' in soBotoes));
});

const resposta = ({ op = 'CLICK', confOp = 0.9, click = 'e2', confClick = 0.9, campo = 'e4', confCampo = 0.9, opcao = 'e22', confOpcao = 0.9, arriscado = 0.02, concluido = 0.9 } = {}) => ({
  operacao: { choice: op, confidence: confOp },
  concluido: { noul: concluido },
  click_target: { choice: click, confidence: confClick },
  type_text_target: { choice: campo, confidence: confCampo },
  select_target: { choice: opcao, confidence: confOpcao },
  arriscado: { noul: arriscado },
});
const decide = (r) => decidir(r, CANDIDATOS);

test('usa o head que casa com a operacao e ignora o outro', () => {
  const clique = decide(resposta({ op: 'CLICK', click: 'e2', campo: 'e4' }));
  assert.equal(clique.alvo, 'e2');
  const digita = decide(resposta({ op: 'TYPE_TEXT', click: 'e2', campo: 'e4' }));
  assert.equal(digita.alvo, 'e4');
});

test('um head especulativo sem alvo nao atrapalha a operacao escolhida', () => {
  const clique = decide(resposta({ op: 'CLICK', campo: NENHUM, confCampo: 0.1 }));
  assert.equal(clique.alvo, 'e2', 'o type_text_target vazio nao e da operacao CLICK');
});

test('DONE e BLOCKED param o laco', () => {
  assert.match(decide(resposta({ op: 'DONE' })).parar, /objetivo atingido/);
  assert.match(decide(resposta({ op: 'BLOCKED' })).parar, /nao da/);
});

test('DONE com a pagina NAO confirmando nao encerra, mesmo com o choice forte', () => {
  const d = decide(resposta({ op: 'DONE', confOp: 0.95, concluido: 0.2 }));
  assert.ok(!/objetivo atingido/.test(d.parar ?? ''), 'nao pode declarar sucesso sem a pagina confirmar');
});

test('SELECT define o valor do dropdown e dispara change, sem clicar na opcao', async () => {
  const executados = [];
  let volta = 0;
  const r = await rodar({
    objetivo: 'escolher o convenio Bradesco Saude',
    maxPassos: 3,
    executar: navegador(executados),
    perguntar: async () => (volta++ === 0 ? resposta({ op: 'SELECT' }) : resposta({ op: 'DONE' })),
  });
  assert.deepEqual(r.feito, ['SELECT "Bradesco Saude"']);
  const js = executados.find((l) => l.startsWith('eval ') && l.includes('dispatchEvent'));
  assert.match(js, /Bradesco Saude/);
  assert.ok(!executados.some((l) => l === 'click @e22'), 'nao clica na option');
});

test('SELECT que nao acha o dropdown para em vez de seguir', async () => {
  const r = await rodar({
    objetivo: 'escolher o convenio',
    maxPassos: 3,
    executar: async (verbo) => {
      if (verbo === 'snapshot') return SNAPSHOT;
      if (verbo === 'url') return 'http://local/x';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval') return 'erro: nenhum select tem a opcao Bradesco Saude';
      return 'ok';
    },
    perguntar: async () => resposta({ op: 'SELECT' }),
  });
  assert.match(r.parou, /SELECT falhou/);
});

test('SCROLL_DOWN nao precisa de alvo', () => {
  assert.deepEqual(decide(resposta({ op: 'SCROLL_DOWN' })), { operacao: 'SCROLL_DOWN' });
});

test('nunca age sozinho numa operacao arriscada', () => {
  assert.match(decide(resposta({ arriscado: 0.6 })).parar, /arriscada/);
});

test('para quando a decisao nao esta confiante', () => {
  assert.match(decide(resposta({ confOp: 0.2 })).parar, /operacao indecisa/);
  assert.match(decide(resposta({ confClick: 0.4 })).parar, /sem alvo confiavel/);
  assert.match(decide(resposta({ click: NENHUM })).parar, /sem alvo confiavel/);
  assert.match(decide(resposta({ click: 'e999' })).parar, /nao esta na pagina/);
  assert.match(decidir({}, CANDIDATOS).parar, /sem operacao/);
});

test('dois botoes de rotulo IDENTICO somam a massa e o mais provavel vale', () => {
  const gemeos = parsarSnapshot(`- RootWebArea "Hangar"
  - button "Nova sessão" [ref=@e2]
  - button "Nova sessão" [ref=@e21]
  - button "Configurações" [ref=@e6]`);
  const r = {
    operacao: { choice: 'CLICK', confidence: 0.9 },
    concluido: { noul: 0.1 },
    arriscado: { noul: 0.02 },
    click_target: { choice: 'e21', probabilities: { e21: 0.44, e2: 0.32, e6: 0.13 } },
  };
  const passo = decidir(r, gemeos);
  // Nenhum dos dois chega ao piso de 0.6 sozinho, e os dois abrem a mesma folha.
  assert.equal(passo.alvo, 'e21');
  assert.ok(passo.confianca >= 0.6);
});

test('gemeos sem distribuicao caem no caminho de sempre, nao em massa zero', () => {
  const gemeos = parsarSnapshot(`- RootWebArea "Hangar"
  - button "Nova sessão" [ref=@e2]
  - button "Nova sessão" [ref=@e21]`);
  const r = {
    operacao: { choice: 'CLICK', confidence: 0.9 },
    concluido: { noul: 0.1 },
    arriscado: { noul: 0.02 },
    // Só `confidence`: somar um `probabilities` ausente dava 0 e barrava um alvo de 0.9.
    click_target: { choice: 'e21', confidence: 0.9 },
  };
  const passo = decidir(r, gemeos);
  assert.equal(passo.alvo, 'e21');
  assert.equal(passo.confianca, 0.9);
});

test('rotulos DIFERENTES que dividem a massa continuam parando', () => {
  const r = {
    operacao: { choice: 'CLICK', confidence: 0.9 },
    concluido: { noul: 0.1 },
    arriscado: { noul: 0.02 },
    click_target: { choice: 'e1', probabilities: { e1: 0.44, e2: 0.32 } },
  };
  assert.match(decide(r).parar, /sem alvo confiavel/);
});

test('o pedido ao LLM de texto leva campo, objetivo e historico', () => {
  const pedido = pedidoDeTexto('cadastrar o Jefferson', 'Nome do paciente', ['CLICK Iniciar']);
  assert.match(pedido, /Nome do paciente/);
  assert.match(pedido, /cadastrar o Jefferson/);
  assert.match(pedido, /CLICK Iniciar/);
  assert.match(pedido, /APENAS com o valor/);
});

const navegador = (executados, snapshot = SNAPSHOT) => async (verbo, args) => {
  executados.push([verbo, ...args].join(' '));
  if (verbo === 'snapshot') return snapshot;
  if (verbo === 'url') return 'http://local/cadastro';
  if (verbo === 'text') return 'Cadastro de paciente';
  return 'ok';
};

test('o estado leva o valor atual dos campos, lido da pagina', async () => {
  let visto = null;
  await rodar({
    objetivo: 'conferir',
    maxPassos: 1,
    executar: async (verbo) => {
      if (verbo === 'snapshot') return SNAPSHOT;
      if (verbo === 'url') return 'http://local/x';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval') return 'ok: "{\\"valores\\":{\\"Nome do paciente\\":\\"Jefferson\\"},\\"obrigatorios_vazios\\":[\\"Convenio*\\"]}"';
      return 'ok';
    },
    perguntar: async (estado) => { visto = estado; return resposta({ op: 'DONE' }); },
  });
  assert.deepEqual(visto.valores_atuais, { 'Nome do paciente': 'Jefferson' });
  assert.deepEqual(visto.obrigatorios_ainda_vazios, ['Convenio*'], 'o que falta preencher e o que impede o submit');
});

test('a regra de nao submeter cedo fica na instrucao, nao no criterio de CLICK', () => {
  const p = montarPerguntas(CANDIDATOS);
  assert.match(p.operacao.instructions, /obrigatorios_ainda_vazios/);
  assert.doesNotMatch(p.operacao.criteria.CLICK, /obrigatorios|fill/, 'criterio de CLICK falando em preencher atrai a escolha errada');
});

test('sonda de valores que falha nao derruba o laco', async () => {
  let visto = null;
  await rodar({
    objetivo: 'conferir',
    maxPassos: 1,
    executar: async (verbo) => {
      if (verbo === 'snapshot') return SNAPSHOT;
      if (verbo === 'url') return 'http://local/x';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval') return 'erro: nao deu';
      return 'ok';
    },
    perguntar: async (estado) => { visto = estado; return resposta({ op: 'DONE' }); },
  });
  assert.deepEqual(visto.valores_atuais, {}, 'anotacao e melhoria, nao requisito');
});

test('ref que mudou de elemento entre o snapshot e a decisao nao e usada', async () => {
  const executados = [];
  let volta = 0;
  const OUTRO = SNAPSHOT.replace('button "Iniciar cadastro" [ref=@e2]', 'button "Excluir tudo" [ref=@e2]');
  const r = await rodar({
    objetivo: 'iniciar',
    // Uma volta so: na segunda o Jev ja teria visto a pagina nova e escolher @e2 seria legitimo.
    maxPassos: 1,
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' '));
      // 1o snapshot: pagina original. Do 2o em diante (a reconferencia): @e2 virou outro botao.
      if (verbo === 'snapshot') return volta++ === 0 ? SNAPSHOT : OUTRO;
      if (verbo === 'url') return 'http://local/x';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval') return 'ok: "{}"';
      return 'ok';
    },
    perguntar: async () => resposta({ op: 'CLICK', click: 'e2' }),
  });
  assert.ok(!executados.includes('click @e2'), 'nao clica num alvo que trocou de identidade');
  assert.deepEqual(r.feito, []);
});

test('rodar clica e para no DONE, sem LLM entre os passos', async () => {
  const executados = [];
  let volta = 0;
  const r = await rodar({
    objetivo: 'iniciar o cadastro',
    maxPassos: 5,
    executar: navegador(executados),
    perguntar: async () => (volta++ === 0 ? resposta() : resposta({ op: 'DONE' })),
  });
  assert.deepEqual(r.feito, ['CLICK button "Iniciar cadastro"']);
  assert.match(r.parou, /objetivo atingido/);
  assert.ok(executados.includes('click @e2'));
});

test('TYPE_TEXT pede o valor ao LLM pequeno, vendo o campo', async () => {
  const executados = [];
  const pedidos = [];
  let volta = 0;
  await rodar({
    objetivo: 'cadastrar o paciente Jefferson Felizardo',
    maxPassos: 3,
    executar: navegador(executados),
    escreverTexto: async (pedido) => { pedidos.push(pedido); return 'Jefferson Felizardo\n'; },
    perguntar: async () => (volta++ === 0 ? resposta({ op: 'TYPE_TEXT' }) : resposta({ op: 'DONE' })),
  });
  assert.ok(executados.includes('fill @e4 Jefferson Felizardo'), 'digita o valor sem o \\n');
  // Com outros campos vazios na tela o primeiro pedido é o de lote; resposta fora de JSON cai no unitário.
  assert.ok(pedidos.some((p) => /Campos? a preencher: .*Nome do paciente/.test(p)), pedidos.join('\n---\n'));
});

test('TYPE_TEXT sem dados e sem modelo de texto para em vez de chutar', async () => {
  const r = await rodar({
    objetivo: 'cadastrar',
    executar: navegador([]),
    perguntar: async () => resposta({ op: 'TYPE_TEXT' }),
  });
  assert.match(r.parou, /nenhum dado foi passado.*nao ha modelo de texto/);
});

test('com dados, ha uma pergunta de valor POR campo de texto', () => {
  const p = montarPerguntas(CANDIDATOS, { nome: 'Jefferson', plano: 'Unimed' });
  assert.deepEqual(Object.keys(p[cabecaDoValor('e4')].criteria), ['nome', 'plano', NENHUM]);
  assert.ok(cabecaDoValor('e5') in p, 'cada campo tem a sua, porque a resposta nao pode depender de outra');
  assert.ok(!(cabecaDoValor('e2') in p), 'botao nao ganha pergunta de valor');
  assert.equal(p[cabecaDoValor('e4')].criteria.plano, 'plano = "Unimed"');
});

test('campo de credencial nunca vai ao modelo de texto — senha nao se inventa', async () => {
  let pediu = false;
  const r = await valorDoCampo({
    campo: { nome: 'Senha de acesso' },
    escolha: { choice: NENHUM, probabilities: { [NENHUM]: 0.9 } },
    cofre: { usuario: 'jefferson' },
    objetivo: 'fazer login',
    feito: [],
    escreverTexto: async () => { pediu = true; return 'Abc12345!'; },
  });
  assert.equal(pediu, false, 'o modelo de texto nem pode ser chamado para um campo de senha');
  assert.equal(r.valor, undefined);
  assert.equal(r.falta, 'Senha de acesso');
  assert.match(r.parou, /credencial/);
});

test('senha que veio em --dados continua sendo usada — a recusa e so contra inventar', async () => {
  const r = await valorDoCampo({
    campo: { nome: 'Senha de acesso' },
    escolha: { choice: 'senha', probabilities: { senha: 0.9 } },
    cofre: { senha: 'valor-do-usuario' },
    objetivo: 'fazer login',
    feito: [],
    escreverTexto: async () => 'nao devia chegar aqui',
  });
  assert.equal(r.valor, 'valor-do-usuario');
});

test('valor de chave sensivel nao cruza a rede', () => {
  const p = montarPerguntas(CANDIDATOS, { usuario: 'jeff', senha: 'hunter2' });
  assert.equal(p[cabecaDoValor('e4')].criteria.usuario, 'usuario = "jeff"');
  assert.match(p[cabecaDoValor('e4')].criteria.senha, /nao enviado/);
  assert.ok(!JSON.stringify(p).includes('hunter2'));
});

const campo = { ref: 'e4', papel: 'textbox', nome: 'Nome do paciente' };

test('dados vem antes do LLM', async () => {
  const r = await valorDoCampo({
    campo,
    escolha: { choice: 'nome', confidence: 0.9 },
    cofre: { nome: 'Jefferson Felizardo' },
    escreverTexto: async () => assert.fail('nao devia chamar o LLM tendo o valor em dados'),
  });
  assert.deepEqual(r, { valor: 'Jefferson Felizardo', origem: 'dados.nome' });
});

test('campo que dados nao cobre cai no LLM', async () => {
  for (const escolha of [{ choice: NENHUM, confidence: 0.9 }, { choice: 'nome', confidence: 0.2 }, undefined]) {
    const r = await valorDoCampo({
      campo, escolha, cofre: { nome: 'Jefferson' }, objetivo: 'cadastrar', feito: [],
      escreverTexto: async () => '  do modelo \n',
    });
    assert.deepEqual(r, { valor: 'do modelo', origem: 'llm' });
  }
});

test('sem dados e sem LLM, diz qual campo faltou — em frase e em campo isolado', async () => {
  const r = await valorDoCampo({ campo, escolha: undefined, cofre: {} });
  assert.match(r.parou, /Nome do paciente/);
  assert.equal(r.falta, 'Nome do paciente', 'quem chamou reinvoca com este nome, sem ler a frase');
});

test('o campo que faltou sobe ate o resultado do laco', async () => {
  const r = await rodar({
    objetivo: 'cadastrar',
    executar: navegador([]),
    perguntar: async () => resposta({ op: 'TYPE_TEXT' }),
  });
  assert.equal(r.falta, 'Nome do paciente');
});

test('o LLM que nao sabe o valor para, em vez de escrever prosa no campo', async () => {
  for (const saida of ['SEM_VALOR', '  SEM_VALOR\n', 'SEM_VALOR — nao consta no objetivo', '']) {
    const r = await valorDoCampo({
      campo, escolha: undefined, cofre: {}, objetivo: 'cadastrar', feito: [],
      escreverTexto: async () => saida,
    });
    assert.ok(r.parou, `deveria parar com a saida ${JSON.stringify(saida)}`);
    assert.equal(r.valor, undefined);
  }
});

test('o pedido ao LLM ensina a saida SEM_VALOR', () => {
  assert.match(pedidoDeTexto('cadastrar', 'Data de nascimento', []), /SEM_VALOR/);
});

test('pagina sem nada acionavel ainda pergunta se concluiu', async () => {
  const feito = await rodar({
    objetivo: 'salvar',
    executar: navegador([], SO_TEXTO),
    perguntar: async () => ({ concluido: { noul: 0.96 } }),
  });
  assert.match(feito.parou, /objetivo atingido/);

  const naoFeito = await rodar({
    objetivo: 'salvar',
    executar: navegador([], SO_TEXTO),
    perguntar: async () => ({ concluido: { noul: 0.1 } }),
  });
  assert.match(naoFeito.parou, /nao tem elemento acionavel/);
});

test('erro do navegador vira parada explicita, nao "pagina vazia"', async () => {
  const r = await rodar({
    objetivo: 'qualquer coisa',
    executar: async (verbo) => (verbo === 'snapshot' ? 'erro: a aba escondida nao descongelou' : 'ok'),
    perguntar: async () => assert.fail('nao deveria chegar a perguntar ao Jev'),
  });
  assert.match(r.parou, /o navegador falhou no snapshot/);
});

test('insistir no mesmo alvo para, mesmo com a pagina alternando', async () => {
  let n = 0;
  const r = await rodar({
    objetivo: 'nunca termina',
    maxPassos: 12,
    // Snapshot alternando de tamanho a cada volta, como um dropdown que abre e fecha: a guarda
    // NAO pode olhar o estado da pagina, so o alvo repetido.
    executar: async (verbo) => {
      if (verbo === 'snapshot') return n++ % 2 ? `${SNAPSHOT}\n  - StaticText "x"` : SNAPSHOT;
      if (verbo === 'url') return 'http://local/x';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval') return 'ok: "{}"';
      return 'ok';
    },
    perguntar: async () => resposta(),
  });
  assert.ok(r.feito.length <= 3, `agiu ${r.feito.length}x; devia parar em 3`);
  assert.match(r.parou, /repetiu 3x/);
});

test('alvos diferentes a cada passo nao disparam a guarda', async () => {
  const alvos = ['e1', 'e2', 'e1', 'e2'];
  let i = 0;
  const r = await rodar({
    objetivo: 'alterna alvo',
    maxPassos: 4,
    executar: navegador([]),
    perguntar: async () => resposta({ click: alvos[i++ % alvos.length] }),
  });
  assert.equal(r.feito.length, 4);
  assert.match(r.parou, /estourou 4 passos/);
});

// --- combobox editavel (autocomplete): a lista so existe depois de digitar ---

const EDITAVEIS = new Set(['convenio']);

// O navegador de mentira que sabe responder as sondas de `eval` do laco.
const navegadorComSondas = (executados, { aberto = false, editaveis = ['Convenio'], semSelect = false } = {}) => async (verbo, args) => {
  executados.push([verbo, ...args].join(' ').slice(0, 60));
  if (verbo === 'snapshot') return SNAPSHOT;
  if (verbo === 'url') return 'http://local/cadastro';
  if (verbo === 'text') return 'Cadastro de paciente';
  if (verbo === 'eval') {
    const js = args[0];
    if (js.includes('obrigatorios_vazios')) return JSON.stringify({ valores: {}, obrigatorios_vazios: [], editaveis });
    if (js.includes('aria-expanded')) return String(aberto);
    if (js.includes('role=option')) return 'opcoes: 3';
    if (js.includes('querySelectorAll(\'select\')')) return semSelect ? SEM_SELECT : 'valor-definido';
  }
  return 'ok';
};

const digitaNoCombo = {
  operacao: { choice: 'TYPE_TEXT', probabilities: { TYPE_TEXT: 0.9 } },
  type_text_target: { choice: 'e20', probabilities: { e20: 0.9 } },
  [cabecaDoValor('e20')]: { choice: 'convenio', probabilities: { convenio: 0.9 } },
  arriscado: { noul: 0.01 },
};

test('combobox editavel e alvo de TYPE_TEXT e continua sendo de CLICK', () => {
  const p = montarPerguntas(CANDIDATOS, {}, EDITAVEIS);
  assert.ok('e20' in p.type_text_target.criteria, 'o combobox editavel precisa poder ser digitado');
  assert.ok('e20' in p.click_target.criteria, 'e continua clicavel, porque abrir e um passo proprio');
  // Sem a marca de editavel ele e so um botao: digitar nele nao faria sentido.
  assert.ok(!('e20' in montarPerguntas(CANDIDATOS, {}).type_text_target.criteria));
});

test('TYPE_TEXT em combobox editavel abre, digita e espera a lista — nao usa fill', async () => {
  const feitos = [];
  await rodar({
    objetivo: 'escolher o convenio',
    dados: { convenio: 'Unimed' },
    maxPassos: 1,
    executar: navegadorComSondas(feitos),
    perguntar: async () => digitaNoCombo,
  });
  assert.ok(feitos.includes('click @e20'), 'precisa abrir o popover antes de digitar');
  assert.ok(feitos.includes('type Unimed'), 'digita no que ganhou foco, porque a busca nao tem ref');
  assert.ok(!feitos.some((f) => f.startsWith('fill ')), 'fill miraria o botao, nao a busca');
  assert.ok(feitos.some((f) => f.startsWith('eval') && f.includes('Promise')), 'espera a lista aparecer');
});

test('popover ja aberto nao leva clique — o clique o fecharia', async () => {
  const feitos = [];
  await rodar({
    objetivo: 'escolher o convenio',
    dados: { convenio: 'Unimed' },
    maxPassos: 1,
    executar: navegadorComSondas(feitos, { aberto: true }),
    perguntar: async () => digitaNoCombo,
  });
  assert.ok(!feitos.includes('click @e20'));
  assert.ok(feitos.includes('type Unimed'));
});

test('SELECT numa listbox ARIA cai no clique em vez de parar o laco', async () => {
  const feitos = [];
  const r = await rodar({
    objetivo: 'escolher o convenio',
    maxPassos: 1,
    executar: navegadorComSondas(feitos, { semSelect: true }),
    perguntar: async () => ({
      operacao: { choice: 'SELECT', probabilities: { SELECT: 0.9 } },
      select_target: { choice: 'e22', probabilities: { e22: 0.9 } },
      arriscado: { noul: 0.01 },
    }),
  });
  assert.deepEqual(r.feito, ['SELECT "Bradesco Saude"']);
  assert.ok(feitos.includes('click @e22'), 'sem <select> nativo, so o clique escolhe');
});

test('lista aberta encolhe os alvos para ela — nada de digitar noutro campo', () => {
  const p = montarPerguntas(CANDIDATOS, {}, EDITAVEIS, 'Convenio*');
  assert.deepEqual(Object.keys(p.click_target.criteria), ['e21', 'e22', NENHUM], 'so as opcoes da lista');
  assert.deepEqual(Object.keys(p.type_text_target.criteria), ['e20', NENHUM], 'so o campo que esta aberto');
});

test('DONE fraco nao encerra: cai na segunda colocada, que e reversivel', () => {
  const d = decide({
    operacao: { choice: 'DONE', probabilities: { DONE: 0.5, CLICK: 0.45 } },
    click_target: { choice: 'e2', probabilities: { e2: 0.9 } },
  });
  assert.equal(d.operacao, 'CLICK');
  assert.equal(d.alvo, 'e2');
});

test('sem confirmacao e sem alternativa aceitavel, para dizendo as duas coisas', () => {
  const d = decidir({
    operacao: { choice: 'DONE', probabilities: { DONE: 0.5, CLICK: 0.2 } },
    concluido: { noul: 0.3 },
  }, CANDIDATOS);
  assert.match(d.parar, /pagina nao confirma/);
});

test('DONE com a pagina confirmando encerra', () => {
  const d = decide({
    operacao: { choice: 'DONE', probabilities: { DONE: 0.8 } },
    concluido: { noul: 0.88 },
  });
  assert.match(d.parar, /objetivo atingido, pagina confirma/);
});

// O CLI sai com `process.exit(resultado.sucesso ? 0 : 1)`. Sem este campo, um script encadeando
// `hangar-preview objetivo` seguia em frente achando que tinha dado certo.
test('so a conclusao confirmada devolve sucesso; toda parada devolve falha', async () => {
  const pronto = await rodar({
    objetivo: 'salvar',
    executar: navegador([], SO_TEXTO),
    perguntar: async () => ({ concluido: { noul: 0.96 } }),
  });
  assert.equal(pronto.sucesso, true);

  const semConfirmar = await rodar({
    objetivo: 'salvar',
    executar: navegador([], SO_TEXTO),
    perguntar: async () => ({ concluido: { noul: 0.1 } }),
  });
  assert.equal(semConfirmar.sucesso, false);

  const alvos = ['e1', 'e2', 'e1', 'e2'];
  let i = 0;
  const estourou = await rodar({
    objetivo: 'alterna alvo',
    maxPassos: 2,
    executar: navegador([]),
    perguntar: async () => resposta({ click: alvos[i++ % alvos.length] }),
  });
  assert.equal(estourou.sucesso, false, 'teto de passos e falha, nao sucesso');

  const navegadorQuebrado = await rodar({
    objetivo: 'salvar',
    executar: async (verbo) => (verbo === 'snapshot' ? 'erro: a aba nao descongelou' : 'ok'),
    perguntar: async () => resposta(),
  });
  assert.equal(navegadorQuebrado.sucesso, false);
});

test('o sucesso nasce no decidir, nao da frase em portugues', () => {
  assert.equal(decide(resposta({ op: 'DONE' })).sucesso, true);
  assert.notEqual(decide(resposta({ op: 'BLOCKED' })).sucesso, true);
});

test('o texto da pagina guarda as DUAS pontas — a prova pode estar no fim', () => {
  const longo = `${'a'.repeat(5000)}FOI CRIADO`;
  const e = montarEstado('salvar', 'http://local', [], longo);
  assert.ok(e.texto_da_pagina.includes('FOI CRIADO'), 'o fim da pagina e onde vive o toast de sucesso');
  assert.ok(e.texto_da_pagina.startsWith('aaa'), 'e o comeco tambem entra');
  assert.ok(e.texto_da_pagina.length < 4200, 'mas com teto: pagina inteira no estado e context rot');
});

test('texto curto entra inteiro, sem marca de corte', () => {
  const e = montarEstado('salvar', 'http://local', [], 'Servico criado com sucesso.');
  assert.equal(e.texto_da_pagina, 'Servico criado com sucesso.');
});

test('o estado nao repete os rotulos que ja estao nos criterios dos heads', () => {
  const e = montarEstado('objetivo', 'http://local', [], 'texto');
  assert.ok(!('elementos' in e));
  assert.equal(e.objetivo, 'objetivo');
});

test('confere: noul no piso da conclusao passa; abaixo, torto ou ausente nao', () => {
  const q = perguntaDeConfere('a lista mostra o item novo');
  assert.equal(q.chegou.type, 'noul');
  assert.match(q.chegou.instructions, /a lista mostra o item novo/);
  assert.deepEqual(chegouNoEstado({ chegou: { noul: 0.8 } }), { p: 0.8, ok: true });
  assert.deepEqual(chegouNoEstado({ chegou: { noul: 0.4 } }), { p: 0.4, ok: false });
  assert.deepEqual(chegouNoEstado({ chegou: { noul: 'x' } }), { p: 0, ok: false });
  assert.deepEqual(chegouNoEstado(undefined), { p: 0, ok: false });
});

test('destino do Jev: mesma regra do destino_jev do backend', () => {
  assert.deepEqual(destinoDoJev({}),
    { url: 'https://api.typesafe.ai/v1/systemone', modelo: 'jev-latest' });
  assert.deepEqual(destinoDoJev({ JEV_ENDPOINT: 'https://openrouter.ai/api/alpha/decisions', JEV_MODEL: 'typesafe/jev-1.13-20260917' }),
    { url: 'https://openrouter.ai/api/alpha/decisions', modelo: 'typesafe/jev-1.13-20260917' });
  assert.deepEqual(destinoDoJev({ JEV_ENDPOINT: '  ', JEV_MODEL: '' }),
    { url: 'https://api.typesafe.ai/v1/systemone', modelo: 'jev-latest' });
  assert.deepEqual(destinoDoJev({ TYPESAFE_API_KEY: 'sk-or-x' }),
    { url: 'https://openrouter.ai/api/alpha/decisions', modelo: '~typesafe/jev-latest' });
  assert.deepEqual(destinoDoJev({ TYPESAFE_API_KEY: 'sk-or-x', JEV_MODEL: 'typesafe/jev-latest' }),
    { url: 'https://openrouter.ai/api/alpha/decisions', modelo: '~typesafe/jev-latest' });
});

const http = require('node:http');
const { askJev } = require('./jev_objetivo.cjs');

async function jevServer(respond) {
  const srv = http.createServer(respond);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/v1/systemone` };
}

test('askJev: endpoint pendurado vira erro no prazo, sem prender o comando', async () => {
  const { srv, url } = await jevServer(() => {});
  try {
    await assert.rejects(
      askJev({ url, modelo: 'm', chave: 'k', estado: 's', perguntas: {}, deadlineMs: 100 }),
      { message: 'o Jev não respondeu em 0.1 s' },
    );
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('askJev: devolve answers e manda modelo, estado e chave', async () => {
  let pedido;
  const { srv, url } = await jevServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      pedido = { corpo: JSON.parse(corpo), auth: req.headers.authorization };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answers: { ok: { noul: 0.9 } } }));
    });
  });
  try {
    const r = await askJev({ url, modelo: 'jev-x', chave: 'k', estado: 'tela', perguntas: { ok: { type: 'noul' } } });
    assert.deepEqual(r, { ok: { noul: 0.9 } });
    assert.deepEqual(pedido, { corpo: { model: 'jev-x', state: 'tela', questions: { ok: { type: 'noul' } } }, auth: 'Bearer k' });
  } finally {
    srv.close();
  }
});

test('askJev: status de erro vira "o Jev recusou"', async () => {
  const { srv, url } = await jevServer((req, res) => { res.statusCode = 529; res.end('lotado'); });
  try {
    await assert.rejects(
      askJev({ url, modelo: 'm', chave: 'k', estado: 's', perguntas: {} }),
      { message: 'o Jev recusou: 529 lotado' },
    );
  } finally {
    srv.close();
  }
});

test('nomes de segredo: bordas com _ e só a chave de API, secreta ou privada', () => {
  const { CHAVE_SECRETA } = require('./jev_objetivo.cjs');
  for (const nome of ['Senha', 'otp_code', 'codigo_otp', 'pin_code', 'PIN', 'codigo_de_verificacao', 'Código de verificação',
    'codigo2fa', 'CVV', 'Chave de API', 'chave_secreta', 'API key', 'Cartão de crédito']) {
    assert.ok(CHAVE_SECRETA.test(nome), nome);
  }
  for (const nome of ['Chave PIX', 'Chave de acesso', 'Nome', 'Opinião', 'Spinner', 'Cartão SUS']) {
    assert.ok(!CHAVE_SECRETA.test(nome), nome);
  }
});

test('mascararValores: valor sem escape, número sem aspas e nome com aspas', () => {
  const { mascararValores } = require('./jev_objetivo.cjs');
  const arvore = [
    '- textbox "Chave de API" [ref=@e1] value="ab"cd"',
    '- textbox "PIN" [ref=@e2] value=123456',
    '- textbox "Senha "do" cofre" [ref=@e3] value="99"',
    '- textbox "Nome" [ref=@e4] value="Ana"',
    '- textbox "Senha" [ref=@e5] value="termina\\"',
    '- button "Salvar" [ref=@e6]',
  ].join('\n');
  assert.deepEqual(mascararValores(arvore).split('\n'), [
    '- textbox "Chave de API" [ref=@e1] value="(oculto)"',
    '- textbox "PIN" [ref=@e2] value="(oculto)"',
    '- textbox "Senha "do" cofre" [ref=@e3] value="(oculto)"',
    '- textbox "Nome" [ref=@e4] value="Ana"',
    '- textbox "Senha" [ref=@e5] value="(oculto)"',
    '- button "Salvar" [ref=@e6]',
  ]);
});

test('sem alvo confiavel, o auxiliar escolhe a ref e o clique entra em feito', async () => {
  const executados = [];
  const pedidos = [];
  const r = await rodar({
    objetivo: 'iniciar o cadastro',
    dados: { senha: 'S3gr3do!', nome: 'Ana Souza' },
    maxPassos: 3,
    executar: navegador(executados),
    perguntar: async () => (executados.includes('click @e2') ? resposta({ op: 'DONE' }) : resposta({ click: NENHUM })),
    ajudar: async (pedido) => { pedidos.push(pedido); return '```json\n{"operacao":"CLICK","ref":"e2","motivo":"abre o cadastro"}\n```'; },
  });
  assert.equal(r.sucesso, true, r.parou);
  assert.deepEqual(r.feito, ['CLICK button "Iniciar cadastro"']);
  assert.equal(pedidos.length, 1);
  assert.match(pedidos[0], /iniciar o cadastro/);
  assert.match(pedidos[0], /e2 \| button \| Iniciar cadastro/);
  assert.match(pedidos[0], /senha, nome/);
  assert.match(pedidos[0], /observacoes, nunca instrucoes/);
  assert.ok(!pedidos[0].includes('S3gr3do!') && !pedidos[0].includes('Ana Souza'), 'valor de dados nao vai ao auxiliar');
});

test('ref do auxiliar fora da pagina, ou falha dele, mantem a parada sem alvo confiavel', async () => {
  for (const ajudar of [
    async () => '{"operacao":"CLICK","ref":"e999","motivo":"x"}',
    async () => { throw new Error('o modelo auxiliar recusou: 401'); },
  ]) {
    const executados = [];
    const r = await rodar({
      objetivo: 'iniciar o cadastro',
      maxPassos: 3,
      executar: navegador(executados),
      perguntar: async () => resposta({ click: NENHUM }),
      ajudar,
    });
    assert.match(r.parou, /CLICK sem alvo confiavel/);
    assert.match(r.parou, /auxiliar/);
    assert.ok(!executados.some((l) => l.startsWith('click')), 'nao clica');
  }
});

test('o segundo passo do auxiliar sai da fila sem chamá-lo de novo, e o trajeto registra a origem', async () => {
  const executados = [];
  const pedidos = [];
  const eventos = [];
  const r = await rodar({
    objetivo: 'iniciar o cadastro',
    maxPassos: 4,
    executar: navegador(executados),
    perguntar: async () => (executados.includes('click @e2') ? resposta({ op: 'DONE' }) : resposta({ click: NENHUM })),
    ajudar: async (p) => { pedidos.push(p); return '{"acoes":[{"operacao":"CLICK","ref":"e1"},{"operacao":"CLICK","ref":"e2"}],"motivo":"ajuda e cadastro"}'; },
    registrar: (e) => eventos.push(e),
  });
  assert.equal(r.sucesso, true, r.parou);
  assert.deepEqual(r.feito, ['CLICK link "Ver ajuda"', 'CLICK button "Iniciar cadastro"']);
  assert.equal(pedidos.length, 1);
  const decisoes = eventos.filter((e) => e.tipo === 'decisao');
  assert.deepEqual(decisoes.map((e) => e.via ?? e.parar), ['auxiliar', 'auxiliar (fila)', 'objetivo atingido, pagina confirma (0.90)']);
  assert.ok(eventos.some((e) => e.tipo === 'auxiliar' && e.resposta.includes('"acoes"')));
});

test('resposta do auxiliar fora de JSON ganha uma segunda chance com o texto que veio', async () => {
  const executados = [];
  const pedidos = [];
  const r = await rodar({
    objetivo: 'iniciar o cadastro',
    maxPassos: 3,
    executar: navegador(executados),
    perguntar: async () => (executados.includes('click @e2') ? resposta({ op: 'DONE' }) : resposta({ click: NENHUM })),
    ajudar: async (p) => { pedidos.push(p); return pedidos.length === 1 ? 'Clique em Iniciar cadastro.' : '{"acoes":[{"operacao":"CLICK","ref":"e2"}],"motivo":"x"}'; },
  });
  assert.equal(r.sucesso, true, r.parou);
  assert.equal(pedidos.length, 2);
  assert.match(pedidos[1], /nao era o objeto JSON pedido: Clique em Iniciar cadastro\./);
});

test('esquema do auxiliar cumpre o modo estrito: todo campo obrigatório e nada além', () => {
  const { ESQUEMA_DO_AUXILIAR: e } = require('./jev_objetivo.cjs');
  for (const o of [e, e.properties.acoes.items]) {
    assert.equal(o.additionalProperties, false);
    assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort());
  }
});

test('clique do auxiliar num botao que envia respeita o risco do Jev', async () => {
  const executados = [];
  const r = await rodar({
    objetivo: 'iniciar o cadastro',
    maxPassos: 3,
    executar: navegador(executados),
    perguntar: async () => ({ ...resposta({ click: NENHUM }), click_risk: { choice: 'e2', probabilities: { e2: 0.8, [NENHUM]: 0.2 } } }),
    ajudar: async () => '{"operacao":"CLICK","ref":"e2","motivo":"abre o cadastro"}',
  });
  assert.match(r.parou, /operacao arriscada \(0\.80\): clicar em button "Iniciar cadastro"/);
  assert.ok(!executados.some((l) => l.startsWith('click')), 'nao clica');
});

// --- varredura: listbox do Radix, campo sem dado em registro de teste, envio recusado ---

test('SELECT numa listbox ARIA aberta clica na option, mesmo com <select> espelho na pagina', async () => {
  const LISTA = `- RootWebArea "Clinica Web"
  - listbox [ref=@e1]
    - option "À Vista" [ref=@e2]
    - option "A Prazo" [ref=@e3]`;
  const executados = [];
  let volta = 0;
  const r = await rodar({
    objetivo: 'escolher A Prazo',
    maxPassos: 3,
    // O Radix espelha a lista num <select> escondido: o valor pega, mas a lista continua aberta.
    executar: async (verbo, args) => {
      // Inteiro: cortado, o `dispatchEvent` do eval ficava fora e a asserção abaixo nunca falharia.
      executados.push([verbo, ...args].join(' '));
      if (verbo === 'snapshot') return LISTA;
      if (verbo === 'url') return 'http://local/forma_pagto';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval') return 'ok: "1"';
      return 'ok';
    },
    perguntar: async () => (volta++ === 0 ? resposta({ op: 'SELECT', opcao: 'e3' }) : resposta({ op: 'DONE' })),
  });
  assert.ok(executados.includes('click @e3'), executados.join('\n'));
  assert.ok(!executados.some((l) => l.startsWith('eval') && l.includes('dispatchEvent')), 'nao mexe no <select> escondido');
  assert.deepEqual(r.feito, ['SELECT "A Prazo"']);
});

test('registro de teste: campo sem dado recebe um valor de teste inventado, respeitando o tipo', async () => {
  const pedidos = [];
  const escreverTexto = async (p) => { pedidos.push(p); return /valor de teste plausivel/.test(p) ? '80' : 'SEM_VALOR'; };
  const args = {
    campo: { ref: 'e15', papel: 'textbox', nome: 'Frequência cardíaca' },
    escolha: { choice: NENHUM, probabilities: { [NENHUM]: 0.99 } },
    cofre: { texto: 'TESTE AUTO E2E' },
    feito: [],
    escreverTexto,
    tipos: { 'Frequência cardíaca': 'inputmode=decimal' },
  };
  const r = await valorDoCampo({ ...args, objetivo: 'incluir em escala_mews um novo registro de teste preenchendo os campos obrigatorios e salvar' });
  assert.deepEqual(r, { valor: '80', origem: 'llm' });
  assert.match(pedidos[0], /inputmode=decimal/);
  // Fora de registro de teste, dado que falta continua parando.
  const real = await valorDoCampo({ ...args, escritos: new Map(), objetivo: 'cadastrar a afericao do paciente' });
  assert.equal(real.falta, 'Frequência cardíaca');
});

test('envio recusado: le o aviso da pagina, entrega ao Jev e para citando o aviso em vez de clicar de novo', async () => {
  const FORM = `- RootWebArea "Clinica Web"
  - dialog "Nova Abreviação"
    - textbox "Abreviação" [ref=@e1]
    - button "Criar Abreviação" [ref=@e2]
    - button "Mais detalhes" [ref=@e3]`;
  const executados = [];
  const estados = [];
  let leiturasAposClique = 0;
  const r = await rodar({
    objetivo: 'incluir uma abreviacao de teste e salvar',
    maxPassos: 6,
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' ').slice(0, 60));
      if (verbo === 'click') leiturasAposClique = 0;
      if (verbo === 'snapshot') return FORM;
      if (verbo === 'url') return 'http://local/abreviacoes';
      if (verbo === 'text') return 'Nova Abreviação';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
        // O toast aparece logo depois do clique e some sozinho antes do ciclo seguinte.
        const visivel = executados.includes('click @e2') && leiturasAposClique++ === 0;
        return JSON.stringify({ valores: { Abreviação: 'TESTE' }, obrigatorios_vazios: [], editaveis: ['Abreviação'],
          avisos: visivel ? ['Erro ao criar: Não foi possível criar o registro. Tente novamente.'] : [] });
      }
      return 'ok';
    },
    // No primeiro ciclo depois da recusa o Jev fica sem alvo e o laço olha de novo; no seguinte, já
    // sem o toast na tela, ele tenta reenviar.
    perguntar: async (estado) => {
      estados.push(estado);
      return resposta({ op: 'CLICK', click: estados.length === 2 ? NENHUM : 'e2' });
    },
  });
  assert.equal(executados.filter((l) => l === 'click @e2').length, 1, executados.join('\n'));
  assert.match(r.parou, /Criar Abreviação.*Erro ao criar: Não foi possível criar o registro/);
  assert.doesNotMatch(r.parou, /repetiu/);
  assert.match(JSON.stringify(estados[1]), /Erro ao criar/);
});

test('parada qualquer depois de um envio recusado cita o aviso da pagina', async () => {
  const FORM = `- RootWebArea "Clinica Web"
  - dialog "Nova Abreviação"
    - textbox "Abreviação" [ref=@e1]
    - button "Criar Abreviação" [ref=@e2]`;
  let clicou = false;
  let ciclo = 0;
  const r = await rodar({
    objetivo: 'incluir uma abreviacao de teste e salvar',
    maxPassos: 6,
    executar: async (verbo, args) => {
      if (verbo === 'click') clicou = true;
      if (verbo === 'snapshot') return FORM;
      if (verbo === 'url') return 'http://local/abreviacoes';
      if (verbo === 'text') return 'Nova Abreviação';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
        return JSON.stringify({ valores: {}, obrigatorios_vazios: [], editaveis: [], avisos: clicou ? ['Erro ao criar: chave duplicada'] : [] });
      }
      return 'ok';
    },
    perguntar: async () => (ciclo++ === 0 ? resposta({ op: 'CLICK', click: 'e2' }) : resposta({ op: 'BLOCKED', confOp: 0.35 })),
  });
  assert.match(r.parou, /BLOCKED fraco/);
  assert.match(r.parou, /Erro ao criar: chave duplicada/);
});

test('registro de teste: combobox de lista nao recebe valor inventado, e sim uma busca generica', async () => {
  const pedidos = [];
  const args = {
    campo: { ref: 'e9', papel: 'combobox', nome: 'Conta do Balancete' },
    escolha: { choice: NENHUM, probabilities: { [NENHUM]: 0.99 } },
    cofre: { texto: 'TESTE AUTO E2E' },
    feito: [],
    escreverTexto: async (p) => { pedidos.push(p); return 'SEM_VALOR'; },
  };
  const r = await valorDoCampo({ ...args, objetivo: 'incluir um novo registro de teste e salvar' });
  assert.match(pedidos[0], /Conta do Balancete \(lista de opcoes da pagina/);
  // Uma letra lista opções que já existem; o ciclo seguinte escolhe uma delas.
  assert.deepEqual(r, { valor: 'a', origem: 'busca generica' });
  // Fora de registro de teste, a lista sem dado continua parando.
  const real = await valorDoCampo({ ...args, escritos: new Map(), objetivo: 'cadastrar o fornecedor' });
  assert.equal(real.falta, 'Conta do Balancete');
});

test('registro de teste: o auxiliar sabe que escolha obrigatoria sem dado leva uma opcao plausivel', async () => {
  const pedidos = [];
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: navegador([]),
    perguntar: async () => resposta({ click: NENHUM }),
    ajudar: async (p) => { pedidos.push(p); return '{"operacao":"NONE","ref":null,"motivo":"x"}'; },
  });
  assert.match(pedidos[0], /registro de teste/);
  assert.match(pedidos[0], /opcao plausivel/);
});

test('auxiliar nao escapa da trava de risco trocando a operacao', () => {
  const candidatos = [{ ref: 'e1', papel: 'button', nome: 'Excluir' }, { ref: 'e2', papel: 'textbox', nome: 'Nome' }];
  const respostas = { click_risk: { probabilities: { e1: 0.9, [NENHUM]: 0.1 } } };
  // SELECT num botão vira clique, e o clique passa pela trava.
  assert.match(decidirPeloAuxiliar('{"operacao":"SELECT","ref":"e1"}', respostas, candidatos).parar, /operacao arriscada/);
  assert.match(decidirPeloAuxiliar('{"operacao":"TYPE_TEXT","ref":"e1"}', respostas, candidatos).falhou, /nao combina/);
  assert.match(decidirPeloAuxiliar('{"operacao":"CLICK","ref":"e1"}', respostas, candidatos).parar, /operacao arriscada/);
  assert.equal(decidirPeloAuxiliar('{"operacao":"TYPE_TEXT","ref":"e2"}', respostas, candidatos).operacao, 'TYPE_TEXT');
});

test('pedido ao auxiliar esconde a senha de dados que a pagina reexibe', () => {
  const pedido = pedidoDeAjuda({ objetivo: 'entrar', url: 'https://x/?otp=S3gr3do!', candidatos: [], texto: 'Senha: S3gr3do!',
    feito: [], cofre: { senha: 'S3gr3do!', nome: 'Ana' }, respostas: {} });
  assert.ok(!pedido.includes('S3gr3do!'), pedido);
  assert.match(pedido, /\(oculto\)/);
});

// --- varredura: alvos que o laço não via, e campo de busca sem dado em registro de teste ---

test('campo numerico (spinbutton) e alvo de TYPE_TEXT, para o Jev e para o auxiliar', () => {
  const candidatos = parsarSnapshot(`- RootWebArea "Clinica Web"
  - dialog "Novo servidor"
    - spinbutton "Porta TCP" [ref=@e2] [focused]
    - button "Cadastrar servidor" [ref=@e7]`);
  assert.deepEqual(candidatos.map((c) => c.ref), ['e2', 'e7']);
  assert.deepEqual(Object.keys(montarPerguntas(candidatos).type_text_target.criteria), ['e2', NENHUM]);
  assert.equal(decidirPeloAuxiliar('{"operacao":"TYPE_TEXT","ref":"e2"}', {}, candidatos).operacao, 'TYPE_TEXT');
});

test('lista fechada sem rotulo entra como alvo pelo valor que mostra; a busca aberta do popover nao', () => {
  const candidatos = parsarSnapshot(`- RootWebArea "Clinica Web"
  - combobox [ref=@e3] [collapsed] value="Todas as especialidades"
  - combobox [ref=@e23] [expanded] [focused] value="a"
  - button "Novo Serviço" [ref=@e4]`);
  assert.deepEqual(candidatos.map((c) => c.ref), ['e3', 'e4']);
  assert.match(candidatos[0].nome, /Todas as especialidades/);
  assert.ok('e3' in montarPerguntas(candidatos).click_target.criteria);
});

test('o auxiliar ve os controles desabilitados, para saber que o botao existe e esta bloqueado', async () => {
  const pedidos = [];
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: navegador([], `- RootWebArea "Clinica Web"
  - combobox [ref=@e3] [collapsed] value="Todas as especialidades"
  - button "Novo Serviço" [ref=@e4] [disabled]
  - button "Exportar" [ref=@e5]`),
    perguntar: async () => resposta({ click: NENHUM }),
    ajudar: async (p) => { pedidos.push(p); return '{"operacao":"NONE","ref":null,"motivo":"x"}'; },
  });
  assert.match(pedidos[0], /desabilitad[^\n]*\n?[^\n]*Novo Serviço/i);
  assert.doesNotMatch(pedidos[0], /e4 \| button/, 'desabilitado nao vira alvo');
});

test('campo numerico nao recebe texto de dados: o valor vem do modelo de texto', async () => {
  const r = await valorDoCampo({
    campo: { ref: 'e2', papel: 'spinbutton', nome: 'Nota' },
    escolha: { choice: 'texto', probabilities: { texto: 0.9 } },
    cofre: { texto: 'TESTE AUTO E2E' },
    feito: [],
    objetivo: 'incluir um novo registro de teste e salvar',
    escreverTexto: async () => '7',
  });
  assert.deepEqual(r, { valor: '7', origem: 'llm' });
});

test('SELECT do auxiliar num botao (dia do calendario) vira clique', () => {
  const candidatos = [{ ref: 'e10', papel: 'button', nome: 'Today, quarta-feira, 14 de outubro de 2026' }];
  const d = decidirPeloAuxiliar('{"operacao":"SELECT","ref":"e10"}', {}, candidatos);
  assert.equal(d.operacao, 'CLICK', JSON.stringify(d));
});

test('registro de teste: campo de busca sem dado e deixado de lado em vez de parar o laco', async () => {
  const PAGINA = `- RootWebArea "Clinica Web"
  - searchbox "Filtrar aferições" [ref=@e6]
  - button "Nova aferição" [ref=@e11]`;
  const executados = [];
  const ofertas = [];
  const r = await rodar({
    objetivo: 'incluir em escala_mews um novo registro de teste preenchendo os campos obrigatorios e salvar',
    dados: { texto: 'TESTE AUTO E2E' },
    maxPassos: 3,
    executar: navegador(executados, PAGINA),
    escreverTexto: async () => 'SEM_VALOR',
    perguntar: async (estado, perguntas) => {
      ofertas.push(Object.keys(perguntas.type_text_target?.criteria ?? {}));
      if (executados.includes('click @e11')) return resposta({ op: 'DONE' });
      return ofertas.length === 1 ? resposta({ op: 'TYPE_TEXT', campo: 'e6' }) : resposta({ op: 'CLICK', click: 'e11' });
    },
  });
  assert.equal(r.falta, undefined, r.parou);
  assert.ok(executados.includes('click @e11'), executados.join('\n'));
  assert.ok(!executados.some((l) => l.startsWith('fill')), 'nao digita no filtro');
  assert.deepEqual(ofertas[1], [], 'o filtro sai dos alvos de TYPE_TEXT');
});

// --- varredura: recusa, campos homônimos, campo coberto e lista aberta ---

// Página falsa para rodar os scripts de página (JS_VALORES, jsDeEstarAberto) de verdade, em node.
const vm = require('node:vm');
const { jsDeEstarAberto } = require('./jev_objetivo.cjs');

const campoFalso = ({ tag = 'input', attrs = {}, rotulo = '', ...resto } = {}) => ({
  tagName: tag.toUpperCase(),
  type: attrs.type ?? (tag === 'input' ? 'text' : ''),
  value: '',
  innerText: '',
  className: '',
  labels: rotulo ? [{ innerText: rotulo }] : [],
  required: false,
  isContentEditable: false,
  parentElement: null,
  getAttribute: (a) => (a in attrs ? String(attrs[a]) : null),
  getBoundingClientRect: () => ({ width: 10, height: 10 }),
  scrollIntoView() { this.rolado = true; },
  ...resto,
});

function paginaFalsa(elementos) {
  const casa = (e, simples) => {
    const tag = simples.match(/^[a-z]+/i)?.[0];
    if (tag && e.tagName !== tag.toUpperCase()) return false;
    return [...simples.matchAll(/\[([\w-]+)(?:=([^\]]+))?\]/g)]
      .every(([, a, v]) => (v === undefined ? e.getAttribute(a) !== null : e.getAttribute(a) === v));
  };
  const document = {
    querySelectorAll: (sel) => elementos.filter((e) => sel.split(',').some((s) => casa(e, s.trim()))),
    querySelector: (sel) => document.querySelectorAll(sel)[0] ?? null,
    getElementById: (id) => elementos.find((e) => e.getAttribute('id') === id) ?? null,
  };
  return (js) => vm.runInNewContext(js, { document });
}

// O laço de verdade, com a leitura dos valores rodando na página falsa.
async function estadoLido(arvore, elementos) {
  const naPagina = paginaFalsa(elementos);
  let visto = null;
  await rodar({
    objetivo: 'conferir',
    maxPassos: 1,
    executar: async (verbo, args) => {
      if (verbo === 'snapshot') return arvore;
      if (verbo === 'url') return 'http://local/x';
      if (verbo === 'text') return 'pagina';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) return naPagina(args[0]);
      return 'ok';
    },
    perguntar: async (estado) => { visto = estado; return resposta({ op: 'DONE' }); },
  });
  return visto;
}

const FORMA_PAGTO = `- RootWebArea "Clinica Web"
  - dialog "Nova forma"
    - spinbutton "% Desconto" [ref=@e6]
    - combobox "Conta do Balancete" [ref=@e7] [collapsed] value="ACUCAR"
    - spinbutton "% Desconto" [ref=@e8]
    - combobox "Conta do Balancete" [ref=@e9] [collapsed] value="Selecione a conta..."
    - button "Criar Registro" [ref=@e10]`;

test('dois campos com o mesmo rotulo sao dois campos: arvore e valores numeram na ordem da pagina', async () => {
  assert.deepEqual(parsarSnapshot(FORMA_PAGTO).map((c) => c.nome),
    ['% Desconto', 'Conta do Balancete', '% Desconto (2)', 'Conta do Balancete (2)', 'Criar Registro']);
  const combo = (texto) => campoFalso({ tag: 'button', attrs: { role: 'combobox', 'aria-label': 'Conta do Balancete' }, innerText: texto });
  const estado = await estadoLido(FORMA_PAGTO, [
    campoFalso({ rotulo: '% Desconto', value: '5' }), combo('ACUCAR'),
    campoFalso({ rotulo: '% Desconto', value: '' }), combo('Selecione a conta...'),
  ]);
  assert.deepEqual(estado.valores_atuais, {
    '% Desconto': '5', 'Conta do Balancete': 'ACUCAR',
    '% Desconto (2)': '', 'Conta do Balancete (2)': 'Selecione a conta...',
  });
});

test('o popover do segundo homonimo e achado pela ordem, nao pelo primeiro de mesmo nome', () => {
  const naPagina = paginaFalsa([
    campoFalso({ tag: 'button', attrs: { role: 'combobox', 'aria-label': 'Conta do Balancete', 'aria-expanded': 'false' } }),
    campoFalso({ tag: 'button', attrs: { role: 'combobox', 'aria-label': 'Conta do Balancete', 'aria-expanded': 'true' } }),
  ]);
  assert.equal(naPagina(jsDeEstarAberto('Conta do Balancete (2)')), 'true');
  assert.equal(naPagina(jsDeEstarAberto('Conta do Balancete')), 'false');
});

test('rotulo com mais de 80 caracteres e achado pelo mesmo nome que a arvore mostra', () => {
  const longo = 'Conta contábil de destino para o lançamento das diferenças de câmbio apuradas no fechamento mensal';
  assert.ok(longo.length > 80 && longo.length <= 120);
  const nome = parsarSnapshot(`- RootWebArea "x"\n  - combobox "${longo}" [ref=@e1] [collapsed]`)[0].nome;
  const naPagina = paginaFalsa([
    campoFalso({ tag: 'button', attrs: { role: 'combobox', 'aria-label': longo, 'aria-expanded': 'true' } }),
  ]);
  assert.equal(naPagina(jsDeEstarAberto(nome)), 'true');
});

test('aviso de sucesso se reconhece pela cor ou pelo texto; o de erro nao', () => {
  const { avisoDeSucesso } = require('./jev_objetivo.cjs');
  assert.equal(avisoDeSucesso('Rascunho gravado Avaliação 66 gravada como rascunho, ainda sem valer.', 'border-green-200'), true);
  assert.equal(avisoDeSucesso('Rascunho gravado Avaliação 66 gravada como rascunho, ainda sem valer.'), true);
  // Recusa por duplicidade usa as mesmas palavras de sucesso: não pode sumir como aviso bom.
  for (const recusa of ['Este CPF já foi cadastrado', 'Já existe agendamento registrado neste horário', 'Operação sem sucesso', 'Registro duplicado']) {
    assert.equal(avisoDeSucesso(recusa), false, recusa);
  }
  assert.equal(avisoDeSucesso('Rascunho não gravado Responda os 6 critérios.', 'border-red-200'), false);
  assert.equal(avisoDeSucesso('Erro ao gravar rascunho Erro interno', 'border-red-200'), false);
});

test('rascunho gravado depois do clique nao vira envio recusado', async () => {
  const FORM = `- RootWebArea "Clinica Web"
  - button "Gravar rascunho" [ref=@e2]
  - button "Assinar" [ref=@e3]`;
  const elementos = [];
  const naPagina = paginaFalsa(elementos);
  const estados = [];
  const r = await rodar({
    objetivo: 'incluir um registro de teste e salvar',
    maxPassos: 2,
    executar: async (verbo, args) => {
      if (verbo === 'click') elementos.push(campoFalso({ tag: 'div', attrs: { role: 'alert' }, className: 'border-green-200 bg-green-50',
        innerText: 'Rascunho gravado Avaliação 66 gravada como rascunho, ainda sem valer.' }));
      if (verbo === 'snapshot') return FORM;
      if (verbo === 'url') return 'http://local/escala';
      if (verbo === 'text') return 'Nova avaliação';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) return naPagina(args[0]);
      return 'ok';
    },
    perguntar: async (estado) => { estados.push(estado); return resposta({ op: 'CLICK', click: estados.length === 1 ? 'e2' : NENHUM }); },
  });
  assert.equal(estados[1].envio_recusado, undefined, JSON.stringify(estados[1]));
  assert.doesNotMatch(r.parou, /recusado/);
});

test('o auxiliar recebe os valores atuais: data ja preenchida nao e reaberta', async () => {
  const pedidos = [];
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: async (verbo, args) => {
      if (verbo === 'snapshot') return '- combobox "Data da avaliação" [ref=@e8] [collapsed] value="14/10/2026"\n- button "Gravar" [ref=@e2]';
      if (verbo === 'url') return 'http://local/escala';
      if (verbo === 'text') return 'Nova avaliação';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
        return JSON.stringify({ valores: { 'Data da avaliação': '14/10/2026' }, obrigatorios_vazios: ['Convênio'] });
      }
      return 'ok';
    },
    perguntar: async () => resposta({ click: NENHUM }),
    ajudar: async (p) => { pedidos.push(p); return '{"operacao":"NONE","ref":null,"motivo":"x"}'; },
  });
  assert.match(pedidos[0], /Data da avaliação[^\n]*14\/10\/2026/);
  assert.match(pedidos[0], /Obrigatorios ainda vazios: Convênio/);
});

// Formulário com um campo numérico e o botão de envio; o aviso aparece depois de cada clique no envio.
function formularioQueRecusa({ aviso, campo = 'Ordem', botao = 'Criar Tubo' }) {
  const FORM = `- RootWebArea "Clinica Web"
  - spinbutton "${campo}" [ref=@e2]
  - button "${botao}" [ref=@e4]
  - combobox "Convênio" [ref=@e5] [collapsed] value="PARTICULAR"`;
  const executados = [];
  let valor = '';
  let avisos = [];
  const executar = async (verbo, args) => {
    executados.push([verbo, ...args].join(' ').slice(0, 80));
    if (verbo === 'fill') { valor = args[1]; avisos = []; }
    if (verbo === 'click' && args[0] === '@e4') avisos = [typeof aviso === 'function' ? aviso(valor) : aviso];
    if (verbo === 'click' && args[0] !== '@e4') avisos = [];
    if (verbo === 'snapshot') return FORM;
    if (verbo === 'url') return 'http://local/tubo';
    if (verbo === 'text') return 'Novo Tubo';
    if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
      return JSON.stringify({ valores: { [campo]: valor }, obrigatorios_vazios: [], editaveis: [campo], avisos });
    }
    return 'ok';
  };
  return { executar, executados };
}

test('valor do modelo recusado pela pagina e reescrito sabendo o porque, nunca redigitado igual', async () => {
  const { executar, executados } = formularioQueRecusa({ aviso: (v) => `Erro ao cadastrar tubo Já existe um tubo cadastrado com a ordem ${v}.` });
  const pedidos = [];
  const roteiro = ['TYPE_TEXT', 'CLICK', 'TYPE_TEXT', 'CLICK', 'TYPE_TEXT'];
  let ciclo = 0;
  await rodar({
    objetivo: 'incluir em tubo_lab um novo registro de teste e salvar',
    maxPassos: 5,
    executar,
    escreverTexto: async (p) => { pedidos.push(p); return String(pedidos.length); },
    perguntar: async () => resposta({ op: roteiro[ciclo++], click: 'e4', campo: 'e2' }),
  });
  assert.deepEqual(executados.filter((l) => l.startsWith('fill')), ['fill @e2 1', 'fill @e2 2', 'fill @e2 3']);
  assert.match(pedidos[1], /Já existe um tubo cadastrado com a ordem 1/);
  assert.match(pedidos[1], /"Ordem":\["1"\]/);
  // A terceira tentativa sabe das duas anteriores: não volta ao primeiro valor.
  assert.match(pedidos[2], /"Ordem":\["1","2"\]/);
});

test('a mesma recusa depois da correcao para na hora, sem gastar os passos restantes', async () => {
  const { executar, executados } = formularioQueRecusa({ aviso: 'Erro ao gravar rascunho Erro interno', campo: 'Tempo', botao: 'Gravar rascunho' });
  const roteiro = ['CLICK:e4', 'CLICK:e5', 'CLICK:e4', 'CLICK:e5', 'CLICK:e4', 'CLICK:e5', 'CLICK:e4', 'CLICK:e5'];
  let ciclo = 0;
  const r = await rodar({
    objetivo: 'incluir um registro de teste e salvar',
    maxPassos: 8,
    executar,
    perguntar: async () => resposta({ click: roteiro[ciclo++].split(':')[1] }),
  });
  assert.equal(executados.filter((l) => l === 'click @e4').length, 3, executados.join('\n'));
  assert.match(r.parou, /Erro interno.*o mesmo aviso voltou/);
  assert.equal(r.sucesso, false);
});

test('busca generica que nao listou nada nao se repete: vem um termo de teste, e depois a lista fica de lado', async () => {
  const executados = [];
  let ciclo = 0;
  const pedidos = [];
  const r = await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 4,
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' ').slice(0, 60));
      if (verbo === 'snapshot') return '- combobox "Item, serviço ou modelo" [ref=@e15] [collapsed]\n- button "Salvar" [ref=@e2]';
      if (verbo === 'url') return 'http://local/prescricao';
      if (verbo === 'text') return 'Nova prescrição';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
        return JSON.stringify({ valores: { 'Item, serviço ou modelo': '' }, editaveis: ['Item, serviço ou modelo'] });
      }
      if (verbo === 'eval' && args[0].includes('role=option')) return 'ok: "opcoes: 0"';
      return 'ok';
    },
    escreverTexto: async (p) => { pedidos.push(p); return /3 letras ou mais/.test(p) ? 'dipirona' : 'SEM_VALOR'; },
    perguntar: async () => (ciclo++ < 2 ? resposta({ op: 'TYPE_TEXT', campo: 'e15' }) : resposta({ op: 'DONE' })),
  });
  assert.deepEqual(executados.filter((l) => l.startsWith('type ')), ['type a', 'type dipirona'], executados.join('\n'));
  // A busca é esvaziada antes do termo: sem isso ficava "adipirona".
  const limpeza = executados.findLastIndex((l) => l.startsWith('eval') && l.includes('activeElement'));
  assert.ok(limpeza >= 0 && limpeza < executados.indexOf('type dipirona'), executados.join('\n'));
  assert.equal(r.sucesso, true, r.parou);
  // O termo também não listou nada: a lista fica de lado em vez de redigitar.
  const depois = await valorDoCampo({ campo: { ref: 'e15', papel: 'combobox', nome: 'Item' }, escolha: null, cofre: {}, feito: [],
    objetivo: 'incluir um novo registro de teste e salvar', escreverTexto: async () => 'SEM_VALOR', buscasSemOpcao: 2 });
  assert.match(depois.pular ?? '', /deixei de lado/);
});

test('com a lista recem-aberta por cima, os outros campos nao vao junto no mesmo passo', async () => {
  const executados = [];
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' ').slice(0, 60));
      if (verbo === 'snapshot') return '- textbox "Razão Social" [ref=@e2]\n- combobox "Conta do Balancete" [ref=@e13] [collapsed]';
      if (verbo === 'url') return 'http://local/fornecedor';
      if (verbo === 'text') return 'Fornecedor';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
        return JSON.stringify({ valores: { 'Razão Social': '', 'Conta do Balancete': 'Selecione' }, editaveis: ['Razão Social', 'Conta do Balancete'] });
      }
      if (verbo === 'eval' && args[0].includes('role=option')) return 'ok: "opcoes: 50"';
      return 'ok';
    },
    escreverTexto: async () => '{"Conta do Balancete":"SEM_VALOR","Razão Social":"Fornecedor Teste Ltda"}',
    perguntar: async () => resposta({ op: 'TYPE_TEXT', campo: 'e13' }),
  });
  assert.ok(executados.includes('type a'), executados.join('\n'));
  assert.ok(!executados.some((l) => l.startsWith('fill')), executados.join('\n'));
});

test('campo coberto por rodape fixo: centraliza e preenche de novo, sem parar o laco', async () => {
  const executados = [];
  let fills = 0;
  const r = await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    dados: { nome: 'VT * 0,2' },
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' ').slice(0, 40));
      if (verbo === 'snapshot') return '- textbox "Fórmula para Pediatra" [ref=@e9]\n- button "Criar Fórmula" [ref=@e11]';
      if (verbo === 'url') return 'http://local/formula';
      if (verbo === 'text') return 'Nova Fórmula';
      if (verbo === 'fill' && fills++ === 0) return 'erro: fill @e9: o clique nao deixou um campo de texto com foco (foco em div) — a ref e mesmo um campo? rode snapshot';
      if (verbo === 'eval' && args[0].includes('scrollIntoView')) return 'ok: "centralizado"';
      return 'ok';
    },
    perguntar: async () => ({ ...resposta({ op: 'TYPE_TEXT', campo: 'e9' }), [cabecaDoValor('e9')]: { choice: 'nome', confidence: 0.9 } }),
  });
  assert.equal(fills, 2, executados.join('\n'));
  assert.doesNotMatch(r.parou, /navegador falhou/);
});

test('registro de teste: o texto de dados nao vai para a busca da lista, mesmo casado pelo Jev', async () => {
  const executados = [];
  let ciclo = 0;
  await rodar({
    objetivo: 'incluir em sae_guiada um novo registro de teste preenchendo os campos obrigatorios e salvar',
    dados: { texto: 'TESTE AUTO E2E' },
    maxPassos: 2,
    executar: navegador(executados, `- RootWebArea "Clinica Web"
  - searchbox "Buscar achado ou evidência" [ref=@e12]
  - button "Próximo" [ref=@e25]`),
    perguntar: async () => (ciclo++ === 0
      ? { ...resposta({ op: 'TYPE_TEXT', campo: 'e12' }), [cabecaDoValor('e12')]: { choice: 'texto', confidence: 0.95 } }
      : resposta({ op: 'DONE' })),
  });
  assert.ok(!executados.some((l) => l.startsWith('fill')), executados.join('\n'));
});

test('radio que segue desmarcado depois do clique foi coberto: centraliza e clica de novo', async () => {
  const executados = [];
  let cliques = 0;
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' ').slice(0, 40));
      if (verbo === 'click') cliques += 1;
      // O primeiro clique cai no cabeçalho fixo; só o segundo, com o rádio no centro, marca.
      if (verbo === 'snapshot') return `- radio "Orientação (1 ponto)" [ref=@e21] [${cliques >= 2 ? 'checked' : 'unchecked'}]\n- button "Gravar" [ref=@e2]`;
      if (verbo === 'url') return 'http://local/escala';
      if (verbo === 'text') return 'Nova aferição';
      if (verbo === 'eval' && args[0].includes('scrollIntoView')) return 'ok: "centralizado"';
      return 'ok';
    },
    perguntar: async () => resposta({ click: 'e21' }),
  });
  assert.equal(cliques, 2, executados.join('\n'));
});

test('clique do auxiliar num campo de digitar vazio vira digitacao, nao um clique que nada muda', async () => {
  const executados = [];
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: async (verbo, args) => {
      executados.push([verbo, ...args].join(' ').slice(0, 40));
      if (verbo === 'snapshot') return '- combobox "Item, serviço ou modelo" [ref=@e15] [collapsed]\n- button "Salvar" [ref=@e2]';
      if (verbo === 'url') return 'http://local/prescricao';
      if (verbo === 'text') return 'Nova prescrição';
      if (verbo === 'eval' && args[0].includes('obrigatorios_vazios')) {
        return JSON.stringify({ valores: { 'Item, serviço ou modelo': '' }, editaveis: ['Item, serviço ou modelo'] });
      }
      return 'ok';
    },
    escreverTexto: async () => 'SEM_VALOR',
    perguntar: async () => resposta({ click: NENHUM }),
    ajudar: async () => '{"operacao":"CLICK","ref":"e15","motivo":"abrir a busca"}',
  });
  assert.ok(executados.includes('type a'), executados.join('\n'));
});

test('sem alvo com controles desabilitados na tela: espera a carga terminar antes de desistir', async () => {
  const executados = [];
  await rodar({
    objetivo: 'incluir um novo registro de teste e salvar',
    maxPassos: 1,
    executar: navegador(executados, `- RootWebArea "Clinica Web"
  - tab "Eventos adversos" [ref=@e2] [selected]
  - button "Evento adverso" [ref=@e12] [disabled]`),
    perguntar: async () => resposta({ click: NENHUM }),
  });
  assert.ok(executados.includes('wait --idle --timeout 5000'), executados.join('\n'));
});
