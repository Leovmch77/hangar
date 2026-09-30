import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from './prefs';
import {
  clearDraft, clearRecoverableDraft, readDraft, readRecoverableDraft, resolveDraftTranscript, reusableUploadPath, withoutUpload,
  writeDraft, writeRecoverableDraft,
} from './drafts';
import type { ConversationDraft, DraftAttachment } from './drafts';

const { memory } = vi.hoisted(() => ({ memory: new Map<string, string>() }));
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => memory.get(key),
    set: (key: string, value: string) => { memory.set(key, value); },
    remove: (key: string) => { memory.delete(key); },
  }),
}));

function draft(overrides: Partial<ConversationDraft> = {}): ConversationDraft {
  return {
    version: 1, text: 'Mensagem atual', revision: 3, transcript: '/sessions/original.jsonl',
    attachment: null, submission: null, ...overrides,
  };
}

describe('drafts', () => {
  beforeEach(() => { memory.clear(); vi.restoreAllMocks(); });

  it('retorna ausência sem criar rascunho', () => {
    expect(readDraft('linux', 'sessao')).toBeNull();
    expect(memory.size).toBe(0);
  });

  it('restaura após remontar o módulo e isola servidor e sessão', async () => {
    writeDraft('linux', 'sessao', draft({ text: 'Linux' }));
    writeDraft('windows', 'sessao', draft({ text: 'Windows', transcript: 'F:\\sessions\\chat.jsonl' }));
    writeDraft('linux', 'outra', draft({ text: 'Outra' }));
    vi.resetModules();
    const reopened = await import('./drafts');
    expect(reopened.readDraft('linux', 'sessao')?.text).toBe('Linux');
    expect(reopened.readDraft('windows', 'sessao')?.transcript).toBe('F:\\sessions\\chat.jsonl');
    expect(reopened.readDraft('linux', 'outra')?.text).toBe('Outra');
    expect(reopened.readDraft('other', 'sessao')).toBeNull();
    expect(memory.has('draft.v1:linux::sessao')).toBe(true);
  });

  it('restaura envio interrompido como incerto preservando texto novo e sua revisão', () => {
    const value = draft({
      text: 'Texto posterior', revision: 4,
      submission: { text: 'Snapshot enviado', draftRevision: 3, status: 'sending' },
    });
    writeDraft('linux', 'sessao', value);
    expect(readDraft('linux', 'sessao')).toEqual({
      ...value, submission: { text: 'Snapshot enviado', draftRevision: 3, status: 'unknown' },
    });
    expect(value.submission?.status).toBe('sending');
  });

  it.each(['unknown', 'rejected'] as const)('preserva snapshot %s sem substituir texto de mesma grafia e revisão nova', (status) => {
    const value = draft({
      text: 'Mesmo texto', revision: 4,
      submission: { text: 'Mesmo texto', draftRevision: 3, status },
    });
    writeDraft('linux', 'sessao', value);
    expect(readDraft('linux', 'sessao')).toEqual(value);
  });

  it('persiste anexo e caminho de upload na identidade original', () => {
    writeDraft('linux', 'sessao', draft({ attachment: {
      uri: 'file:///app/drafts/photo.jpg', name: 'photo.jpg', mime: 'image/jpeg',
      kind: 'image', uploadedPath: '/uploads/photo.jpg',
    } }));
    expect(readDraft('linux', 'sessao')?.attachment).toEqual({
      uri: 'file:///app/drafts/photo.jpg', name: 'photo.jpg', mime: 'image/jpeg',
      kind: 'image', uploadedPath: '/uploads/photo.jpg',
    });
    expect(readDraft('other', 'sessao')).toBeNull();
  });

  it('resolver identidade sem rascunho não cria dados locais', () => {
    expect(resolveDraftTranscript('linux', 'sessao', '/sessions/new.jsonl'))
      .toEqual({ draft: null, recoverable: null });
    expect(readDraft('linux', 'sessao')).toBeNull();
  });

  it('jsonl ainda desconhecido mantém a identidade conhecida e não recria a sessão', () => {
    const value = draft();
    writeDraft('linux', 'sessao', value);
    expect(resolveDraftTranscript('linux', 'sessao', null))
      .toEqual({ draft: value, recoverable: null });
    expect(readDraft('linux', 'sessao')?.transcript).toBe('/sessions/original.jsonl');
  });

  it('primeiro jsonl associa o rascunho provisório sem perder anexo, revisão ou snapshot', () => {
    const value = draft({
      transcript: null, revision: 4,
      attachment: { uri: 'file:///app/drafts/a', name: 'a', mime: 'text/plain', kind: 'file' },
      submission: { text: 'Snapshot anterior', draftRevision: 3, status: 'rejected' },
    });
    writeDraft('linux', 'sessao', value);
    expect(resolveDraftTranscript('linux', 'sessao', null))
      .toEqual({ draft: value, recoverable: null });
    const associated = { ...value, transcript: '/sessions/first.jsonl' };
    expect(resolveDraftTranscript('linux', 'sessao', '/sessions/first.jsonl'))
      .toEqual({ draft: associated, recoverable: null });
    expect(readDraft('linux', 'sessao')).toEqual(associated);
  });

  it('mesmo jsonl mantém rascunho sem exigir nova gravação', () => {
    const value = draft();
    writeDraft('linux', 'sessao', value);
    vi.spyOn(prefs, 'set').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    expect(resolveDraftTranscript('linux', 'sessao', '/sessions/original.jsonl'))
      .toEqual({ draft: value, recoverable: null });
  });

  it('jsonl diferente conserva o anterior para recuperação e não o restaura na sessão recriada', () => {
    const value = draft({ submission: { text: 'Snapshot anterior', draftRevision: 2, status: 'unknown' } });
    writeDraft('linux', 'sessao', value);
    const raw = memory.get('draft.v1:linux::sessao');
    expect(resolveDraftTranscript('linux', 'sessao', '/sessions/recreated.jsonl'))
      .toEqual({ draft: null, recoverable: value });
    expect(memory.get('draft.v1:linux::sessao')).toBe(raw);
    expect(resolveDraftTranscript('linux', 'sessao', '/sessions/original.jsonl'))
      .toEqual({ draft: value, recoverable: null });
  });

  it('rascunho recuperável tem chave própria por servidor e sessão, sem tocar a principal', () => {
    const current = draft({ text: 'Sessão nova', transcript: '/sessions/recreated.jsonl' });
    const old = draft({ text: 'Sessão morta' });
    writeDraft('linux', 'sessao', current);
    writeRecoverableDraft('linux', 'sessao', old);
    expect(readRecoverableDraft('linux', 'sessao')).toEqual(old);
    expect(readRecoverableDraft('windows', 'sessao')).toBeNull();
    expect(readDraft('linux', 'sessao')).toEqual(current);
    clearRecoverableDraft('linux', 'sessao');
    expect(readRecoverableDraft('linux', 'sessao')).toBeNull();
    expect(readDraft('linux', 'sessao')).toEqual(current);
  });

  it('associação que não foi guardada expõe falha e mantém rascunho provisório recuperável', () => {
    const value = draft({ transcript: null });
    writeDraft('linux', 'sessao', value);
    vi.spyOn(prefs, 'set').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    expect(() => resolveDraftTranscript('linux', 'sessao', '/sessions/first.jsonl')).toThrow();
    expect(readDraft('linux', 'sessao')).toEqual(value);
  });

  it.each(['', '{"text":"private text"', 'null', '[]', '{}',
    JSON.stringify(draft({ version: 2 as 1 })),
    JSON.stringify(draft({ revision: -1 })),
    JSON.stringify(draft({ revision: 1.5 })),
    JSON.stringify(draft({ transcript: 4 as unknown as string })),
    JSON.stringify(draft({ submission: { text: 'private text', draftRevision: 3, status: 'sent' as 'sending' } })),
    JSON.stringify(draft({ attachment: { uri: '', name: 'a', mime: 'text/plain', kind: 'file' } })),
  ])('expõe erro recuperável sem apagar ou incluir dados inválidos no erro: %s', (raw) => {
    memory.set('draft.v1:linux::sessao', raw);
    let failure: unknown;
    try { readDraft('linux', 'sessao'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('private text');
    expect(memory.get('draft.v1:linux::sessao')).toBe(raw);
  });

  it('grava somente os campos do contrato, inclusive dentro do anexo e snapshot', () => {
    const value = { ...draft(), token: 'private-token', attachment: {
      uri: 'file:///app/drafts/a', name: 'a', mime: 'text/plain', kind: 'file' as const,
      token: 'private-token',
    }, submission: { text: 'Snapshot', draftRevision: 2, status: 'rejected' as const, token: 'private-token' } };
    writeDraft('linux', 'sessao', value);
    expect(memory.get('draft.v1:linux::sessao')).not.toContain('private-token');
    memory.set('draft.v1:linux::sessao', JSON.stringify(value));
    expect(readDraft('linux', 'sessao')).toEqual({
      ...draft(), attachment: { uri: 'file:///app/drafts/a', name: 'a', mime: 'text/plain', kind: 'file' },
      submission: { text: 'Snapshot', draftRevision: 2, status: 'rejected' },
    });
  });

  it('erro de leitura não vira rascunho ausente nem expõe o erro bruto', () => {
    vi.spyOn(prefs, 'getString').mockImplementationOnce(() => { throw new Error('private storage path'); });
    expect(() => readDraft('linux', 'sessao')).toThrow();
    vi.spyOn(prefs, 'getString').mockImplementationOnce(() => { throw new Error('private storage path'); });
    expect(() => readDraft('linux', 'sessao')).not.toThrow('private storage path');
  });

  it('falha de gravação preserva o rascunho anterior e interrompe o chamador', () => {
    writeDraft('linux', 'sessao', draft());
    vi.spyOn(prefs, 'set').mockImplementationOnce(() => { throw new Error('private storage path'); });
    expect(() => writeDraft('linux', 'sessao', draft({ text: 'Novo' }))).toThrow();
    expect(readDraft('linux', 'sessao')?.text).toBe('Mensagem atual');
  });

  it('recusa dados inválidos antes de substituir rascunho válido', () => {
    writeDraft('linux', 'sessao', draft());
    expect(() => writeDraft('linux', 'sessao', draft({ revision: -1 }))).toThrow();
    expect(readDraft('linux', 'sessao')?.revision).toBe(3);
  });

  it('limpa somente a conversa pedida, preservando outros dados locais', () => {
    writeDraft('linux', 'sessao', draft());
    writeDraft('windows', 'sessao', draft({ text: 'Windows' }));
    memory.set('appearance', 'glass');
    clearDraft('linux', 'sessao');
    expect(readDraft('linux', 'sessao')).toBeNull();
    expect(readDraft('windows', 'sessao')?.text).toBe('Windows');
    expect(memory.get('appearance')).toBe('glass');
  });

  it('falha ao limpar conserva o rascunho e interrompe o chamador', () => {
    writeDraft('linux', 'sessao', draft());
    vi.spyOn(prefs, 'remove').mockImplementationOnce(() => { throw new Error('private storage path'); });
    expect(() => clearDraft('linux', 'sessao')).toThrow();
    expect(readDraft('linux', 'sessao')?.text).toBe('Mensagem atual');
  });
});

describe('upload do anexo', () => {
  const target = { serverId: 'linux', name: 'sessao', transcript: '/sessions/original.jsonl' };
  const attachment: DraftAttachment = {
    uri: 'file:///doc/draft-attachments/1-1.png', name: 'foto.png', mime: 'image/png', kind: 'image',
    uploadedPath: '/uploads/foto.png', uploadedFor: target,
  };

  beforeEach(() => { memory.clear(); });

  it('reabrir conserva arquivo, caminho enviado e destino', () => {
    writeDraft('linux', 'sessao', draft({ attachment }));
    const reopened = readDraft('linux', 'sessao')!.attachment!;
    expect(reopened).toEqual(attachment);
    expect(reusableUploadPath(reopened, target)).toBe('/uploads/foto.png');
  });

  it('reaproveita upload feito antes de a sessão ter transcript', () => {
    expect(reusableUploadPath({ ...attachment, uploadedFor: { ...target, transcript: null } }, target)).toBe('/uploads/foto.png');
  });

  it.each([
    ['outro servidor', { ...target, serverId: 'windows' }],
    ['outra sessão', { ...target, name: 'outra' }],
    ['sessão recriada', { ...target, transcript: '/sessions/nova.jsonl' }],
  ])('%s não herda o caminho', (_caso, other) => {
    expect(reusableUploadPath(attachment, other)).toBeNull();
  });

  it('sem destino gravado não reaproveita, e withoutUpload apaga caminho e destino', () => {
    expect(reusableUploadPath({ ...attachment, uploadedFor: undefined }, target)).toBeNull();
    const bare = withoutUpload(attachment);
    expect(bare).toEqual({ uri: attachment.uri, name: 'foto.png', mime: 'image/png', kind: 'image' });
    expect(reusableUploadPath(bare, target)).toBeNull();
  });
});
