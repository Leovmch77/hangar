<script lang="ts">
  // Saúde dos harnesses: uma linha por CLI (Claude Code, Codex, Pi, omp, Kimi) com o que o app
  // instalou nele — hooks, extensões, ponte de skills, login espalhado, contas — e um botão por
  // item fora do lugar que roda o conserto que já existe no servidor. Existe porque cada peça
  // dessas falha calada: sessão sem estado, skill que sumiu, CLI deslogado, e a pessoa só descobre
  // no meio do trabalho.
  import {
    listarHarnesses, consertarHarness, codexIntegracaoEstado, codexIntegracaoReconciliar,
    listarContasCodex, prepararContaCodex, estadoContaCodex, codexAccountMessage,
    instalacaoEstado, instalarHarness, codexOpcoes,
    type CodexAccount, type Harness, type ItemHarness, type IntegracaoCodex, type MensagemCodex, type Instalacao,
    type CodexOpcoes,
  } from '../../lib/credenciais';
  import { patchConfig, patchConfigForServer, type CampoConfig } from '@hangar/core';
  import * as m from '../../paraglide/messages';
  import { getLocale } from '../../paraglide/runtime';
  import { onDestroy } from 'svelte';
  import ProvedorIcone from '../icons/ProvedorIcone.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import EscopoChip from './EscopoChip.svelte';
  import type { Server } from '../../lib/auth';
  import type { ConfigServidorStore } from '../../lib/serverConfig.svelte';

  interface Props {
    apiTarget: Server | null;
    /** Configuração do servidor JÁ LIDA pelo modal. Esta tela não faz o `GET /api/config` dela —
     *  eram 3 leituras por abertura contra 1. Vem o store inteiro, e não só os campos, porque
     *  "carregando" e "não deu pra ler" precisam ser distinguíveis de "o backend não conhece a
     *  chave": só o terceiro é que vira o aviso de opção indisponível. */
    store: ConfigServidorStore;
  }
  let { apiTarget, store }: Props = $props();

  // O que a gravação devolve vence o que veio do modal: o POST responde com os campos já novos, e
  // é essa releitura que muda a tela (o store do modal só recarrega na troca de alvo).
  let camposGravados = $state<Record<string, CampoConfig> | null>(null);
  const campos = $derived(camposGravados
    ?? (store.carregando || store.erro ? null : store.campos));

  let lista = $state<Harness[]>([]);
  let carregando = $state(false);
  let erro = $state('');
  let consertando = $state<string | null>(null);
  let feito = $state('');
  // Preferência do Claude (barra de status) e opções do Codex vivem DENTRO do card, sem folha e sem
  // Salvar: o `checked` é o dado do servidor, o `onchange` repõe o dado e grava, e é a releitura que
  // muda a tela — o mesmo caminho de "Sincronização automática", logo abaixo.
  let erroConfig = $state('');
  let trocandoStatusline = $state(false);
  let opcoesDoCodex = $state<CodexOpcoes | null>(null);
  let erroOpcoesCodex = $state('');
  let trocandoOpcoesCodex = $state(false);
  let integracao = $state<IntegracaoCodex | null>(null);
  let contasCodex = $state<CodexAccount[]>([]);
  let erroContas = $state('');
  let contaCodex = $state('default');
  let syncConta = $state<CodexAccount['sync'] | null>(null);
  let contaSelecionada = $derived(contasCodex.find((conta) => conta.id === contaCodex) ?? null);
  let erroIntegracao = $state('');
  let reconciliando = $state(false);
  // O `!erroIntegracao` é o que destrava o botão quando a conexão cai NO MEIO do polling: ali o
  // último estado lido continua sendo `executando`, mas ninguém mais vai perguntar (o catch não
  // reagenda), então o card ficava preso em "Executando…" com o botão desabilitado para sempre.
  // Erro significa que não se sabe mais se está rodando — e quem não sabe tem que poder tentar.
  // Apertar o botão limpa o erro na entrada de `consultarIntegracao`, então o ciclo se rearma.
  let integracaoOcupada = $derived(reconciliando || (!erroIntegracao && (contaCodex === 'default'
    ? integracao?.estado === 'executando' : syncConta?.status === 'running')));
  interface ConsultaIntegracao {
    alvo: Server | null;
    controle: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    requisicao: number;
    timerInst?: ReturnType<typeof setTimeout>;
    reqInst: number;
    reqConfig: number;
    reqCodex: number;
    timerConta?: ReturnType<typeof setTimeout>;
    reqConta: number;
  }
  let consulta: ConsultaIntegracao | null = null;

  // Instalar um CLI que falta. O estado vem do servidor por polling — a instalação vive lá, então
  // fechar a tela ou recarregar o app no meio dela não perde o progresso nem a saída do comando.
  let inst = $state<Instalacao | null>(null);
  let erroInst = $state('');
  let erroInstCli = $state<string | null>(null);
  let confirmar = $state<Harness | null>(null);
  let instalando = $derived(inst?.fase === 'rodando');

  function comandoDe(h: Harness): string | null { return inst?.comandos?.[h.id] ?? null; }
  // Só http(s): a URL vem do servidor e vira `href`, e um `javascript:` ali executaria no clique.
  // Mesma regra que `lib/markdown.ts` já aplica na outra superfície que renderiza link de fora.
  function manualDe(h: Harness): string | null {
    const u = inst?.manual?.[h.id] ?? null;
    return u && /^https?:\/\//i.test(u) ? u : null;
  }

  async function consultarInstalacao(ctx: ConsultaIntegracao, cli?: string) {
    if (ctx.timerInst) clearTimeout(ctx.timerInst);
    const requisicao = ++ctx.reqInst;
    // Tentativa nova zera o erro da anterior; poll de rotina, não — ver abaixo.
    if (cli) { erroInst = ''; erroInstCli = null; }
    try {
      const estado = cli
        ? await instalarHarness(ctx.alvo, cli, ctx.controle.signal)
        : await instalacaoEstado(ctx.alvo, ctx.controle.signal);
      if (ctx.controle.signal.aborted || requisicao !== ctx.reqInst) return;
      // Só uma instalação ANDANDO apaga o erro. Zerando a cada chamada — ou a cada resposta boa —,
      // o erro que impede a instalação de COMEÇAR (409 de outra em curso, 500, teto de tempo)
      // aparecia e o próprio poll de reparo o apagava 1,2s depois: a pessoa clicava, lia um
      // instante e ficava sem nada. Erro transitório de poll continua sumindo, porque ali a
      // instalação está rodando e a resposta seguinte diz isso.
      if (estado.fase === 'rodando') { erroInst = ''; erroInstCli = null; }
      const terminou = inst?.fase === 'rodando' && estado.fase === 'pronto';
      // Normaliza o `log` na entrada: um backend mais velho (ou uma resposta de outra forma) não
      // pode derrubar a tela inteira por causa de um campo ausente — mesmo precedente do
      // `statusline.read` exigir dict antes de usar o valor (CLAUDE.md).
      inst = { ...estado, log: Array.isArray(estado?.log) ? estado.log : [] };
      if (estado.fase === 'rodando') {
        ctx.timerInst = setTimeout(() => { void consultarInstalacao(ctx); }, 1200);
      } else if (terminou) {
        // Quem diz se instalou é o disco relido, não o `rc` do comando: recarrega o card.
        void carregar();
      }
    } catch (e) {
      if (ctx.controle.signal.aborted || requisicao !== ctx.reqInst) return;
      erroInst = e instanceof Error ? e.message : String(e);
      // De quem é o erro: sem isto ele era desenhado dentro do card da instalação ANTERIOR.
      erroInstCli = cli ?? inst?.harness ?? null;
      // O trabalho vive no SERVIDOR: uma resposta perdida (blip de rede, ou o teto de 8s da
      // chamada) não pode congelar a tela em "rodando" — e congelava de vez, porque `instalando`
      // ficava `true` para sempre, o que desabilita o botão de todos os cards e faz o ↻ pular a
      // releitura. Reagenda: o estado real está lá e a próxima resposta desempata.
      // `cli` cobre o outro lado: se o POST estourar, `inst` nunca vira "rodando" e o card
      // voltaria a oferecer "Instalar" com uma instalação já correndo no servidor.
      if (inst?.fase === 'rodando' || cli) {
        ctx.timerInst = setTimeout(() => { void consultarInstalacao(ctx); }, 1200);
      }
    }
  }

  function instalar(h: Harness) {
    confirmar = null;
    if (!consulta) return;
    // Uma instalação pode ter começado noutro aparelho enquanto a confirmação estava aberta.
    // Fechar a caixa e não fazer nada é o clique que some — diz o porquê.
    if (instalando) { erroInst = m.harness_inst_ocupado(); erroInstCli = h.id; return; }
    void consultarInstalacao(consulta, h.id);
  }

  async function consultarIntegracao(ctx: ConsultaIntegracao, reconciliar = false) {
    if (ctx.timer) clearTimeout(ctx.timer);
    const requisicao = ++ctx.requisicao;
    if (reconciliar) reconciliando = true;
    erroIntegracao = '';
    try {
      const estado = await (reconciliar ? codexIntegracaoReconciliar : codexIntegracaoEstado)(ctx.alvo, ctx.controle.signal);
      if (ctx.controle.signal.aborted || requisicao !== ctx.requisicao) return;
      integracao = estado;
      if (estado.estado === 'executando') {
        ctx.timer = setTimeout(() => { void consultarIntegracao(ctx); }, 1500);
      }
    } catch (e) {
      if (!ctx.controle.signal.aborted && requisicao === ctx.requisicao) {
        erroIntegracao = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (!ctx.controle.signal.aborted && requisicao === ctx.requisicao) reconciliando = false;
    }
  }

  function guardarSyncConta(id: string, sync: CodexAccount['sync']) {
    syncConta = sync;
    contasCodex = contasCodex.map((conta) => conta.id === id ? { ...conta, sync } : conta);
  }

  async function consultarConta(ctx: ConsultaIntegracao, reconciliar = false) {
    if (ctx.timerConta) clearTimeout(ctx.timerConta);
    const id = contaCodex;
    if (id === 'default') return;
    const requisicao = ++ctx.reqConta;
    if (reconciliar) reconciliando = true;
    erroIntegracao = '';
    try {
      const sync = await (reconciliar
        ? prepararContaCodex(ctx.alvo, id, true, ctx.controle.signal)
        : estadoContaCodex(ctx.alvo, id, ctx.controle.signal));
      if (ctx.controle.signal.aborted || requisicao !== ctx.reqConta || contaCodex !== id) return;
      guardarSyncConta(id, sync);
      if (sync.status === 'running') {
        ctx.timerConta = setTimeout(() => { void consultarConta(ctx); }, 1500);
      }
    } catch (e) {
      if (!ctx.controle.signal.aborted && requisicao === ctx.reqConta && contaCodex === id) {
        erroIntegracao = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (!ctx.controle.signal.aborted && requisicao === ctx.reqConta) reconciliando = false;
    }
  }

  async function carregarContas(ctx: ConsultaIntegracao) {
    try {
      const contas = await listarContasCodex(ctx.alvo, ctx.controle.signal);
      if (ctx.controle.signal.aborted) return;
      erroContas = '';
      contasCodex = contas;
      const lembrada = localStorage.getItem(`cp_harness_codex_account:${ctx.alvo?.id ?? 'active'}`);
      if (lembrada && contas.some((conta) => conta.id === lembrada)) contaCodex = lembrada;
      else if (!contas.some((conta) => conta.id === contaCodex)) contaCodex = 'default';
      syncConta = contas.find((conta) => conta.id === contaCodex)?.sync ?? null;
      if (contaCodex !== 'default' && syncConta?.status === 'running') void consultarConta(ctx);
    } catch (e) {
      // Erro PRÓPRIO: `erroIntegracao` é zerado por todo poll da integração, e a falha da lista
      // sumia em 1,5s — deixando o seletor apagado dizendo "só a conta padrão" como se fosse fato.
      if (!ctx.controle.signal.aborted) erroContas = e instanceof Error ? e.message : String(e);
    }
  }

  function trocarConta(ev: Event) {
    contaCodex = (ev.currentTarget as HTMLSelectElement).value;
    localStorage.setItem(`cp_harness_codex_account:${consulta?.alvo?.id ?? 'active'}`, contaCodex);
    erroIntegracao = '';
    syncConta = contasCodex.find((conta) => conta.id === contaCodex)?.sync ?? null;
    if (consulta && contaCodex !== 'default') void consultarConta(consulta);
  }

  function reconciliarIntegracao() {
    if (consulta && !integracaoOcupada) {
      if (contaCodex === 'default') void consultarIntegracao(consulta, true);
      else void consultarConta(consulta, true);
    }
  }

  async function trocarStatusline(ev: Event) {
    const alvo = ev.currentTarget as HTMLInputElement;
    const querido = alvo.checked;
    alvo.checked = !querido;
    const ctx = consulta;
    if (!ctx || trocandoStatusline) return;
    trocandoStatusline = true;
    erroConfig = '';
    // A gravação entra na MESMA fila das leituras: sem isso um ↻ disparado antes dela respondia
    // depois e repunha o valor velho na tela, calado — parecia gravação que não pegou.
    const requisicao = ++ctx.reqConfig;
    try {
      const r = await (ctx.alvo ? patchConfigForServer(ctx.alvo, { claude_statusline_update: querido })
                                : patchConfig({ claude_statusline_update: querido }));
      if (consulta === ctx && requisicao === ctx.reqConfig) camposGravados = r.campos ?? camposGravados;
    } catch (e) {
      if (consulta === ctx) erroConfig = e instanceof Error ? e.message : String(e);
    } finally {
      // Só a trava DESTE contexto: uma resposta atrasada do servidor anterior soltaria a trava de
      // uma gravação que ainda está em voo no servidor novo, liberando um segundo clique.
      if (consulta === ctx) trocandoStatusline = false;
    }
  }

  // Só depois de saber que o Codex está instalado: a tela de hoje também só oferecia estas opções
  // no card de um Codex presente.
  async function consultarOpcoesCodex(ctx: ConsultaIntegracao, mudancas?: Pick<CodexOpcoes, 'contexto_estendido' | 'codex_voice_beta'>) {
    const requisicao = ++ctx.reqCodex;
    erroOpcoesCodex = '';
    try {
      const r = await codexOpcoes(ctx.alvo, ctx.controle.signal, mudancas);
      if (ctx.controle.signal.aborted || requisicao !== ctx.reqCodex) return;
      opcoesDoCodex = r;
      if (mudancas) window.dispatchEvent(new CustomEvent('hangar:codex-voice-config', {
        detail: { serverId: ctx.alvo?.id ?? null, enabled: r.codex_voice_beta },
      }));
    } catch (e) {
      if (ctx.controle.signal.aborted || requisicao !== ctx.reqCodex) return;
      erroOpcoesCodex = e instanceof Error ? e.message : String(e);
    }
  }

  function trocarOpcaoCodex(ev: Event, chave: 'contexto_estendido' | 'codex_voice_beta') {
    const alvo = ev.currentTarget as HTMLInputElement;
    const querido = alvo.checked;
    alvo.checked = !querido;
    const ctx = consulta;
    const atual = opcoesDoCodex;
    if (!ctx || !atual || trocandoOpcoesCodex) return;
    trocandoOpcoesCodex = true;
    void consultarOpcoesCodex(ctx, {
      contexto_estendido: atual.contexto_estendido, codex_voice_beta: atual.codex_voice_beta, [chave]: querido,
    }).finally(() => { if (consulta === ctx) trocandoOpcoesCodex = false; });
  }

  let trocandoAutomatica = $state(false);
  let trocandoMemoria = $state(false);
  // O interruptor nunca muda sozinho: `checked` é o dado do servidor; o onchange repõe o dado,
  // grava, e a releitura é quem muda a tela (regra das Máquinas, CLAUDE.md).
  async function trocarAutomatica(ev: Event) {
    const alvo = ev.currentTarget as HTMLInputElement;
    const querido = alvo.checked;
    alvo.checked = !querido;
    // `consulta` é trocada pelo $effect quando o servidor muda; a gravação e a releitura são do
    // contexto que existia no clique — trocar de servidor no meio não pode reconsultar o outro.
    const ctx = consulta;
    if (!ctx || trocandoAutomatica) return;
    trocandoAutomatica = true;
    erroIntegracao = '';
    try {
      await (ctx.alvo ? patchConfigForServer(ctx.alvo, { codex_sync: querido })
                      : patchConfig({ codex_sync: querido }));
      if (consulta === ctx) await consultarIntegracao(ctx);
    } catch (e) {
      if (consulta === ctx) erroIntegracao = e instanceof Error ? e.message : String(e);
    } finally {
      if (consulta === ctx) trocandoAutomatica = false;
    }
  }

  async function trocarMemoria(ev: Event) {
    const alvo = ev.currentTarget as HTMLInputElement;
    const querido = alvo.checked;
    alvo.checked = !querido;
    const ctx = consulta;
    if (!ctx || trocandoMemoria) return;
    trocandoMemoria = true;
    erroIntegracao = '';
    try {
      await (ctx.alvo ? patchConfigForServer(ctx.alvo, { codex_memory_import: querido })
                      : patchConfig({ codex_memory_import: querido }));
      if (consulta === ctx) await consultarIntegracao(ctx);
    } catch (e) {
      if (consulta === ctx) erroIntegracao = e instanceof Error ? e.message : String(e);
    } finally {
      trocandoMemoria = false;
    }
  }

  function atualizar() {
    void carregar();
    // O ↻ é a saída de uma leitura que falhou — inclusive a da CONFIGURAÇÃO, que agora vem do modal:
    // quem relê é o store dele. `camposGravados` cai junto, senão a pintura da última gravação
    // venceria o dado recém-lido e o que mudou por fora (outra aba, o terminal) nunca apareceria.
    camposGravados = null; erroConfig = '';
    void store.carregar();
    // As opções do Codex saem pelo `carregar()` acima, nos dois ramos dele.
    if (consulta && !reconciliando) void consultarIntegracao(consulta);
    if (consulta) {
      void carregarContas(consulta);
      if (contaCodex !== 'default') void consultarConta(consulta);
    }
    // Sem guard de "instalando": `consultarInstalacao` já limpa o timer e incrementa a geração no
    // topo, então reentrar é seguro — e o guard trancava justamente a saída manual de uma tela
    // presa em "rodando".
    if (consulta) void consultarInstalacao(consulta);
  }

  // Mensagem da integração: código do backend → frase daqui (harness_codex_m_<codigo>); código que
  // este app não conhece mostra o `texto` em pt em vez de sumir.
  function textoDe(msg: MensagemCodex | null | undefined): string {
    if (!msg) return '';
    if (typeof msg === 'string') return msg;
    const fn = msg.codigo ? (m as Record<string, unknown>)[`harness_codex_m_${msg.codigo}`] : undefined;
    return typeof fn === 'function' ? (fn as (p: Record<string, string>) => string)(msg.params ?? {}) : msg.texto;
  }

  const ESTADOS_INTEGRACAO: Record<IntegracaoCodex['estado'], () => string> = {
    ocioso: m.harness_codex_ocioso, executando: m.harness_codex_executando,
    ok: m.harness_codex_ok, parcial: m.harness_codex_parcial,
    erro: m.harness_codex_erro, indisponivel: m.harness_codex_indisponivel,
  };

  const ESTADOS_CONTA: Record<CodexAccount['sync']['status'], () => string> = {
    idle: m.harness_codex_ocioso, running: m.harness_codex_executando,
    ready: m.harness_codex_ok, partial: m.harness_codex_parcial, error: m.harness_codex_erro,
  };

  function dataIntegracao(valor: string | null): string {
    if (!valor) return m.harness_codex_nunca();
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? valor : data.toLocaleString(getLocale());
  }

  // Alvo capturado na chamada e resposta descartada se ele mudou: trocar de servidor com a
  // requisição em voo não pode pintar a lista da máquina errada.
  let ger = 0;

  async function carregar() {
    const alvo = apiTarget;
    const g = ++ger;
    carregando = true; erro = '';
    try {
      const r = await listarHarnesses(alvo);
      if (g !== ger) return;
      lista = r;
      const ctx = consulta;
      if (ctx && r.some((h) => h.id === 'codex' && h.instalado)) void consultarOpcoesCodex(ctx);
    } catch (e) {
      if (g !== ger) return;
      erro = e instanceof Error ? e.message : String(e);
      // A lista cair não pode trancar um endpoint que não é o dela: `lista` sobrevive ao erro (só é
      // reatribuída no sucesso), então os cards continuam na tela e as opções seguem relegíveis.
      const ctx = consulta;
      if (ctx && lista.some((h) => h.id === 'codex' && h.instalado)) void consultarOpcoesCodex(ctx);
    }
    finally { if (g === ger) carregando = false; }
  }

  // Etapas concluídas + a fração da etapa atual que o sub-andamento (item i de N) mede. Sem sub, a
  // etapa em curso conta zero: a barra nunca promete um avanço que o servidor não informou.
  function pctIntegracao(p: NonNullable<IntegracaoCodex['progresso']>): number {
    const dentro = p.sub && p.sub.total > 0 ? (p.sub.atual - 1) / p.sub.total : 0;
    return Math.round(Math.min(1, Math.max(0, (p.passo - 1 + dentro) / p.total)) * 100);
  }

  // Andamento e desfecho moram JUNTO do item: o botão virava "…" e o resultado ia pro rodapé da
  // página, longe de quem clicou. Tempo decorrido, não estimativa: um conserto é um comando só, e
  // "quanto falta" seria inventado.
  let consertoDe = $state<{ cli: string; item: string } | null>(null);
  let resultado = $state<{ cli: string; item: string; ok: boolean; texto: string } | null>(null);
  let decorrido = $state(0);
  let relogio: ReturnType<typeof setInterval> | undefined;
  onDestroy(() => clearInterval(relogio));

  async function consertar(id: string, cli: string, item: string) {
    if (consertando) return;
    const alvo = apiTarget;
    const g = ++ger;
    consertando = id; consertoDe = { cli, item }; resultado = null; erro = ''; feito = '';
    const inicio = Date.now();
    decorrido = 0;
    clearInterval(relogio);
    relogio = setInterval(() => { decorrido = Math.floor((Date.now() - inicio) / 1000); }, 1000);
    try {
      const r = await consertarHarness(alvo, id);
      if (g !== ger) return;
      lista = r.harnesses;
      resultado = { cli, item, ok: true, texto: r.feito };
    } catch (e) {
      if (g === ger) resultado = { cli, item, ok: false, texto: e instanceof Error ? e.message : String(e) };
    } finally {
      if (g === ger) { consertando = null; consertoDe = null; clearInterval(relogio); }
    }
  }

  $effect(() => {
    const ctx: ConsultaIntegracao = {
      alvo: apiTarget, controle: new AbortController(), requisicao: 0, reqInst: 0, reqConfig: 0, reqCodex: 0,
      reqConta: 0,
    };
    consulta = ctx;
    lista = []; feito = ''; consertando = null;
    camposGravados = null; erroConfig = ''; trocandoStatusline = false;
    opcoesDoCodex = null; erroOpcoesCodex = ''; trocandoOpcoesCodex = false;
    integracao = null; contasCodex = []; erroContas = ''; contaCodex = 'default'; syncConta = null;
    erroIntegracao = ''; reconciliando = false;
    inst = null; erroInst = ''; confirmar = null;
    void carregar();
    void consultarIntegracao(ctx);
    void carregarContas(ctx);
    // Também na montagem: é desta resposta que sai a lista de quem dá pra instalar por botão nesta
    // máquina, e sem ela nenhum card ausente saberia o que oferecer.
    void consultarInstalacao(ctx);
    return () => {
      // Nem uma resposta atrasada nem o próximo poll podem atravessar a troca de servidor.
      ++ger;
      ++ctx.reqInst;
      ++ctx.reqConfig;
      ++ctx.reqCodex;
      ctx.controle.abort();
      if (ctx.timer) clearTimeout(ctx.timer);
      if (ctx.timerConta) clearTimeout(ctx.timerConta);
      if (ctx.timerInst) clearTimeout(ctx.timerInst);
      consulta = null;
    };
  });

  // O código vem do servidor; a frase é daqui. Código desconhecido (backend mais novo que o app)
  // aparece cru em vez de sumir — sumir esconderia justamente o item que mudou.
  const TEXTOS: Record<string, (p: Record<string, string>) => string> = {
    skills_ok: (p) => (p.origem ? m.harness_skills_origem({ n: p.n ?? '', origem: p.origem }) : m.harness_skills_ok({ n: p.n ?? '' })),
    mcp_ok: (p) => m.harness_mcp_ok({ n: p.n ?? '', lista: p.lista ?? '' }),
    mcp_nenhum: () => m.harness_mcp_nenhum(),
    modelo_padrao: (p) => m.harness_modelo_padrao({ modelo: p.modelo ?? '' }),
    modelo_padrao_nenhum: () => m.harness_modelo_padrao_nenhum(),
    hooks_nenhum: () => m.harness_hooks_nenhum(),
    hooks_codex: (p) => m.harness_hooks_codex({ n: p.n ?? '', eventos: p.eventos ?? '' }),
    tmux_bloco_ok: () => m.harness_tmux_bloco_ok(),
    tmux_bloco_ausente: () => m.harness_tmux_bloco_ausente(),
    tmux_term_ok: (p) => m.harness_tmux_term_ok({ valor: p.valor ?? '' }),
    tmux_term_ruim: (p) => m.harness_tmux_term_ruim({ valor: p.valor ?? '' }),
    tmux_truecolor_ok: () => m.harness_tmux_truecolor_ok(),
    tmux_truecolor_ruim: () => m.harness_tmux_truecolor_ruim(),
    tmux_titulo_ok: () => m.harness_tmux_titulo_ok(),
    tmux_titulo_ruim: (p) => m.harness_tmux_titulo_ruim({ valor: p.valor ?? '' }),
    tmux_mouse_on: () => m.harness_tmux_mouse_on(),
    tmux_mouse_off: () => m.harness_tmux_mouse_off(),
    tmux_persist_on: () => m.harness_tmux_persist_on(),
    tmux_persist_off: () => m.harness_tmux_persist_off(),
    sem_ponte: () => m.harness_sem_ponte(),
    ponte_ausente: () => m.harness_ponte_ausente(),
    links_pendurados: (p) => m.harness_links_pendurados({ n: p.n ?? '', total: p.total ?? '' }),
    ponte_fora_da_config: (p) => m.harness_ponte_fora_da_config({ n: p.n ?? '', cli: p.cli ?? '' }),
    config_ilegivel: () => m.harness_config_ilegivel(),
    extensoes_ok: (p) => m.harness_extensoes_ok({ n: p.n ?? '' }),
    faltam: (p) => m.harness_faltam({ lista: p.lista ?? '' }),
    extensoes_outra_fonte: (p) => (p.faltam
      ? m.harness_extensoes_outra_fonte_e_faltam({ lista: p.lista ?? '', faltam: p.faltam })
      : m.harness_extensoes_outra_fonte({ lista: p.lista ?? '' })),
    faltam_n: (p) => m.harness_faltam_n({ n: p.n ?? '' }),
    hooks_ok: (p) => m.harness_hooks_ok({ n: p.n ?? '' }),
    nenhuma_conta: () => m.harness_nenhuma_conta(),
    so_conta_padrao: () => m.harness_so_conta_padrao(),
    contas_ok: (p) => m.harness_contas_ok({ n: p.n ?? '', lista: p.lista ?? '' }),
    plugins_ok: (p) => m.harness_plugins_ok({ n: p.n ?? '', lista: p.lista ?? '' }),
    plugins_com_problema: (p) => m.harness_plugins_com_problema({ n: p.n ?? '', lista: p.lista ?? '' }),
    credenciais_ok: (p) => m.harness_credenciais_ok({ tem: p.tem ?? '' }),
    credenciais_faltam: (p) => m.harness_credenciais_faltam({ tem: p.tem ?? '', faltam: p.faltam ?? '' }),
    wrapper_ok: (p) => m.harness_wrapper_ok({ onde: p.onde ?? '' }),
    wrapper_falta: (p) => m.harness_wrapper_falta({ lista: p.lista ?? '' }),
    wrapper_sem_shell: () => m.harness_wrapper_sem_shell(),
    statusline_ok: () => m.harness_statusline_ok(),
    fullscreen_ok: () => m.harness_fullscreen_ok(),
    fullscreen_desligado: () => m.harness_fullscreen_desligado(),
    fullscreen_claude_desligado: () => m.harness_fullscreen_claude_desligado(),
    fullscreen_por_escolha: () => m.harness_fullscreen_por_escolha(),
    sem_statusline: () => m.harness_sem_statusline(),
  };
  const ROTULOS: Record<string, () => string> = {
    hooks: m.harness_item_hooks, contas: m.harness_item_contas, credenciais: m.harness_item_credenciais,
    plugins: m.harness_item_plugins, fullscreen: m.harness_item_fullscreen,
    mcp: m.harness_item_mcp, modelo: m.harness_item_modelo,
    bloco: m.harness_item_tmux_bloco, default_terminal: m.harness_item_tmux_term, truecolor: m.harness_item_tmux_truecolor,
    titulo: m.harness_item_tmux_titulo, mouse: m.harness_item_tmux_mouse, persistencia: m.harness_item_tmux_persist,
    skills: m.harness_item_skills, extensoes: m.harness_item_extensoes, statusline: m.harness_item_statusline,
    wrapper: m.harness_item_wrapper,
  };
  function texto(i: ItemHarness): string { return (TEXTOS[i.codigo] ?? (() => i.codigo))(i.params); }
  function rotulo(i: ItemHarness): string { return (ROTULOS[i.id] ?? (() => i.id))(); }

  // Veredito + "por quê?" das linhas que hoje só listam nome de arquivo ou contagem. A cobertura é
  // DECLARADA card a card, nunca herdada de o id coincidir: "Hooks" no Claude e no Kimi são os
  // avisos que o CLI manda pro app, mas no Codex a mesma linha lista os hooks do próprio usuário
  // importados — lá as duas frases seriam falsas. Card novo com um id conhecido não herda a
  // explicação calado: fica sem, até alguém declarar.
  // `quando`: há linha cuja explicação fala de uma AÇÃO, e a ação nem sempre existe. Sem ele, a
  // credencial em dia ganhava "Copia um login que falta" num card onde nada falta e sem o botão
  // Sincronizar ao lado.
  const PORQUE: Record<string, {
    vered: () => string; motivo: () => string; harnesses: string[]; quando?: (i: ItemHarness) => boolean;
  }> = {
    credenciais: { vered: m.harness_item_credenciais_vered, motivo: m.harness_item_credenciais_porque,
                   harnesses: ['codex', 'pi', 'omp', 'kimi'],
                   quando: (i) => !!i.conserto?.startsWith('sync:') },
    extensoes: { vered: m.harness_item_extensoes_vered, motivo: m.harness_item_extensoes_porque,
                 harnesses: ['pi', 'omp'] },
    skills: { vered: m.harness_item_skills_vered, motivo: m.harness_item_skills_porque,
              harnesses: ['pi', 'kimi'] },
    hooks: { vered: m.harness_item_hooks_vered, motivo: m.harness_item_hooks_porque,
             harnesses: ['claude', 'kimi'] },
    contas: { vered: m.harness_item_contas_vered, motivo: m.harness_item_contas_porque,
              harnesses: ['claude'] },
  };
  function porque(item: ItemHarness, harness: string) {
    const p = PORQUE[item.id];
    if (!p || !p.harnesses.includes(harness)) return null;
    return !p.quando || p.quando(item) ? p : null;
  }

  const ETAPAS_INST: Record<string, () => string> = {
    comando: m.harness_inst_etapa_comando,
    conferir: m.harness_inst_etapa_conferir,
    wrapper: m.harness_inst_etapa_wrapper,
    ajustes: m.harness_inst_etapa_ajustes,
  };
  function etapaInst(chave: string | null): string { return (ETAPAS_INST[chave ?? ''] ?? (() => chave ?? ''))(); }

  // A caixa de saída acompanha a última linha: um `npm install` de rede fria escreve por minutos, e
  // uma caixa parada na primeira linha é indistinguível de uma travada. Mas só acompanha quem JÁ
  // está no fim — quem rolou pra cima está lendo o erro, e puxá-lo de volta a cada poll é o oposto
  // do que essa caixa existe pra fazer.
  let logEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const linhas = inst?.log.length ?? 0;
    if (!logEl || !linhas) return;
    if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40) logEl.scrollTop = logEl.scrollHeight;
  });
</script>

<div class="hs">
  <div class="hs-cab">
    <p class="st-secao hs-titulo">{m.harness_titulo()} <EscopoChip escopo="servidor" /></p>
    <button type="button" class="hs-refresh" onclick={atualizar} disabled={carregando || consertando !== null}
      ><span aria-hidden="true">{carregando ? '…' : '↻'}</span>{m.arq_recarregar()}</button>
  </div>
  <p class="hs-leg">{m.harness_legenda()}</p>

  {#each lista as h (h.id)}
    <div class="hs-card" class:fora={!h.instalado}>
      <div class="hs-topo">
        <span class="hs-ponto" class:ok={h.instalado && h.itens.every((i) => i.ok !== false)}
              class:ruim={h.instalado && h.itens.some((i) => i.ok === false)} aria-hidden="true"></span>
        <ProvedorIcone tipo={h.id === 'claude' ? 'claude' : 'chave'}
          baseUrl={h.id === 'kimi' ? 'https://api.kimi.com' : h.id === 'codex' ? 'https://api.openai.com' : ''}
          iniciais={h.id === 'omp' ? 'ω' : h.id === 'pi' ? 'π' : h.id === 'tmux' ? '⌗' : h.nome.slice(0, 2).toUpperCase()} size={22} />
        <span class="hs-nome">{h.nome}</span>
        <span class="hs-versao">{h.instalado ? (h.versao || m.harness_instalado()) : m.harness_nao_instalado()}</span>
      </div>
      {#each h.itens as i (i.id)}
        <div class="hs-item">
          <span class="hs-marca" class:ok={i.ok === true && !i.info} class:ruim={i.ok === false} aria-hidden="true"
            >{i.info ? '·' : i.ok === true ? '✓' : i.ok === false ? '✕' : '?'}</span>
          <span class="hs-item-txt"><b>{rotulo(i)}</b> {texto(i)}</span>
          {#if i.conserto}
            <button type="button" class="hs-btn" onclick={() => consertar(i.conserto!, h.id, i.id)}
              disabled={consertando !== null}
              >{consertando === i.conserto ? '…'
                : i.conserto.startsWith('sync:') ? m.harness_sincronizar()
                : (i.ok === false ? m.harness_consertar() : m.harness_refazer())}</button>
          {/if}
        </div>
        <!-- Fora da linha, não dentro do texto dela: a linha é uma faixa flex com marca, texto e
             botão na mesma altura, e o motivo aberto é um parágrafo de altura variável. -->
        {@const pq = porque(i, h.id)}
        {#if pq}
          <details class="cfg-porque hs-porque">
            <summary><span class="cfg-vered">{pq.vered()}</span> <span class="cfg-pq">{m.config_motores_por_que()}<span class="cfg-chev" aria-hidden="true">▾</span></span></summary>
            <p class="cfg-motivo">{pq.motivo()}</p>
          </details>
        {/if}
        {#if consertoDe?.cli === h.id && consertoDe.item === i.id}
          <div class="hs-conserto" role="status">
            <span>{m.harness_consertando({ item: rotulo(i), s: decorrido })}</span>
            <span class="hs-barra" aria-hidden="true"><span></span></span>
          </div>
        {:else if resultado?.cli === h.id && resultado.item === i.id}
          <p class="hs-conserto" class:erro={!resultado.ok} role={resultado.ok ? 'status' : 'alert'}
            >{resultado.texto}</p>
        {/if}
      {/each}
      <!-- Item que sumiu depois do conserto (ele deixou de se aplicar): o desfecho fica no card. -->
      {#if resultado?.cli === h.id && !h.itens.some((i) => i.id === resultado?.item)}
        <p class="hs-conserto" class:erro={!resultado.ok} role={resultado.ok ? 'status' : 'alert'}
          >{resultado.texto}</p>
      {/if}
      {#if h.id === 'claude'}
        {#if campos?.claude_statusline_update}
          <label class="hs-item hs-opcao">
            <span class="hs-item-txt">
              <b>{m.harness_claude_statusline_atualizar()}</b>
              <!-- Descrição, não nome: dentro do nome o leitor de tela repete a frase inteira a cada
                   foco antes de dizer se está ligado. -->
              <span class="hs-ajuda" id="claude-statusline-ajuda">{m.harness_claude_statusline_ajuda()}</span>
            </span>
            <input id="claude-statusline-update" type="checkbox" class="switch"
              aria-label={m.harness_claude_statusline_atualizar()} aria-describedby="claude-statusline-ajuda"
              checked={!!campos.claude_statusline_update.valor}
              disabled={trocandoStatusline} onchange={trocarStatusline} />
          </label>
        {:else if campos}
          <!-- Backend que não conhece a chave diz o porquê, como a folha dizia: ficar mudo esconde
               justamente a opção que sumiu. -->
          <p class="hs-aviso" role="status">{m.harness_opcoes_indisponiveis()}</p>
        {/if}
        <!-- Erro de GRAVAR daqui, ou de LER do store do modal: sem o segundo, uma leitura que
             falhou deixaria o card sem interruptor e sem explicação. -->
        {#if erroConfig || store.erro}
          <p class="hs-aviso erro" role="alert">{erroConfig || store.erro}</p>
        {/if}
      {/if}
      {#if !h.instalado}
        <div class="hs-item">
          <span class="hs-marca" aria-hidden="true">·</span>
          {#if comandoDe(h)}
            <span class="hs-item-txt">{m.harness_inst_disponivel()}</span>
            <button type="button" class="hs-btn" onclick={() => (confirmar = h)}
              disabled={instalando}>{m.harness_inst_botao()}</button>
          {:else}
            <span class="hs-item-txt">
              {m.harness_inst_manual()}
              {#if manualDe(h)}
                <a class="hs-link" href={manualDe(h)} target="_blank" rel="noreferrer noopener">{manualDe(h)}</a>
              {/if}
            </span>
          {/if}
        </div>
      {/if}
      <!-- Erro do card DESTE harness. Sem a marca de dono, o erro de instalar o omp era desenhado
           dentro do card do Kimi, e o rodapé que existe pro erro solto ficava suprimido. -->
      {#if erroInst && erroInstCli === h.id}
        <p class="hs-aviso erro" role="alert">{erroInst}</p>
      {/if}
      <!-- Fase que este app não conhece não mostra nada. Com `!== 'ocioso'` ela caía no `{:else}`
           e pintava uma falha que não aconteceu — sucesso virando erro é tão mentira quanto o
           contrário. -->
      {#if inst && inst.harness === h.id && (inst.fase === 'rodando' || inst.fase === 'pronto')}
        <div class="hs-inst">
          <p class="hs-aviso" role="status">
            {#if instalando}
              {m.harness_inst_andamento({ passo: inst.passo, total: inst.total, etapa: etapaInst(inst.etapa) })}
              <span class="hs-barra det" role="progressbar" aria-valuemin="0" aria-valuemax="100"
                aria-valuenow={pctIntegracao({ passo: inst.passo, total: inst.total, sub: null })}
                aria-label={m.harness_inst_progresso()}
                ><span style="width: {pctIntegracao({ passo: inst.passo, total: inst.total, sub: null })}%"></span></span>
            {:else if inst.ok}
              {m.harness_inst_pronto()}
            {:else}
              {m.harness_inst_falhou({ etapa: etapaInst(inst.etapa) })}
            {/if}
          </p>
          {#if inst.erro}<p class="hs-aviso erro" role="alert">{inst.erro}</p>{/if}
          <!-- Etapa pulada não pode viver só no log: a manchete acima promete "ligado ao app". -->
          {#each inst.avisos ?? [] as aviso}<p class="hs-aviso" role="status">{aviso}</p>{/each}
          <!-- `tabindex` porque a caixa rola: conteúdo rolável sem foco é inalcançável sem mouse.
               Sem `role="log"` de propósito — faria o leitor narrar cada linha do `npm install`. -->
          {#if inst.log.length}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <!-- O `tabindex` é o certo aqui e a regra não distingue o caso: a caixa ROLA, e
                 conteúdo rolável sem foco não se alcança pelo teclado (WCAG 2.1.1). `group` com
                 rótulo, e não `log`, porque `log` implica região viva e faria o leitor de tela
                 narrar cada linha do `npm install`. -->
            <pre class="hs-inst-log" role="group" tabindex="0" aria-label={m.harness_inst_log()}
              bind:this={logEl}>{inst.log.join('\n')}</pre>
          {/if}
        </div>
      {/if}
      {#if h.id === 'codex'}
        <div class="hs-integracao">
          <div class="hs-item hs-integracao-cab">
            <span class="hs-item-txt"><b>{m.harness_codex_integracao()}</b></span>
            <button type="button" class="hs-btn" onclick={reconciliarIntegracao}
              disabled={integracaoOcupada}
              >{integracaoOcupada ? m.harness_codex_executando() : m.harness_codex_reconciliar()}</button>
          </div>
          <details class="cfg-porque hs-porque">
            <summary><span class="cfg-vered">{m.harness_codex_reconciliar_vered()}</span> <span class="cfg-pq">{m.config_motores_por_que()}<span class="cfg-chev" aria-hidden="true">▾</span></span></summary>
            <p class="cfg-motivo">{m.harness_codex_reconciliar_porque()}</p>
          </details>
          <!-- O seletor existe sempre: com só a conta padrão ele fica apagado com o motivo, como o
               seletor de máquina no topo do modal — sumir esconderia que dá pra ter mais de uma. -->
          <label class="hs-item hs-automatica" for="codex-conta">
            <span class="hs-item-txt">
              <b>{m.codex_ui_account()}</b>
              {#if erroContas}
                <span class="hs-ajuda erro" id="codex-conta-ajuda" role="alert">{m.harness_codex_conta_erro({ erro: erroContas })}</span>
              {:else}
                <span class="hs-ajuda" id="codex-conta-ajuda">{contasCodex.length > 1 ? m.harness_codex_conta_ajuda() : m.harness_codex_conta_so_padrao()}</span>
              {/if}
            </span>
            <select class="hs-conta" id="codex-conta" aria-describedby="codex-conta-ajuda" value={contaCodex}
              onchange={trocarConta} disabled={integracaoOcupada || contasCodex.length <= 1}>
              {#each contasCodex as conta (conta.id)}
                <option value={conta.id}>{conta.name}{conta.is_default ? ` · ${m.criar_padrao()}` : ''}</option>
              {:else}
                <option value="default">{m.criar_padrao()}</option>
              {/each}
            </select>
          </label>
          {#if integracao}
            <label class="hs-item hs-automatica" for="codex-automatica">
              <span class="hs-item-txt">
                <b>{m.harness_codex_automatica()}</b>
                <!-- Descrição, não nome — igual aos três interruptores vizinhos: dentro do nome o
                     leitor de tela repete a frase inteira a cada foco antes de dizer se está ligado. -->
                <span class="hs-ajuda" id="codex-automatica-ajuda">{m.harness_codex_automatica_ajuda()}</span>
              </span>
              <input type="checkbox" class="switch" id="codex-automatica"
                aria-label={m.harness_codex_automatica()} aria-describedby="codex-automatica-ajuda"
                checked={integracao.automatica}
                disabled={trocandoAutomatica} onchange={trocarAutomatica} />
            </label>
            <label class="hs-item hs-automatica" for="codex-memoria">
              <span class="hs-item-txt">
                <b>{m.harness_codex_memoria()}</b>
                <span class="hs-ajuda" id="codex-memoria-ajuda">{m.harness_codex_memoria_ajuda()}</span>
              </span>
              <input type="checkbox" class="switch" id="codex-memoria"
                aria-label={m.harness_codex_memoria()} aria-describedby="codex-memoria-ajuda"
                checked={integracao.memoria}
                disabled={trocandoMemoria} onchange={trocarMemoria} />
            </label>
            <!-- O prazo é lido ANTES de ligar: quem liga e acha que já vale é o defeito que ele evita. -->
            <details class="cfg-porque hs-porque">
              <summary><span class="cfg-vered">{m.harness_codex_memoria_vered()}</span> <span class="cfg-pq">{m.config_motores_por_que()}<span class="cfg-chev" aria-hidden="true">▾</span></span></summary>
              <p class="cfg-motivo">{m.harness_codex_memoria_prazo()}</p>
            </details>
            {#if contaCodex === 'default'}
              <p class="hs-aviso" role="status">
                {ESTADOS_INTEGRACAO[integracao.estado]?.() ?? integracao.estado}
                {#if textoDe(integracao.etapa)} · {textoDe(integracao.etapa)}{/if}
              </p>
              {#if integracao.estado === 'executando' && integracao.progresso}
                {@const p = integracao.progresso}
                <div class="hs-progresso">
                  <span>{m.harness_codex_progresso({ passo: p.passo, total: p.total })}{#if p.sub}
                    · {m.harness_codex_progresso_sub({ atual: p.sub.atual, total: p.sub.total })}{/if}{#if integracao.etapa_segundos != null}
                    · {m.harness_codex_etapa_tempo({ s: integracao.etapa_segundos })}{/if}</span>
                  <span class="hs-barra det" role="progressbar" aria-valuemin="0" aria-valuemax="100"
                    aria-valuenow={pctIntegracao(p)} aria-label={m.harness_codex_integracao()}
                    ><span style="width: {pctIntegracao(p)}%"></span></span>
                </div>
              {/if}
              <p class="hs-aviso">{m.harness_codex_ultima({ data: dataIntegracao(integracao.ultima_execucao) })}</p>
              {#if integracao.proxima_atualizacao}
                <p class="hs-aviso">{m.harness_codex_proxima({ data: dataIntegracao(integracao.proxima_atualizacao) })}</p>
              {/if}
              <p class="hs-aviso">{m.harness_codex_plugins({ n: integracao.plugins.length })}</p>
              {#if integracao.skills}
                <p class="hs-aviso">{m.harness_codex_skills({ ponte: integracao.skills.ponte, nativas: integracao.skills.nativas })}</p>
              {/if}
              {#if integracao.plugins.length}
                <ul class="hs-plugins">
                  {#each integracao.plugins as plugin}
                    <li><b>{plugin.id}</b> · {plugin.versao} · {plugin.origem}</li>
                  {/each}
                </ul>
              {/if}
              {#if integracao.confianca_pendente}
                <p class="hs-aviso" role="status">{m.harness_codex_confianca()}</p>
              {/if}
              {#each integracao.avisos as aviso}<p class="hs-aviso">{textoDe(aviso)}</p>{/each}
              {#each integracao.erros as falha}<p class="hs-aviso erro" role="alert">{textoDe(falha)}</p>{/each}
            {:else if contaSelecionada && syncConta}
              {#if contaSelecionada.auth.email}<p class="hs-aviso">{contaSelecionada.auth.email}</p>{/if}
              <p class="hs-aviso" role="status">{ESTADOS_CONTA[syncConta.status]?.() ?? syncConta.status}</p>
              {#if syncConta.trust_pending}
                <p class="hs-aviso" role="status">{m.harness_codex_confianca()}</p>
              {/if}
              {#each syncConta.issues as issue (`${issue.code}:${JSON.stringify(issue.params)}`)}
                <p class="hs-aviso" class:erro={syncConta.status === 'error'}>{codexAccountMessage(issue)}</p>
              {/each}
            {/if}
          {/if}
          {#if opcoesDoCodex}
            {@const dado = opcoesDoCodex}
            <label class="hs-item hs-opcao">
              <span class="hs-item-txt">
                <b>{m.codex_contexto_titulo()}</b>
                <span class="hs-ajuda" id="codex-contexto-ajuda">{m.codex_contexto_ajuda()}</span>
              </span>
              <input id="codex-contexto-estendido" type="checkbox" class="switch"
                aria-label={m.codex_contexto_titulo()} aria-describedby="codex-contexto-ajuda"
                checked={dado.contexto_estendido} disabled={trocandoOpcoesCodex}
                onchange={(ev) => trocarOpcaoCodex(ev, 'contexto_estendido')} />
            </label>
            <label class="hs-item hs-opcao">
              <span class="hs-item-txt">
                <b>{m.codex_voice_config_title()} <i class="hs-beta">{m.comum_beta()}</i></b>
                <span class="hs-ajuda" id="codex-voz-ajuda">{m.codex_voice_config_help()}</span>
              </span>
              <input id="codex-voice-beta" type="checkbox" class="switch"
                aria-label="{m.codex_voice_config_title()} {m.comum_beta()}" aria-describedby="codex-voz-ajuda"
                checked={dado.codex_voice_beta} disabled={trocandoOpcoesCodex}
                onchange={(ev) => trocarOpcaoCodex(ev, 'codex_voice_beta')} />
            </label>
            <p class="hs-aviso">{m.codex_contexto_novas()}</p>
            {#if dado.modelos.length}
              <p class="hs-aviso">{m.codex_contexto_limites()}</p>
              <ul class="hs-plugins">
                {#each dado.modelos as modelo (modelo.model)}<li>{modelo.model}: {modelo.max.toLocaleString()}</li>{/each}
              </ul>
            {:else}
              <p class="hs-aviso">{m.codex_contexto_sem_catalogo()}</p>
            {/if}
            {#if dado.compactacao}
              <p class="hs-aviso">{m.codex_contexto_compactacao({ n: dado.compactacao.toLocaleString() })}</p>
            {/if}
          {/if}
          {#if erroOpcoesCodex}<p class="hs-aviso erro" role="alert">{erroOpcoesCodex}</p>{/if}
          {#if erroIntegracao}<p class="hs-aviso erro" role="alert">{erroIntegracao}</p>{/if}
        </div>
      {/if}
    </div>
  {/each}

  {#if feito}<p class="hs-aviso" role="status">{feito}</p>{/if}
  {#if erro}<p class="hs-aviso erro" role="alert">{erro}</p>{/if}
  <!-- Só o erro que não achou dono na lista (falha do poll na montagem): com seis cards, o erro
       de instalar o Kimi desenhado embaixo do tmux não se liga a nada. -->
  {#if erroInst && !lista.some((h) => h.id === erroInstCli)}
    <p class="hs-aviso erro" role="alert">{erroInst}</p>
  {/if}
</div>

{#if confirmar}
  {@const alvo = confirmar}
  <ConfirmDialog
    title={m.harness_inst_conf_titulo({ nome: alvo.nome })}
    aria={m.harness_inst_conf_titulo({ nome: alvo.nome })}
    role="dialog"
    wide
    actions={[
      { label: m.harness_inst_conf_cancelar(), onClick: () => (confirmar = null) },
      { label: m.harness_inst_botao(), kind: 'primary', onClick: () => instalar(alvo) },
    ]}
    onClose={() => (confirmar = null)}
  >
    <p class="hs-conf-txt">{m.harness_inst_conf_corpo()}</p>
    <pre class="hs-conf-cmd">{comandoDe(alvo)}</pre>
    <p class="hs-conf-txt">{m.harness_inst_conf_depois()}</p>
  </ConfirmDialog>
{/if}

<style>
  .hs { container-type: inline-size; padding: var(--space-2) var(--space-3) var(--space-5); }
  .hs-cab { display: flex; align-items: center; gap: var(--space-2); margin: 0 0 var(--space-1); }
  .hs-titulo { flex: 1; margin: 0; }
  /* Ícone com texto ao lado, nas duas larguras: no toque não há dica de ferramenta que explique o ↻. */
  .hs-refresh { min-height: 28px; padding: 0 var(--space-2); display: inline-flex; align-items: center; gap: 6px;
                border-radius: var(--radius-full); background: transparent; border: 1px solid var(--border-subtle);
                color: var(--text-secondary); font-size: var(--text-xs); }
  .hs-leg { margin: 0 0 var(--space-3); font-size: var(--text-xs); color: var(--text-muted); }
  .hs-card { padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2);
             border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
             background: var(--surface-inset); }
  .hs-card.fora { opacity: 0.6; }
  .hs-topo { display: flex; align-items: center; gap: var(--space-2); }
  .hs-ponto { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .hs-ponto.ok { background: var(--success, #3fb950); }
  .hs-ponto.ruim { background: var(--error); }
  .hs-nome { flex: 1; font-weight: 600; color: var(--text-primary); }
  .hs-versao { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); }
  .hs-item { display: flex; align-items: center; gap: var(--space-2); margin-top: 6px; font-size: var(--text-sm); }
  .hs-marca { width: 16px; text-align: center; color: var(--text-muted); font-size: var(--text-xs); }
  .hs-marca.ok { color: var(--success, #3fb950); }
  .hs-marca.ruim { color: var(--error); }
  .hs-item-txt { flex: 1; min-width: 0; color: var(--text-secondary); overflow-wrap: anywhere; }
  .hs-item-txt b { color: var(--text-primary); font-weight: 600; }
  .hs-automatica, .hs-opcao { cursor: pointer; }
  .hs-beta { display: inline-block; margin-left: var(--space-1); padding: 1px 6px; border-radius: var(--radius-full);
             background: var(--accent-dim); color: var(--accent); font-size: 10px; font-style: normal; text-transform: uppercase; }
  .hs-ajuda { display: block; font-size: var(--text-xs); color: var(--text-muted); }
  .hs-ajuda.erro { color: var(--error); }
  /* `.cfg-porque` é global (app.css). O recuo alinha o motivo com o texto da linha, e não com a
     marca ✓/✕ dela (16px da marca + o gap da faixa). */
  .hs-porque { margin-left: calc(16px + var(--space-2)); }
  .hs-btn { flex-shrink: 0; min-height: 0; height: 26px; padding: 0 var(--space-2);
            font-size: var(--text-xs); border-radius: var(--radius-sm);
            background: var(--surface-raised); border: 1px solid var(--border-subtle); color: var(--text-primary); }
  @container (max-width: 400px) {
    .hs-topo { flex-wrap: wrap; }
    /* Alvo de toque: no celular o ↻ é o único jeito de reler a tela (não há "tentar de novo"). */
    .hs-refresh { min-height: 44px; }
  }
  .hs-aviso { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-secondary); }
  .hs-aviso.erro { color: var(--error); }
  .hs-conserto { margin: var(--space-1) 0 0; padding-left: 22px; font-size: var(--text-xs);
                 color: var(--text-secondary); overflow-wrap: anywhere; }
  .hs-conserto.erro { color: var(--error); }
  /* Barra indeterminada: sem porcentagem porque não há medida do quanto falta. A animação é num
     span HTML (compõe na GPU; em svg repintaria a página a cada quadro). */
  .hs-barra { display: block; position: relative; height: 3px; margin-top: var(--space-1);
              border-radius: 2px; overflow: hidden; background: var(--border-subtle); }
  .hs-barra span { position: absolute; inset: 0; width: 35%; border-radius: 2px;
                   background: var(--accent); animation: hs-barra 1.2s ease-in-out infinite; }
  @keyframes hs-barra { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
  /* Determinada: a largura é a medida que o servidor informou, sem animação de vai-e-vem. */
  .hs-progresso { margin: var(--space-1) 0 0; font-size: var(--text-xs); color: var(--text-secondary); }
  .hs-barra.det span { animation: none; transition: width .4s ease; }
    @media (prefers-reduced-motion: reduce) {
      .hs-barra span { animation: none; width: 100%; opacity: .5; }
      .hs-barra.det span { transition: none; }
    }
  .hs-link { color: var(--accent); overflow-wrap: anywhere; }
  /* `--surface-raised`, e não `--bg-elevated` cru: o card já é `--surface-inset` e as duas
     superfícies precisam acompanhar o véu do papel de parede juntas (regra do CLAUDE.md). */
  .hs-inst-log { margin: var(--space-1) 0 0; padding: var(--space-2); max-height: 190px; overflow: auto;
                 background: var(--surface-raised); border: 1px solid var(--border-subtle);
                 border-radius: var(--radius-sm); font-family: var(--font-mono);
                 font-size: var(--text-xs); color: var(--text-secondary);
                 white-space: pre-wrap; overflow-wrap: anywhere; }
  .hs-inst { margin-top: var(--space-1); }
  /* Escopado: o corpo do ConfirmDialog entra por snippet, compilado no escopo DESTE arquivo. */
  .hs-conf-txt { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  /* Selecionável de propósito: ninguém aprova instalar software sem poder copiar e conferir o
     comando exato que vai rodar. */
  .hs-conf-cmd { margin: 0; padding: var(--space-2); user-select: text;
                 background: var(--surface-raised); border: 1px solid var(--border-subtle);
                 border-radius: var(--radius-sm); font-family: var(--font-mono);
                 font-size: var(--text-xs); color: var(--text-primary);
                 white-space: pre-wrap; overflow-wrap: anywhere; }
  .hs-integracao { border-top: 1px solid var(--border-subtle); margin-top: var(--space-2); padding-top: var(--space-1); }
  .hs-integracao-cab { flex-wrap: wrap; }
  .hs-conta { max-width: 240px; min-height: 30px; padding: 0 var(--space-2);
              border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
              background: var(--surface-raised); color: var(--text-primary); font-size: var(--text-xs); }
  .hs-integracao .hs-aviso, .hs-plugins { overflow-wrap: anywhere; }
  .hs-plugins { margin: var(--space-1) 0 0; padding-left: var(--space-4); font-size: var(--text-xs); color: var(--text-secondary); }
</style>
