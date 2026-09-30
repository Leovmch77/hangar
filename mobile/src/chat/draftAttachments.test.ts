import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { File } from 'expo-file-system';
import type { DraftAttachment } from '../stores/drafts';
import { removeDraftAttachment, retainDraftAttachment } from './draftAttachments';

const native = vi.hoisted(() => ({ document: '' }));

// O módulo nativo não roda no Node; o adaptador mantém cópia e exclusão em arquivos reais.
vi.mock('expo-file-system', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  type Location = string | { uri: string };
  function uriOf(parts: Location[]): string {
    const first = typeof parts[0] === 'string' ? parts[0] : parts[0].uri;
    return url.pathToFileURL(path.join(url.fileURLToPath(first), ...parts.slice(1) as string[])).href;
  }
  class Directory {
    readonly uri: string;
    constructor(...parts: Location[]) { this.uri = `${uriOf(parts).replace(/\/$/, '')}/`; }
    create(options?: { idempotent?: boolean; intermediates?: boolean }) {
      fs.mkdirSync(url.fileURLToPath(this.uri), { recursive: options?.intermediates || options?.idempotent });
    }
  }
  class File {
    readonly uri: string;
    constructor(...parts: Location[]) { this.uri = uriOf(parts); }
    get exists() { return fs.statSync(url.fileURLToPath(this.uri), { throwIfNoEntry: false })?.isFile() ?? false; }
    async copy(destination: File, options?: { overwrite?: boolean }): Promise<void> {
      fs.copyFileSync(url.fileURLToPath(this.uri), url.fileURLToPath(destination.uri), options?.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
    }
    delete() { fs.rmSync(url.fileURLToPath(this.uri), { recursive: true }); }
  }
  return { File, Directory, Paths: { get document() { return new Directory(native.document); } } };
});

let fixture: string;
let document: string;
let source: string;

function attachment(overrides: Partial<DraftAttachment> = {}): DraftAttachment {
  return { uri: pathToFileURL(source).href, name: 'photo.jpg', mime: 'image/jpeg', kind: 'image', ...overrides };
}

describe('draftAttachments', () => {
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'hangar-draft-attachments-'));
    document = join(fixture, 'document');
    mkdirSync(document);
    native.document = pathToFileURL(document).href;
    source = join(fixture, 'selection.jpg');
    writeFileSync(source, 'arquivo escolhido');
  });

  afterEach(() => { vi.restoreAllMocks(); rmSync(fixture, { recursive: true, force: true }); });

  it('copia para documentos e preserva metadados e seleção externa', async () => {
    const selected = attachment({ uploadedPath: '/uploads/original.jpg' });
    const retained = await retainDraftAttachment(selected);
    expect(dirname(fileURLToPath(retained.uri))).toBe(join(document, 'draft-attachments'));
    expect(retained).toEqual({ ...selected, uri: retained.uri });
    expect(retained.uri).not.toBe(selected.uri);
    expect(selected.uri).toBe(pathToFileURL(source).href);
    expect(readFileSync(fileURLToPath(retained.uri), 'utf8')).toBe('arquivo escolhido');
    expect(readFileSync(source, 'utf8')).toBe('arquivo escolhido');
  });

  it('não sobrescreve anexos homônimos escolhidos no mesmo instante', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const first = await retainDraftAttachment(attachment());
    writeFileSync(source, 'segunda seleção');
    const second = await retainDraftAttachment(attachment());
    expect(second.uri).not.toBe(first.uri);
    expect(readFileSync(fileURLToPath(first.uri), 'utf8')).toBe('arquivo escolhido');
    expect(readFileSync(fileURLToPath(second.uri), 'utf8')).toBe('segunda seleção');
  });

  it('nome externo com separadores não escolhe o caminho do arquivo próprio', async () => {
    const retained = await retainDraftAttachment(attachment({ name: '../wallpaper.jpg' }));
    expect(readFileSync(fileURLToPath(retained.uri), 'utf8')).toBe('arquivo escolhido');
    removeDraftAttachment(retained.uri);
    expect(existsSync(fileURLToPath(retained.uri))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  it('só confirma retenção depois de a Promise da cópia terminar', async () => {
    const copy = File.prototype.copy;
    let finish!: () => void;
    vi.spyOn(File.prototype, 'copy').mockImplementationOnce(function (this: File, destination, options) {
      return new Promise<void>((resolve, reject) => {
        finish = () => { copy.call(this, destination, options).then(resolve, reject); };
      });
    });
    let completed = false;
    const pending = retainDraftAttachment(attachment()).then((value) => { completed = true; return value; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    const retained = await pending;
    expect(readFileSync(fileURLToPath(retained.uri), 'utf8')).toBe('arquivo escolhido');
  });

  it('falha de cópia rejeita sem alterar anexo ou seleção', async () => {
    const selected = attachment();
    vi.spyOn(File.prototype, 'copy').mockRejectedValueOnce(new Error('copy-denied'));
    await expect(retainDraftAttachment(selected)).rejects.toThrow('copy-denied');
    expect(selected.uri).toBe(pathToFileURL(source).href);
    expect(readFileSync(source, 'utf8')).toBe('arquivo escolhido');
  });

  it('cópia sem arquivo no destino não devolve durabilidade', async () => {
    vi.spyOn(File.prototype, 'copy').mockResolvedValueOnce(undefined);
    await expect(retainDraftAttachment(attachment())).rejects.toThrow();
  });

  it('fonte ausente rejeita sem modificar os anexos conservados', async () => {
    const retained = await retainDraftAttachment(attachment());
    rmSync(source);
    await expect(retainDraftAttachment(attachment())).rejects.toThrow();
    expect(readFileSync(fileURLToPath(retained.uri), 'utf8')).toBe('arquivo escolhido');
  });

  it('remove somente o arquivo próprio e aceita remoção repetida', async () => {
    const retained = await retainDraftAttachment(attachment());
    removeDraftAttachment(retained.uri);
    removeDraftAttachment(retained.uri);
    expect(existsSync(fileURLToPath(retained.uri))).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe('arquivo escolhido');
  });

  it('recusa seleção, wallpaper, prefixo vizinho e caminhos que saem do diretório', () => {
    const own = join(document, 'draft-attachments');
    const neighbor = join(document, 'draft-attachments-other');
    mkdirSync(own);
    mkdirSync(neighbor);
    const wallpaper = join(document, 'wallpaper.jpg');
    const neighborFile = join(neighbor, '123-1.jpg');
    const ownFile = join(own, '123-1.jpg');
    const nestedFile = join(own, 'nested', '123-1.jpg');
    mkdirSync(dirname(nestedFile));
    writeFileSync(wallpaper, 'papel de parede');
    writeFileSync(neighborFile, 'vizinho');
    writeFileSync(ownFile, 'anexo preservado');
    writeFileSync(nestedFile, 'arquivo aninhado');
    const base = pathToFileURL(own).href;
    for (const uri of [
      pathToFileURL(source).href, pathToFileURL(wallpaper).href, pathToFileURL(neighborFile).href,
      base, `${base}/`, `${base}/../wallpaper.jpg`, `${base}/%2e%2e/wallpaper.jpg`,
      `${base}/..\\wallpaper.jpg`, `${base}/123-1.jpg?x=1`, `${base}/123-1.jpg#x`,
      `${base}/nested/123-1.jpg`, 'content://picker/photo', 'https://example.com/photo.jpg',
    ]) removeDraftAttachment(uri);
    expect(readFileSync(source, 'utf8')).toBe('arquivo escolhido');
    expect(readFileSync(wallpaper, 'utf8')).toBe('papel de parede');
    expect(readFileSync(neighborFile, 'utf8')).toBe('vizinho');
    expect(readFileSync(ownFile, 'utf8')).toBe('anexo preservado');
    expect(readFileSync(nestedFile, 'utf8')).toBe('arquivo aninhado');
    expect(existsSync(own)).toBe(true);
  });

  it('não apaga diretório com nome de anexo nem os arquivos dentro dele', () => {
    const directory = join(document, 'draft-attachments', '123-1.jpg');
    mkdirSync(directory, { recursive: true });
    const child = join(directory, 'keep.txt');
    writeFileSync(child, 'preservado');
    removeDraftAttachment(pathToFileURL(directory).href);
    expect(readFileSync(child, 'utf8')).toBe('preservado');
  });

  it('erro de exclusão aparece e o arquivo continua recuperável', async () => {
    const retained = await retainDraftAttachment(attachment());
    vi.spyOn(File.prototype, 'delete').mockImplementationOnce(() => { throw new Error('delete-denied'); });
    expect(() => removeDraftAttachment(retained.uri)).toThrow('delete-denied');
    expect(readFileSync(fileURLToPath(retained.uri), 'utf8')).toBe('arquivo escolhido');
  });
});
