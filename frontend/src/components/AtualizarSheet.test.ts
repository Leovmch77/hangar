// @vitest-environment happy-dom
// A caixa de Atualizar nos quatro estados, e a regra que dá razão a ela existir: durante o restart
// a conexão CAI por desenho, e a tela tem que continuar dizendo "atualizando" em vez de
// "desconectado" — que é a mesma frase que ela usa quando o servidor caiu de verdade.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import AtualizarSheet from './AtualizarSheet.svelte';
import * as m from '../paraglide/messages';
import * as api from '@hangar/core';
import * as auth from '../lib/auth';
import type { Atualizacao, Server, UpdateAllState } from '@hangar/core';

function base(over: Partial<Atualizacao> = {}): Atualizacao {
  return {
    versoes: { repo: 'v1-abc', backend: 'v1-abc' },
    atualizacao_disponivel: false,
    mudancas: [],
    passos: [],
    pre_voo: { pode: true, faltando: [] },
    estado: {},
    ...over,
  };
}

let alvo: HTMLElement;
let comp: Record<string, unknown> | null = null;

function montar(props: Record<string, unknown> = {}) {
  alvo = document.createElement('div');
  document.body.appendChild(alvo);
  comp = mount(AtualizarSheet, { target: alvo,
    props: Object.defineProperties({ open: true, onClose: () => {} }, Object.getOwnPropertyDescriptors(props)) });
  return alvo;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, 'listOwnServers').mockReturnValue([]);
  vi.spyOn(auth, 'servidorDaOrigem').mockReturnValue(null);
});

describe('atualizar todas as máquinas', () => {
  const local: Server = { id: 'local', label: 'Casa', baseUrl: window.location.origin, token: 'test' };
  const remote: Server = { id: 'remote', label: 'Trabalho', baseUrl: 'https://remote.test', token: 'test' };
  const button = () => [...document.querySelectorAll('button')]
    .find((element) => element.textContent?.includes(m.update_all_button({ n: 2 })));

  beforeEach(() => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(base({ atualizacao_disponivel: true }));
    vi.mocked(auth.listOwnServers).mockReturnValue([local, remote]);
    vi.mocked(auth.servidorDaOrigem).mockReturnValue(local);
  });

  it('oferece o botão com duas máquinas próprias elegíveis', async () => {
    montar(); await tick(); await tick();
    expect(button()).toBeTruthy();
    expect(document.body.textContent).toContain(m.atualizar_botao());
  });

  it('esconde o botão com uma máquina, sem contar convites, efêmeras ou desligadas', async () => {
    vi.mocked(auth.listOwnServers).mockReturnValue([
      local, { ...remote, invite: true }, { ...remote, ephemeral: true }, { ...remote, disabled: true },
    ]);
    montar(); await tick(); await tick();
    expect(button()).toBeUndefined();
  });

  it('oferece atualizar todas mesmo quando esta máquina está em dia', async () => {
    vi.mocked(api.getAtualizacao).mockResolvedValue(base());
    montar(); await tick(); await tick();
    expect(button()).toBeTruthy();
  });

  it('mantém o botão original atualizando só a máquina selecionada', async () => {
    const start = vi.spyOn(api, 'iniciarAtualizacao').mockResolvedValue({ ok: true, pid: 1 });
    const all = vi.spyOn(api, 'updateAll');
    montar(); await tick(); await tick();
    [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === m.atualizar_botao())!.click();
    await tick(); await tick();
    expect(start).toHaveBeenCalledOnce();
    expect(all).not.toHaveBeenCalled();
  });

  it.each([
    { fase: 'pronto', ok: false, erro: 'fixture-error' },
    { fase: 'pronto', ok: true, avisos: ['fixture-warning'] },
    { fase: 'pronto', ok: true, reiniciar_manual: true },
  ] as const)('oferece atualizar todas após o desfecho anterior %j', async (state) => {
    vi.mocked(api.getAtualizacao).mockResolvedValue(base({
      atualizacao_disponivel: true, estado: { ...state, avisos: 'avisos' in state ? [...(state.avisos ?? [])] : [] },
    }));
    montar(); await tick(); await tick();
    expect(button()).toBeTruthy();
  });

  it('fecha e reabre a folha para permitir uma nova rodada', async () => {
    const opened = writable(true);
    const reactive = fromStore(opened);
    vi.spyOn(api, 'updateAll').mockResolvedValue([
      { server: remote, state: { status: 'em_dia', warnings: [] } },
    ]);
    montar({ get open() { return reactive.current; }, onClose: () => opened.set(false) });
    await tick(); await tick();
    button()!.click(); await tick(); await tick();
    [...document.querySelectorAll('button')].find((element) => element.textContent === m.atualizar_fechar())!.click();
    await tick();
    opened.set(true); await tick(); await tick();
    expect(button()).toBeTruthy();
    expect(document.body.textContent).toContain(m.atualizar_botao());
  });

  it('acompanha etapas, mantém o sheet aberto e passa a origem por último', async () => {
    let publish!: (serverId: string, state: UpdateAllState) => void;
    let finish!: (value: Awaited<ReturnType<typeof api.updateAll>>) => void;
    const run = vi.spyOn(api, 'updateAll').mockImplementation((_servers, onChange) => {
      publish = onChange;
      return new Promise((resolve) => { finish = resolve; });
    });
    const close = vi.fn();
    montar({ onClose: close }); await tick(); await tick();
    button()!.click(); await tick();
    expect(run).toHaveBeenCalledWith([local, remote], expect.any(Function), { last: local.id });
    expect(document.body.textContent).toContain(m.update_all_checking());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    publish(remote.id, { status: 'rodando', state: { texto: 'fixture-step', passo: 2, total: 5 }, warnings: [] });
    await tick();
    expect(document.body.textContent).toContain(remote.label);
    expect(document.body.textContent).toContain(m.update_all_running({ texto: 'fixture-step', passo: 2, total: 5 }));
    publish(remote.id, { status: 'esperando', warnings: [] }); await tick();
    expect(document.body.textContent).toContain(m.update_all_waiting());
    const state: UpdateAllState = { status: 'atualizado', warnings: ['fixture-warning'] };
    finish([{ server: remote, state }]); await tick(); await tick();
    expect(document.body.textContent).toContain(m.update_all_updated());
    expect(document.body.textContent).toContain(m.update_all_warnings());
    expect(document.body.textContent).toContain('fixture-warning');
  });

  it.each([
    [{ status: 'consultando' }, () => m.update_all_checking()],
    [{ status: 'iniciando' }, () => m.update_all_starting()],
    [{ status: 'em_dia' }, () => m.update_all_up_to_date()],
    [{ status: 'travado', reason: 'branch' }, () => m.update_all_held_branch()],
    [{ status: 'travado', reason: 'mudancas' }, () => m.update_all_held_changes()],
    [{ status: 'travado', reason: 'rodando' }, () => m.update_all_held_running()],
    [{ status: 'travado', reason: 'falta' }, () => m.update_all_held_missing()],
    [{ status: 'fora_do_ar' }, () => m.update_all_offline()],
    [{ status: 'atualizado_manual' }, () => m.update_all_updated_manual()],
    [{ status: 'falhou', error: 'fixture-error' }, () => m.update_all_failed({ erro: 'fixture-error' })],
    [{ status: 'falhou', errorCode: 'silent' }, () => m.update_all_failed({ erro: m.update_all_silent() })],
    [{ status: 'falhou', errorCode: 'timeout' }, () => m.update_all_failed({ erro: m.update_all_timeout() })],
  ] satisfies [Partial<UpdateAllState>, () => string][])('mostra o desfecho %j', async (partial, label) => {
    const state = { ...partial, warnings: [] } as UpdateAllState;
    vi.spyOn(api, 'updateAll').mockImplementation(async (_servers, onChange) => {
      onChange(remote.id, state);
      return [{ server: remote, state }];
    });
    montar(); await tick(); await tick();
    button()!.click(); await tick(); await tick();
    expect(document.body.textContent).toContain(remote.label);
    expect(document.body.textContent).toContain(label());
    expect(document.body.textContent).not.toContain(local.label);
  });

  it('mostra erro de execução e lista vazia sem esconder a falha', async () => {
    const run = vi.spyOn(api, 'updateAll').mockRejectedValueOnce(new Error('fixture-error')).mockResolvedValueOnce([]);
    montar(); await tick(); await tick();
    button()!.click(); await tick(); await tick();
    expect(document.body.textContent).toContain(m.update_all_failed({ erro: 'fixture-error' }));
    [...document.querySelectorAll('button')].find((element) => element.textContent === m.atualizar_tentar_de_novo())!.click();
    await tick(); await tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(m.busca_nenhum_resultado());
    expect(document.body.textContent).not.toContain('fixture-error');
  });

  it.each([false, true])('recarrega após atualizar a origem, preservando avisos: %s', async (warning) => {
    vi.useFakeTimers();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    vi.spyOn(api, 'updateAll').mockResolvedValue([
      { server: remote, state: { status: 'em_dia', warnings: [] } },
      { server: local, state: { status: 'atualizado', warnings: warning ? ['fixture-warning'] : [] } },
    ]);
    try {
      montar(); await vi.advanceTimersByTimeAsync(0);
      button()!.click(); await vi.advanceTimersByTimeAsync(0);
      if (warning) {
        expect(reload).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('fixture-warning');
        [...document.querySelectorAll('button')].find((element) => element.textContent === m.nav_recarregar())!.click();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

afterEach(() => {
  if (comp) unmount(comp);
  comp = null;
  alvo?.remove();
});

describe('em dia', () => {
  it('reinício só recarrega após confirmar a tentativa pedida, mesmo com pid diferente', async () => {
    vi.useFakeTimers();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const spy = vi.spyOn(api, 'getAtualizacao').mockResolvedValue(base({
      versoes: { repo: 'v2', backend: 'v1' }, pre_voo: { pode: true, faltando: [], topologia: 'systemd' },
    }));
    vi.spyOn(api, 'reiniciarServidor').mockResolvedValue({ ok: true, pid: 42, request_id: 'restart-a' });
    try {
      montar(); await vi.advanceTimersByTimeAsync(0);
      [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(m.atualizar_reiniciar_botao()))!.click();
      await vi.advanceTimersByTimeAsync(0);
      spy.mockResolvedValue(base({ estado: { fase: 'rodando', pid: 88, request_id: 'restart-a' } }));
      await vi.advanceTimersByTimeAsync(2000);
      spy.mockResolvedValue(base({ estado: { fase: 'pronto', ok: true, pid: 88, request_id: 'restart-old' } }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(reload).not.toHaveBeenCalled();
      spy.mockResolvedValue(base({ estado: { fase: 'pronto', ok: true, pid: 88, request_id: 'restart-a' } }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(reload).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('build pendente no CI não vira atualização incompleta: o campo de servidor antigo é ignorado', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(base({ estado: {
      fase: 'pronto', ok: true, waiting_for_server_build: true, commit_para: '991bb4f123456789',
      avisos: ['fixture-warning'],
    } }));
    montar();
    await tick();
    await tick();
    expect(document.body.textContent).toContain(m.atualizar_em_dia_titulo());
    expect(document.body.textContent).not.toContain('991bb4f1');
  });

  it('mostra uma versão só quando disco e servidor batem', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(base());
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_em_dia_titulo());
    // A segunda versão é diagnóstico: quem só usa não precisa dela quando as duas são iguais.
    expect(txt).not.toContain(m.atualizar_versao_servidor());
  });

  it('sem commit novo, mas com o servidor atrasado, ainda diz o que fazer', async () => {
    // O caso de quem puxou pela linha de comando e não reiniciou: não há nada a baixar, mas a
    // máquina não está rodando o que tem no disco. Sem isto a informação existia e era inalcançável.
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: false, versoes: { repo: 'v2-novo', backend: 'v1-velho' } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain(m.atualizar_precisa_reiniciar());
  });

  it('mostra as duas quando divergem, com o aviso de reiniciar', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' } }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_versao_servidor());
    expect(txt).toContain('v1-velho');
    expect(txt).toContain(m.atualizar_precisa_reiniciar());
  });

  it('divergiu no systemd: oferece o botão e ele chama o reinício', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
             pre_voo: { pode: true, faltando: [], topologia: 'systemd' } }),
    );
    const rei = vi.spyOn(api, 'reiniciarServidor').mockResolvedValue({ ok: true, pid: 1 });
    montar();
    await tick();
    await tick();
    const bt = [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes(m.atualizar_reiniciar_botao()));
    expect(bt).toBeTruthy();
    bt!.click();
    await tick();
    expect(rei).toHaveBeenCalled();
  });

  it('durante o reinício a caixa mostra a etapa que o servidor grava, não o botão parado', async () => {
    // O reinício avulso tem etapas próprias (trocar a tela, reiniciar) e o backend as grava; a
    // caixa ficava em "Tudo em dia" com "Reiniciando…" porque o laço da espera só comparava
    // versões e nunca guardava o estado.
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
        base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
               pre_voo: { pode: true, faltando: [], topologia: 'systemd' } }),
      );
      vi.spyOn(api, 'reiniciarServidor').mockResolvedValue({ ok: true, pid: 1 });
      montar();
      await vi.advanceTimersByTimeAsync(0);
      spy.mockResolvedValue(base({
        versoes: { repo: 'v2-novo', backend: 'v1-velho' },
        pre_voo: { pode: true, faltando: [], topologia: 'systemd' },
        estado: { fase: 'rodando', passo: 1, total: 2, texto: 'Trocando a tela pelo build publicado' },
      }));
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes(m.atualizar_reiniciar_botao()))!.click();
      await vi.advanceTimersByTimeAsync(2100);
      const txt = document.body.textContent ?? '';
      expect(txt).toContain(m.atualizar_rodando_titulo());
      expect(txt).toContain(m.atualizar_rodando_sub({ passo: 1, total: 2 }));
      expect(txt).toContain('Trocando a tela pelo build publicado');
    } finally {
      vi.useRealTimers();
    }
  });

  it('desmontar no meio da espera do restart não recarrega a tela de quem saiu', async () => {
    // O laço da espera é solto (não é um $effect), então a destruição do DesktopShell o deixava
    // rodando: ao ver as versões baterem ele chamava location.reload() em quem já tinha navegado.
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
        base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
               pre_voo: { pode: true, faltando: [], topologia: 'systemd' } }),
      );
      vi.spyOn(api, 'reiniciarServidor').mockResolvedValue({ ok: true, pid: 1 });
      montar();
      await vi.advanceTimersByTimeAsync(0);
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.includes(m.atualizar_reiniciar_botao()))!.click();
      await vi.advanceTimersByTimeAsync(2100);
      const antes = spy.mock.calls.length;

      unmount(comp!);
      comp = null;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spy.mock.calls.length).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reinício que falhou aparece na tela, não só no servidor', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
             estado: { reinicio_erro: 'RuntimeError: nao consegui reiniciar o servidor' } }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_reinicio_falhou());
    expect(txt).toContain('nao consegui reiniciar o servidor');
  });

  it('instalação manual não oferece botão nenhum — não há serviço pra reiniciar', async () => {
    // Sem isto o botão apareceria e só serviria pra devolver 409 na cara de quem clicou.
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
             pre_voo: { pode: true, faltando: [], topologia: 'manual' } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').not.toContain(m.atualizar_reiniciar_botao());
  });

  it('no Windows oferece o botão — a tarefa agendada reinicia como o systemd', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
             pre_voo: { pode: true, faltando: [], topologia: 'windows' } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain(m.atualizar_reiniciar_botao());
  });

  it('sem topologia conhecida não oferece o botão', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ versoes: { repo: 'v2-novo', backend: 'v1-velho' },
             pre_voo: { pode: true, faltando: [] } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').not.toContain(m.atualizar_reiniciar_botao());
  });
});

describe('versão nova', () => {
  const dez = Array.from({ length: 10 }, (_, i) => ({ sha: `s${i}`, titulo: `mudança ${i}` }));

  it('lista as novidades e o botão', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: true, mudancas: dez.slice(0, 2) }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_disponivel_titulo());
    expect(txt).toContain('mudança 0');
    expect(txt).toContain(m.atualizar_botao());
  });

  it('numa branch de trabalho não oferece o botão, e diz qual é a branch', async () => {
    // Medido em 25/08/2026: atualizar com o checkout na `mobile-expo` levou a branch junto no
    // `reset --hard origin/main`. O backend passou a recusar; a tela não pode nem oferecer.
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: true, mudancas: [{ sha: 'a1', titulo: 'algo novo' }],
             pre_voo: { pode: true, faltando: [], branch: 'mobile-expo',
                        branch_de_trabalho: true } }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_branch_bloqueia({ branch: 'mobile-expo', alvo: 'main' }));
    expect(txt).not.toContain(m.atualizar_botao());
  });

  it('com branch de teste configurada, a recusa nomeia o alvo e não a main', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: true, mudancas: [],
             pre_voo: { pode: true, faltando: [], branch: 'outra', alvo: 'teste',
                        branch_de_trabalho: true } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain(
      m.atualizar_branch_bloqueia({ branch: 'outra', alvo: 'teste' }));
  });

  it('corta em 5 e resume o resto', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: true, mudancas: dez }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain('mudança 4');
    expect(txt).not.toContain('mudança 5');
    expect(txt).toContain(m.atualizar_e_mais({ n: 5 }));
  });

  it('não lista os passos como tarefa de quem usa', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({
        atualizacao_disponivel: true,
        mudancas: dez.slice(0, 1),
        passos: [{ id: 'p1', titulo: 'Rodar o instalador', texto: '' }],
      }),
    );
    montar();
    await tick();
    await tick();
    // Passo sem texto próprio não aparece: o que a atualização precisa fazer é problema do app.
    expect(document.body.textContent ?? '').not.toContain('Rodar o instalador');
  });

  it('avisa quantas sessões estão trabalhando', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: true, mudancas: dez.slice(0, 1) }),
    );
    montar({ trabalhando: 2 });
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain(m.atualizar_sessoes_trabalhando({ n: 2 }));
  });

  it('o botão chama o início', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ atualizacao_disponivel: true, mudancas: dez.slice(0, 1) }),
    );
    const ini = vi.spyOn(api, 'iniciarAtualizacao').mockResolvedValue({ ok: true, pid: 7 });
    montar();
    await tick();
    await tick();
    const botao = [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === m.atualizar_botao());
    botao?.click();
    await tick();
    expect(ini).toHaveBeenCalled();
  });
});

describe('atualizando', () => {
  it('mostra a etapa e a barra', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ estado: { fase: 'rodando', passo: 3, total: 5, texto: 'Instalando dependências' } }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_rodando_titulo());
    expect(txt).toContain('Instalando dependências');
    expect(txt).toContain(m.atualizar_rodando_sub({ passo: 3, total: 5 }));
  });

  it('a conexão caindo NÃO vira "desconectado" enquanto roda', async () => {
    // O restart derruba a conexão por desenho. Se isto virasse mensagem de erro, a tela diria a
    // mesma coisa que diz quando o servidor caiu de verdade — a confusão que este desenho evita.
    const spy = vi.spyOn(api, 'getAtualizacao');
    spy.mockResolvedValueOnce(base({ estado: { fase: 'rodando', passo: 2, total: 5, texto: 'x' } }));
    spy.mockRejectedValue(new Error('Failed to fetch'));
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain(m.atualizar_rodando_titulo());
    expect(document.body.textContent ?? '').not.toContain('Failed to fetch');
  });
});

describe('ciclo de vida', () => {
  it('servidor demorando pra voltar NÃO para o acompanhamento', async () => {
    // O caso comum, não a borda: restart de systemd passa dos 2s do intervalo com folga. Antes,
    // qualquer tique que não visse `rodando` encerrava o acompanhamento — a barra congelava sem
    // erro nenhum e nada mais reagendava.
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'getAtualizacao');
      spy.mockResolvedValueOnce(base({ estado: { fase: 'rodando', passo: 4, total: 5, texto: 'x' } }));
      spy.mockRejectedValue(new Error('Failed to fetch'));   // servidor reiniciando, demorado
      const spyIni = vi.spyOn(api, 'iniciarAtualizacao').mockResolvedValue({ ok: true, pid: 1 });
      montar({ trabalhando: 0 });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(6000);
      const depoisDeSeisSegundos = spy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(spy.mock.calls.length).toBeGreaterThan(depoisDeSeisSegundos);
      expect(document.body.textContent ?? '').not.toContain('Failed to fetch');
      expect(spyIni).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('um tique que estoura NÃO mata o acompanhamento', async () => {
    // A corrente de setTimeout tinha ponto único de falha: um elo que não reagendasse (exceção,
    // await pendurado, retorno cedo) matava tudo calado, e a barra congelava na etapa em que
    // estava. Aconteceu em produção com a tela parada em "Etapa 4 de 5".
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'getAtualizacao');
      spy.mockResolvedValueOnce(base({ estado: { fase: 'rodando', passo: 4, total: 5, texto: 'x' } }));
      spy.mockRejectedValueOnce(new Error('caiu'));
      spy.mockImplementationOnce(() => { throw new Error('estourou sincrono'); });
      spy.mockResolvedValue(base({ estado: { fase: 'rodando', passo: 4, total: 5, texto: 'x' } }));
      montar();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(8000);
      const ate = spy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(8000);
      expect(spy.mock.calls.length).toBeGreaterThan(ate);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mostra o tempo correndo na etapa', async () => {
    // O `npm ci --silent` não imprime NADA: sem relógio, a tela é idêntica a uma travada durante
    // o minuto inteiro em que ele roda.
    const inicio = new Date(Date.now() - 75_000).toISOString();
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ estado: { fase: 'rodando', passo: 4, total: 5,
                       texto: 'Instalando dependências', etapa_inicio: inicio } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain('1min 15s');
  });

  it('não fecha enquanto está atualizando', async () => {
    // Fechar no meio não interrompe nada (o motor roda fora do navegador), mas some com a única
    // janela que mostra o que está acontecendo — e reabrir depois ninguém descobre sozinho.
    const fechou = vi.fn();
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ estado: { fase: 'rodando', passo: 3, total: 5, texto: 'x',
                       ts: new Date().toISOString() } }),
    );
    montar({ onClose: fechou });
    await tick();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(fechou).not.toHaveBeenCalled();
  });

  it('estado congelado em "rodando" NÃO prende a caixa pra sempre', async () => {
    // O processo pode morrer sem escrever o desfecho (kill, queda de energia). Sem teto, a trava
    // deixaria um modal centrado permanentemente na tela — sem Escape, sem clique fora, sem ×.
    const fechou = vi.fn();
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ estado: { fase: 'rodando', passo: 3, total: 5, texto: 'x',
                       ts: new Date(Date.now() - 30 * 60_000).toISOString() } }),
    );
    montar({ onClose: fechou });
    await tick();
    await tick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(fechou).toHaveBeenCalled();
  });

  it('fecha normalmente quando NÃO está atualizando', async () => {
    const fechou = vi.fn();
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(base());
    montar({ onClose: fechou });
    await tick();
    await tick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(fechou).toHaveBeenCalled();
  });

  it('mostra o log dos comandos quando existe', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ estado: { fase: 'rodando', passo: 4, total: 5, texto: 'Instalando dependências',
                       log: ['$ bash install.sh --update', 'npm ci: ok'] } }),
    );
    montar();
    await tick();
    await tick();
    // ABERTO por padrão: a caixinha existe pro minuto em que a etapa parece travada, e exigir um
    // clique ali é esconder a resposta bem na hora da pergunta.
    expect(document.body.textContent ?? '').toContain('$ bash install.sh --update');
    expect(document.body.textContent ?? '').toContain(m.atualizar_esconder_log());

    const botao = [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === m.atualizar_esconder_log());
    botao?.click();
    await tick();
    expect(document.body.textContent ?? '').not.toContain('$ bash install.sh --update');
  });

  it('desmontar o componente para o polling', async () => {
    // Sem isto o timer sobrevive à destruição do DesktopShell (navegar pra Custos/Arquivo) e, ao
    // terminar a atualização, chama location.reload() na cara de quem já estava noutra tela.
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
        base({ estado: { fase: 'rodando', passo: 1, total: 5, texto: 'x' } }),
      );
      montar();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2100);
      const antes = spy.mock.calls.length;
      expect(antes).toBeGreaterThan(1);   // estava mesmo pollando

      unmount(comp!);
      comp = null;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spy.mock.calls.length).toBe(antes);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deu erro', () => {
  it('pull que tocou shell/ avisa pra reabrir o app — só dentro da janela nativa', async () => {
    const uaOriginal = navigator.userAgent;
    const comUa = (ua: string) => Object.defineProperty(navigator, 'userAgent', {
      value: ua, configurable: true, writable: true,
    });
    try {
      vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
        base({ estado: { fase: 'pronto', ok: true, shell_mudou: true } }),
      );
      comUa('Mozilla/5.0 Chrome/150.0 Electron/43.3.0 Safari/537.36');
      montar();
      await tick();
      await tick();
      expect(document.body.textContent ?? '').toContain(m.atualizar_shell_mudou());

      if (comp) unmount(comp);
      comp = null;
      alvo.remove();
      comUa('Mozilla/5.0 (iPhone) Safari');
      montar();
      await tick();
      await tick();
      expect(document.body.textContent ?? '').not.toContain(m.atualizar_shell_mudou());
    } finally {
      comUa(uaOriginal);
    }
  });

  it('com shell_mudou a caixa NÃO recarrega sozinha ao terminar — a pessoa precisa ler o aviso', async () => {
    const uaOriginal = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 Chrome/150.0 Electron/43.3.0', configurable: true, writable: true,
    });
    // Espalhar Location perde getters como origin, usados pelo diagnóstico.
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(api, 'getAtualizacao');
      spy.mockResolvedValueOnce(base({ estado: { fase: 'rodando', passo: 1, total: 5, texto: 'x' } }));
      spy.mockResolvedValue(base({ estado: { fase: 'pronto', ok: true, shell_mudou: true } }));
      montar();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2500);   // um tique do acompanhamento vê o "pronto"
      expect(document.body.textContent ?? '').toContain(m.atualizar_shell_mudou());
      await vi.advanceTimersByTimeAsync(5000);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      reload.mockRestore();
      Object.defineProperty(navigator, 'userAgent', { value: uaOriginal, configurable: true, writable: true });
    }
  });

  it('mostra o erro, o estado da máquina e a branch de resgate', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({
        estado: {
          fase: 'pronto', ok: false, erro: 'Rollup failed to resolve import',
          voltou: true, resgate: 'resgate/2026-08-25-1432',
        },
      }),
    );
    montar();
    await tick();
    await tick();
    const txt = document.body.textContent ?? '';
    expect(txt).toContain(m.atualizar_falhou_titulo());
    expect(txt).toContain('Rollup failed to resolve import');
    expect(txt).toContain(m.atualizar_falhou_voltou());
    expect(txt).toContain(m.atualizar_resgate({ branch: 'resgate/2026-08-25-1432' }));
  });

  it('sem rollback, diz que parou no meio', async () => {
    vi.spyOn(api, 'getAtualizacao').mockResolvedValue(
      base({ estado: { fase: 'pronto', ok: false, erro: 'x', voltou: false } }),
    );
    montar();
    await tick();
    await tick();
    expect(document.body.textContent ?? '').toContain(m.atualizar_falhou_parou());
  });
});
