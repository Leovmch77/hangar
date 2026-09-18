// main.cjs requer 'electron' (que fora do binário do Electron não é um módulo utilizável — ver
// node_modules/electron/index.js) e sobe janela/servidor real no boot. Pra exercitar a guarda de
// identidade do item 1 sem nada disso: hijack do require.cache ANTES de exigir main.cjs, trocando
// 'electron' por um mock mínimo e o `criarControlador` de preview_ctl.cjs por uma fábrica que
// devolve controladores espiáveis (`fechado`). requestSingleInstanceLock() devolve false, então o
// branch de whenReady/criarJanela/subirServidor nunca roda — só os handlers de IPC (registrados
// ANTES da trava) importam aqui, que é onde soltarControlador vive.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// gravarSidecarNav (fire-and-forget dentro do handler nav-open) escreve em ~/.hangar/nav — sem
// isolar o HOME antes do require, o teste sujaria o diretório real do usuário.
const homeOriginal = process.env.HOME;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-main-test-'));
test.after(() => { process.env.HOME = homeOriginal; });

const criadas = [];
// Trilha compartilhada com o webContents falso: navegar uma aba CONGELADA derruba a sessão do
// depurador, então a ORDEM entre acordar e o `loadURL` é o contrato, não só o fato de acordar.
const trilha = [];
function criarControladorFalso(opcoes) {
  const c = { enfileirar: (fn) => fn(), fechado: false, opcoes, ocultos: [] };
  c.fechar = () => { c.fechado = true; };
  c.definirOculto = async (v) => { c.ocultos.push(v); };
  c.recongelar = async () => {};
  c.navegando = async (v) => { trilha.push(`navegando:${v}`); };
  criadas.push(c);
  return c;
}
const previewCtlPath = require.resolve('./preview_ctl.cjs');
require.cache[previewCtlPath] = {
  id: previewCtlPath, filename: previewCtlPath, loaded: true,
  exports: { criarControlador: criarControladorFalso },
};

const EVENTOS_CARGA = new Set(['did-finish-load', 'did-stop-loading']);

function criarWebContentsFalso() {
  // `url` começa vazia como no view recém-criado; dispararLoad() simula o fim da carga.
  const estado = { url: '', titulo: '', morto: false, focos: 0, navegando: false, ouvintes: {}, ouvintesLoad: [] };
  const dbg = {
    attached: false,
    isAttached: () => dbg.attached,
    attach: () => { dbg.attached = true; },
    detach: () => { dbg.attached = false; },
    sendCommand: async () => ({}),
    on: () => {},
  };
  return {
    setUserAgent: () => {}, getUserAgent: () => 'UA',
    setWindowOpenHandler: () => {}, getURL: () => estado.url,
    // Como no Electron: a navegação já está em voo quando o loadURL volta, e o getURL ainda
    // devolve a URL ANTIGA até a página nova comprometer.
    loadURL: async () => { trilha.push('loadURL'); estado.navegando = true; },
    isLoadingMainFrame: () => estado.navegando,
    capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) }),
    close: () => {}, isDestroyed: () => estado.morto === true,
    getTitle: () => estado.titulo,
    isLoading: () => false,
    focus: () => { estado.focos++; },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setTitulo: (t) => { estado.titulo = t; },
    on: (ev, cb) => { (estado.ouvintes[ev] ||= []).push(cb); if (EVENTOS_CARGA.has(ev)) estado.ouvintesLoad.push(cb); },
    once: (ev, cb) => { (estado.ouvintes[ev] ||= []).push(cb); if (EVENTOS_CARGA.has(ev)) estado.ouvintesLoad.push(cb); },
    removeListener: () => {},
    emitir: (ev, ...a) => (estado.ouvintes[ev] || []).forEach((cb) => cb(...a)),
    dispararLoad: () => {
      estado.url = 'https://z.test/';
      estado.navegando = false;
      estado.ouvintesLoad.splice(0).forEach((cb) => cb());
    },
    // Alvo derrubado por fora (Target.closeTarget via CDP, crash do renderer): ninguém chamou
    // fechar aba nenhuma, mas o `destroyed` dispara igual.
    matar: () => { estado.morto = true; (estado.ouvintes.destroyed || []).forEach((cb) => cb()); },
    debugger: dbg,
  };
}
const viewsFalsos = [];
class WebContentsViewFalso {
  constructor() { this.webContents = criarWebContentsFalso(); this.visivel = null; this.bounds = null; viewsFalsos.push(this); }
  setVisible(v) { this.visivel = v; }
  getVisible() { return this.visivel === true; }
  setBounds(b) { this.bounds = b; }
  getBounds() { return this.bounds; }
}

const winMap = new Map();
class BrowserWindowFalso {}
BrowserWindowFalso.fromWebContents = (wc) => winMap.get(wc) || null;
BrowserWindowFalso.getAllWindows = () => [];

const handlers = new Map();
const ipcMainFalso = {
  handle(nome, fn) { handlers.set(nome, fn); },
  on(nome, fn) { handlers.set(nome, fn); },
};

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: {
      commandLine: { appendSwitch() {} },
      requestSingleInstanceLock: () => false,
      quit() {}, on() {}, getPath: () => '', userAgentFallback: '',
    },
    BrowserWindow: BrowserWindowFalso,
    WebContentsView: WebContentsViewFalso,
    dialog: {}, ipcMain: ipcMainFalso, screen: {}, shell: {},
  },
};

require('./main.cjs');

function novaJanela({ focada = true } = {}) {
  // identidade distinta: o remetente do IPC desta janela
  const webContents = { focos: 0, focus() { this.focos++; }, enviados: [], send(canal, payload) { this.enviados.push({ canal, payload }); } };
  const children = [];
  const emFoco = [];
  const win = {
    contentView: {
      children,
      addChildView(v) { children.push(v); },
      removeChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
    },
    webContents, isDestroyed: () => false,
    isFocused: () => focada,
    once(ev, fn) { if (ev === 'focus') emFoco.push(fn); },
    pendencias: () => emFoco.length,
    // O usuário volta pro app: a janela ganha foco e os pendentes disparam uma vez só.
    ganharFoco() { focada = true; const fns = emFoco.splice(0); for (const fn of fns) fn(); },
  };
  winMap.set(webContents, win);
  return { ev: { sender: webContents }, win };
}

test('fechar o painel de uma janela nao mata o controlador vivo da MESMA sessao aberta noutra janela', async () => {
  const a = novaJanela();
  const b = novaJanela();
  const chave = 'srv::mesma-sessao';
  const abrir = handlers.get('hangar:nav-open');
  const fechar = handlers.get('hangar:nav-close');
  assert.ok(abrir && fechar, 'handlers hangar:nav-open e hangar:nav-close registrados');

  // Duas janelas abrem a MESMA chave — as duas abas caem no MESMO registro global (é a situação
  // que o item 1 descreve).
  await abrir(a.ev, { chave, url: 'https://a.test', bounds: {} });
  await abrir(b.ev, { chave, url: 'https://b.test', bounds: {} });
  assert.equal(criadas.length, 2, 'um controlador por open');
  const ctlB = criadas[1];

  // Janela A fecha o SEU painel dessa sessão. Sem a guarda de identidade, soltarControlador
  // apagava incondicionalmente a entrada da chave — que agora é a do controlador de B.
  fechar(a.ev, { chave });
  assert.equal(ctlB.fechado, false, 'controlador de B sobrevive ao close de A (bug do item 1)');

  // Fechar B de verdade ainda funciona — a guarda não deixa a entrada travada pra sempre.
  fechar(b.ev, { chave });
  assert.equal(ctlB.fechado, true, 'o proprio close de B fecha o controlador de B');
});

test('open publica o estado: o painel que acabou de montar recebe a faixa de abas', async () => {
  const a = novaJanela();
  const chave = 'srv::remonta';
  const abrir = handlers.get('hangar:nav-open');
  await abrir(a.ev, { chave, url: 'https://um.test', bounds: { x: 0, y: 0, width: 10, height: 10 } });

  // O painel desmonta e monta de novo (troca de sessão, reload do front): ele perdeu tudo que foi
  // publicado antes de existir e chama `open` sem url só pra reexibir.
  a.win.webContents.enviados.length = 0;
  await abrir(a.ev, { chave, bounds: { x: 0, y: 0, width: 10, height: 10 } });

  const estado = a.win.webContents.enviados.filter((e) => e.canal === 'hangar:nav-estado').at(-1);
  assert.ok(estado, 'reexibir publica estado — sem isso a faixa so apareceria na proxima navegacao');
  assert.equal(estado.payload.abas.length, 1);
  assert.equal(estado.payload.ativa, 1);
});

test('open oculto cria o view escondido e ja dirigivel; view visivel nao e tocado', async () => {
  const a = novaJanela();
  const chave = 'srv::fora-da-tela';
  const abrir = handlers.get('hangar:nav-open');
  const antes = criadas.length;

  // Sessão fora da tela: o pedido chega pela lista, o view nasce escondido, com controlador.
  const r1 = await abrir(a.ev, { chave, url: 'https://x.test', bounds: {}, oculto: true });
  assert.deepEqual(r1, { ok: true, oculto: true }, 'ecoa `oculto`: é a prova que o front exige antes de confirmar');
  assert.equal(criadas.length, antes + 1, 'controlador criado mesmo escondido (o agente dirige via CDP)');
  const view = viewsFalsos.at(-1);
  assert.equal(view.visivel, false, 'nasce escondido');
  // É o primeiro load de um view JÁ na janela que leva o teclado (medido: anexar depois não leva).
  // Escondido, ele carrega solto e só entra na janela com a página pronta.
  assert.ok(!a.win.contentView.children.includes(view), 'escondido carrega FORA da janela');
  assert.equal(a.win.webContents.focos, 1, 'o foco volta pro front logo que o view escondido nasce');
  view.webContents.dispararLoad();
  assert.ok(a.win.contentView.children.includes(view), 'com a página pronta entra na janela (sem isso não há print)');
  assert.equal(a.win.webContents.focos, 2, 'e o foco volta de novo no load (navegação cross-site ainda rouba)');

  // O usuário abre a sessão: o painel reexibe sem url, como sempre.
  const r2 = await abrir(a.ev, { chave, url: undefined, bounds: { x: 1, y: 1, width: 10, height: 10 } });
  assert.equal(r2.ok, true);
  assert.equal(view.visivel, true);

  // Outro pedido oculto com o painel montado não esconde nem recria.
  const r3 = await abrir(a.ev, { chave, url: 'https://y.test', bounds: {}, oculto: true });
  assert.equal(r3.ok, true);
  assert.equal(view.visivel, true, 'view visível fica como está');
  assert.equal(criadas.length, antes + 1, 'sem controlador novo');
});

test('com o app em segundo plano o view escondido nao puxa a tela: o teclado volta quando a janela e focada', async () => {
  const a = novaJanela({ focada: false });
  const abrir = handlers.get('hangar:nav-open');

  await abrir(a.ev, { chave: 'srv::longe', url: 'https://z.test', bounds: {}, oculto: true });
  const view = viewsFalsos.at(-1);
  view.webContents.dispararLoad();
  // `focus()` numa janela de fundo é pedido de ativação: com focus_on_activate o compositor
  // traz o app pra frente e rouba a tela de quem está noutro aplicativo.
  assert.equal(a.win.webContents.focos, 0, 'janela em segundo plano nao e ativada');
  // Nascimento e load pediram o teclado; o view dirigido por CDP navega muitas vezes antes de o
  // usuário voltar, e uma pendência por pedido empilharia listeners.
  assert.equal(a.win.pendencias(), 1, 'uma pendencia por janela, nao uma por pedido');

  a.win.ganharFoco();
  assert.equal(a.win.webContents.focos, 1, 'o teclado volta pro front quando o usuario volta');

  a.win.ganharFoco();
  assert.equal(a.win.webContents.focos, 1, 'pendencia so dispara uma vez');
});

test('pendencia nao arranca o teclado do painel que o usuario abriu enquanto esteve fora', async () => {
  const a = novaJanela({ focada: false });
  const abrir = handlers.get('hangar:nav-open');
  const chave = 'srv::abriu-depois';

  await abrir(a.ev, { chave, url: 'https://w.test', bounds: {}, oculto: true });
  const view = viewsFalsos.at(-1);
  // O painel dessa sessão é montado com a janela ainda em segundo plano (o IPC vem do renderer,
  // não exige foco): o view vira visível com a pendência já agendada.
  await abrir(a.ev, { chave, url: undefined, bounds: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(view.getVisible(), true, 'painel montado');

  a.win.ganharFoco();
  assert.equal(a.win.webContents.focos, 0, 'o teclado fica com o navegador que esta na tela');
});

test('o controlador so e avisado do view escondido DEPOIS de a pagina carregar (senao, SIGSEGV)', async () => {
  const a = novaJanela();
  const abrir = handlers.get('hangar:nav-open');
  await abrir(a.ev, { chave: 'srv::viewport', url: 'https://z.test', bounds: {}, oculto: true });
  const view = viewsFalsos.at(-1);
  const ctl = criadas.at(-1);
  assert.deepEqual(ctl.ocultos, [], 'view recem-criado esta em about:blank — avisar aqui derruba o processo');

  view.webContents.dispararLoad();
  assert.deepEqual(ctl.ocultos, [true], 'carregou, agora sim');

  // O usuário abre a sessão: o painel monta e a emulação sai na hora (a página já carregou).
  await abrir(a.ev, { chave: 'srv::viewport', bounds: { x: 0, y: 0, width: 800, height: 600 } });
  assert.deepEqual(ctl.ocultos, [true, false]);

  // Trocar de sessão esconde o painel: o agente que continuar dirigindo precisa da emulação de volta.
  handlers.get('hangar:nav-hide')(a.ev, { chave: 'srv::viewport' });
  assert.deepEqual(ctl.ocultos, [true, false, true]);
});

// `open` numa aba que já existe é NAVEGAÇÃO: emular tamanho por cima da troca de página derrubava
// a sessão do depurador, e daí em diante todo verbo respondia "Not attached to an active page".
test('open que navega a aba escondida so mede quando a carga para', async () => {
  const a = novaJanela();
  const abrir = handlers.get('hangar:nav-open');
  const chave = 'srv::navegando';
  await abrir(a.ev, { chave, url: 'https://a.test/', bounds: {}, oculto: true });
  const view = viewsFalsos.at(-1);
  const ctl = criadas.at(-1);
  view.webContents.dispararLoad();
  assert.deepEqual(ctl.ocultos, [true]);

  await abrir(a.ev, { chave, url: 'https://b.test/', bounds: {}, oculto: true });
  assert.equal(view.webContents.isLoadingMainFrame(), true, 'o loadURL da navegacao esta em voo');
  assert.deepEqual(ctl.ocultos, [true], 'nada de emular no meio da troca de pagina');

  view.webContents.dispararLoad();
  assert.deepEqual(ctl.ocultos, [true, true], 'a carga parou: agora a medida volta');
});

test('open que navega a aba escondida a acorda ANTES do loadURL', async () => {
  const a = novaJanela();
  const abrir = handlers.get('hangar:nav-open');
  const chave = 'srv::acordar';
  await abrir(a.ev, { chave, url: 'https://a.test/', bounds: {}, oculto: true });
  const view = viewsFalsos.at(-1);
  view.webContents.dispararLoad();

  trilha.length = 0;
  await abrir(a.ev, { chave, url: 'https://b.test/', bounds: {}, oculto: true });
  assert.deepEqual(trilha, ['navegando:true', 'loadURL'],
    'congelada, a troca de pagina derruba a sessao do depurador — acordar depois seria tarde');
});

test('criar, trocar e fechar aba: ids nao renumeram e a ultima fecha o navegador', async () => {
  const a = novaJanela();
  const chave = 'srv::abas';
  const abrir = handlers.get('hangar:nav-open');
  const nova = handlers.get('hangar:nav-tab-new');
  const trocar = handlers.get('hangar:nav-tab-switch');
  const fechar = handlers.get('hangar:nav-tab-close');
  assert.ok(nova && trocar && fechar, 'handlers de aba registrados');

  await abrir(a.ev, { chave, url: 'https://um.test', bounds: { x: 0, y: 0, width: 10, height: 10 } });
  const r2 = await nova(a.ev, { chave, url: 'https://dois.test' });
  const r3 = await nova(a.ev, { chave, url: 'https://tres.test' });
  assert.deepEqual([r2.ok, r2.id, r3.id], [true, 2, 3], 'ids sequenciais a partir da aba 1');

  // Fechar a 2 nao renumera a 3.
  const f2 = await fechar(a.ev, { chave, id: 2 });
  assert.equal(f2.fechouNavegador, false);
  const depois = await nova(a.ev, { chave, url: 'https://quatro.test' });
  assert.equal(depois.id, 4, 'id fechado nunca volta');

  assert.deepEqual((await trocar(a.ev, { chave, id: 1 })), { ok: true });
  // Sobram 1, 3 e 4: as duas primeiras fecham sem derrubar o navegador.
  assert.equal((await fechar(a.ev, { chave, id: 3 })).fechouNavegador, false);
  assert.equal((await fechar(a.ev, { chave, id: 4 })).fechouNavegador, false);
  assert.equal((await fechar(a.ev, { chave, id: 1 })).fechouNavegador, true, 'a ultima aba fecha o navegador');
});

test('teto de 8 abas', async () => {
  const a = novaJanela();
  const chave = 'srv::teto';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://x.test', bounds: {} });
  const nova = handlers.get('hangar:nav-tab-new');
  for (let i = 0; i < 7; i++) assert.equal((await nova(a.ev, { chave, url: 'https://y.test' })).ok, true);
  assert.deepEqual(await nova(a.ev, { chave, url: 'https://z.test' }), { ok: false, motivo: 'teto' });
});

test('trocar de aba nao devolve o teclado ao front', async () => {
  const a = novaJanela();
  const chave = 'srv::foco';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: { x: 0, y: 0, width: 10, height: 10 } });
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  const antes = a.win.webContents.focos;
  await handlers.get('hangar:nav-tab-switch')(a.ev, { chave, id: 1 });
  assert.equal(a.win.webContents.focos, antes, 'uma aba da janela continua visivel: o teclado fica nela');
});

test('sidecar reflete ativa e abas, e mantem url/targetId da ativa no topo', async () => {
  const a = novaJanela();
  const chave = 'srv::sidecar';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: {} });
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  await new Promise((r) => setImmediate(r));   // gravarSidecarNav é fire-and-forget
  const arq = path.join(process.env.HOME, '.hangar', 'nav', `${require('./navegador.cjs').nomeSidecar(chave)}.json`);
  const s = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.equal(s.ativa, 2);
  assert.equal(s.url, 'https://dois.test/', 'topo espelha a ativa — o backend le so isso');
  assert.deepEqual(s.abas.map((x) => x.id), [1, 2]);
  assert.ok('targetId' in s, 'campo do topo preservado');
});

test('fechar o navegador com 3 abas solta os 3 controladores', async () => {
  const a = novaJanela();
  const chave = 'srv::queda';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: {} });
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://tres.test' });
  const tres = criadas.slice(-3);
  handlers.get('hangar:nav-close')(a.ev, { chave });
  assert.deepEqual(tres.map((c) => c.fechado), [true, true, true], 'nenhum controlador orfao');
});

test('aba nova herda o estado de exibicao da ativa', async () => {
  const a = novaJanela();
  const chave = 'srv::herda';
  // Sessão fora da tela: a aba 1 nasce escondida e com a emulação de tamanho ligada.
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: {}, oculto: true });
  viewsFalsos.at(-1).webContents.dispararLoad();
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  const nova = viewsFalsos.at(-1);
  nova.webContents.dispararLoad();
  assert.equal(nova.getVisible(), false, 'aba aberta pelo agente nao pinta por cima do chat');
  assert.deepEqual(criadas.at(-1).ocultos, [true], 'escondida recebe a emulacao: sem ela, shot --aba le 0x0');
});

test('abas da mesma sessao compartilham o estado persistente de layout', async () => {
  const a = novaJanela();
  const chave = 'srv::layout-compartilhado';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: {} });
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  const [primeira, segunda] = criadas.slice(-2);

  assert.ok(primeira.opcoes.layoutEstado, 'a sessao possui estado de layout');
  assert.equal(primeira.opcoes.layoutEstado, segunda.opcoes.layoutEstado,
    'trocar ou criar aba nao perde o tamanho pedido');
});

test('layout personalizado publica as dimensoes para o painel da direita crescer', async () => {
  const a = novaJanela();
  const chave = 'srv::layout-painel';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: {} });
  const ctl = criadas.at(-1);
  Object.assign(ctl.opcoes.layoutEstado, {
    modo: 'custom', width: 1366, height: 768, versao: 1, erro: 'layout nao aplicado: renderer trocou',
  });

  ctl.opcoes.aoLayout();

  const estado = a.win.webContents.enviados.filter((e) => e.canal === 'hangar:nav-estado').at(-1);
  assert.equal(estado.payload.layoutWidth, 1366);
  assert.equal(estado.payload.layoutHeight, 768);
  assert.equal(estado.payload.layoutError, 'layout nao aplicado: renderer trocou');
});

test('trocar de aba mantem visivel o que estava visivel, e esconde a anterior', async () => {
  const a = novaJanela();
  const chave = 'srv::troca';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: { x: 0, y: 0, width: 10, height: 10 } });
  const um = viewsFalsos.at(-1);
  um.webContents.dispararLoad();
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  const dois = viewsFalsos.at(-1);
  dois.webContents.dispararLoad();
  assert.deepEqual([um.getVisible(), dois.getVisible()], [false, true], 'a nova entra no lugar da anterior');

  await handlers.get('hangar:nav-tab-switch')(a.ev, { chave, id: 1 });
  assert.deepEqual([um.getVisible(), dois.getVisible()], [true, false]);
  assert.deepEqual(dois.bounds, um.bounds, 'a que entra assume o retangulo da que saiu');
});

test('aba que morre por fora nao deixa a sessao sem ativa', async () => {
  const a = novaJanela();
  const chave = 'srv::morreu';
  await handlers.get('hangar:nav-open')(a.ev, { chave, url: 'https://um.test', bounds: { x: 0, y: 0, width: 10, height: 10 } });
  const um = viewsFalsos.at(-1);
  await handlers.get('hangar:nav-tab-new')(a.ev, { chave, url: 'https://dois.test' });
  const dois = viewsFalsos.at(-1);
  // Target.closeTarget por CDP na aba ATIVA: ninguem chamou fecharAba, mas a sessao nao pode
  // ficar sem ativa — o CLI passaria a responder "nao tem navegador aberto" com aba viva.
  dois.webContents.matar();
  assert.equal(um.getVisible(), true, 'a que sobrou volta pra tela');
});
