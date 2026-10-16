import { Platform, Share } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { startActivityAsync } from 'expo-intent-launcher';
import * as m from '../../paraglide/messages';

const FLAG_GRANT_READ_URI_PERMISSION = 1;

// Arquivo do servidor exige o token no header, e nem o player do WebView (pede a mídia em pedaços,
// sem header) nem o "Abrir em…" do sistema o mandam: baixa pro cache e entrega o local.
// Baixa a cada abertura porque o arquivo pode ter sido regerado no mesmo caminho. O download vai
// para um nome temporário e só substitui a cópia ao terminar: no Android ele escreve direto no
// destino, e um download interrompido deixaria o arquivo cortado.
export async function localCopy(uri: string, headers: Record<string, string> | undefined, name: string): Promise<File> {
  const dir = new Directory(Paths.cache, 'chat-media');
  dir.create({ idempotent: true, intermediates: true });
  let h = 0;
  for (let i = 0; i < uri.length; i++) h = (h * 31 + uri.charCodeAt(i)) | 0;
  const target = new File(dir, `${(h >>> 0).toString(36)}-${name.replace(/[^\w.-]/g, '_')}`);
  const tmp = new File(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.part`);
  try {
    await File.downloadFileAsync(uri, tmp, { headers });
    tmp.moveSync(target, { overwrite: true });
  } catch (e) {
    if (tmp.exists) tmp.delete();
    throw e;
  }
  return target;
}

export async function openPdfFile(uri: string, headers: Record<string, string> | undefined, name: string, isMounted: () => boolean): Promise<void> {
  let file: File;
  try {
    file = await localCopy(uri, headers, name);
    if (!isMounted()) return;
    const dir = new Directory(Paths.cache, 'pdf-reader', file.name);
    dir.create({ idempotent: true, intermediates: true });
    const safeName = name.replace(/[^\w.-]/g, '_');
    const filename = !safeName || safeName === '.' || safeName === '..' ? 'documento.pdf' : safeName;
    const target = new File(dir, filename);
    file.moveSync(target, { overwrite: true });
    file = target;
  } catch (e) {
    throw new Error(m.native_pdf_download_failed({ reason: e instanceof Error ? e.message : String(e) }));
  }
  try {
    await startActivityAsync('android.intent.action.VIEW', {
      data: file.contentUri, type: 'application/pdf', flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (reason.includes('ActivityNotFoundException')) throw new Error(m.arq_pdf_sem_leitor());
    throw new Error(m.native_pdf_reader_failed({ reason }));
  }
}

// Só o iOS compartilha arquivo pelo Share do RN (o Android só manda texto): ali a folha do sistema
// já traz "Salvar em Arquivos" e "Abrir em…", que é o baixar e o abrir fora do web.
export const canShareFile = Platform.OS === 'ios';

export async function shareFile(uri: string, headers: Record<string, string> | undefined, name: string): Promise<void> {
  const f = await localCopy(uri, headers, name);
  await Share.share({ url: f.uri });
}

// Texto que já está na tela vira arquivo do cache e vai pela mesma folha: sem baixar de novo nem depender da rede.
// `name` já vem sem o que o sistema de arquivos recusa (`pageFileName`). Pasta própria: em `chat-media` o nome podia
// coincidir com o de um anexo baixado (`hash-nome`) e sobrescrevê-lo.
export async function shareTextFile(text: string, name: string): Promise<void> {
  const dir = new Directory(Paths.cache, 'chat-page-source');
  dir.create({ idempotent: true, intermediates: true });
  const f = new File(dir, name);
  f.write(text);
  await Share.share({ url: f.uri });
}
