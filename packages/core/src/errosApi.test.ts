import { describe, expect, it } from 'vitest';
import { formataErro } from './errosApi';
import * as m from './paraglide/messages';

describe('Git/arquivos recusado pelo Rust', () => {
  it('traduz os três códigos e leva o motivo para a frase', () => {
    expect(formataErro({ code: 'workspace_busy', params: { motivo: 'vagas cheias' }, msg: 'x' })).toBe(m.workspace_busy());
    for (const code of ['workspace_context', 'workspace_unavailable']) {
      const texto = formataErro({ code, params: { motivo: 'git não encontrado' }, msg: 'x' });
      expect(texto).toContain('git não encontrado');
      expect(texto).not.toBe('x');
    }
  });
});

describe('histórico recusado pelo Rust', () => {
  it('traduz os três códigos e mantém o código na frase', () => {
    for (const code of ['internal_info', 'history_io', 'history_panic']) {
      const texto = formataErro({ code, params: { motivo: 'frase em português' }, msg: 'x' });
      expect(texto).toContain(code);
      expect(texto).not.toBe('x');
    }
  });
});

describe('recusas novas dos mods', () => {
  it.each([
    'erro_mod_sem_digitacao',
    'erro_mod_desenho_vencido',
    'erro_mod_dialogo_aberto',
    'erro_mod_rascunho_no_prompt',
    'erro_mod_painel_nao_alcancavel',
    'erro_mod_fechar_recusado',
    'erro_mod_guarda_indisponivel',
    'session_transfer_busy',
    'session_transfer_gate_unavailable',
    'erro_mod_painel_inexistente',
    'erro_mod_convidado',
  ])('%s vira frase do app, não o texto do servidor', (code) => {
    const texto = formataErro({ code, params: {}, msg: 'texto-do-servidor' });
    expect(texto).not.toBe('texto-do-servidor');
    expect(texto).not.toBe(code);
  });
});

describe('resposta recusada por identidade da pergunta', () => {
  it('traduz os três códigos em vez do texto do servidor', () => {
    expect(formataErro({ code: 'erro_interacao_sem_identidade', params: {}, msg: 'x' })).toBe(m.erro_interacao_sem_identidade());
    expect(formataErro({ code: 'erro_interacao_desatualizada', params: {}, msg: 'x' })).toBe(m.erro_interacao_desatualizada());
    expect(formataErro({ code: 'erro_interacao_indisponivel', params: {}, msg: 'x' })).toBe(m.erro_interacao_indisponivel());
  });
});

describe('transcrição de áudio já enviado', () => {
  it('traduz o áudio sumido e a recusa do convidado', () => {
    expect(formataErro({ code: 'erro_upload_inexistente', params: {}, msg: 'x' })).toBe(m.erro_upload_inexistente());
    expect(formataErro({ code: 'erro_arquivo_caminho_convidado', params: {}, msg: 'x' })).toBe(
      m.erro_arquivo_caminho_convidado(),
    );
  });
});

describe('recusas do par externo', () => {
  it.each(['erro_grupo_orq_par_externo', 'erro_par_repetido', 'erro_par_remetente_invalido'])(
    '%s vira frase do app, não o texto do servidor', (code) => {
      const texto = formataErro({ code, params: {}, msg: 'texto-do-servidor' });
      expect(texto).not.toBe('texto-do-servidor');
      expect(texto).not.toBe(code);
    });
});

describe('painel da fila', () => {
  it.each([
    'queue_action_unavailable', 'queue_entry_gone', 'queue_steer_not_delivered',
    'queue_steer_question_open', 'queue_steer_uncertain', 'queue_text_invalid',
  ])('%s vira frase do app, não o texto do servidor', (code) => {
    const texto = formataErro({ code, params: {}, msg: 'texto-do-servidor' });
    expect(texto).not.toBe('texto-do-servidor');
    expect(texto).not.toBe(code);
  });

  it('comando recusado com mensagens na fila tem frase própria; os outros motivos seguem na frase genérica', () => {
    expect(formataErro({ code: 'erro_comando_nao_executado', params: { comando: '/clear', motivo: 'queue_waiting' }, msg: 'x' }))
      .toBe(m.command_refused_queue_waiting());
    expect(formataErro({ code: 'erro_comando_nao_executado', params: { comando: '/clear', motivo: 'busy' }, msg: 'x' }))
      .toBe(m.erro_comando_nao_executado({ comando: '/clear', motivo: 'busy' }));
  });
});
