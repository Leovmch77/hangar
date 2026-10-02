import { Platform, Share } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

// Arquivo do servidor exige o token no header, e nem o player do WebView (pede a mídia em pedaços,
// sem header) nem o "Abrir em…" do sistema o mandam: baixa uma vez pro cache e entrega o local.
// ponytail: a cópia fica por URL; arquivo que mudou no servidor com o mesmo caminho sai velho até o
// sistema limpar o cache.
export async function localCopy(uri: string, headers: Record<string, string> | undefined, name: string): Promise<File> {
  const dir = new Directory(Paths.cache, 'chat-media');
  dir.create({ idempotent: true, intermediates: true });
  let h = 0;
  for (let i = 0; i < uri.length; i++) h = (h * 31 + uri.charCodeAt(i)) | 0;
  const target = new File(dir, `${(h >>> 0).toString(36)}-${name.replace(/[^\w.-]/g, '_')}`);
  if (target.exists) return target;
  return File.downloadFileAsync(uri, target, { headers, idempotent: true });
}

// Só o iOS compartilha arquivo pelo Share do RN (o Android só manda texto): ali a folha do sistema
// já traz "Salvar em Arquivos" e "Abrir em…", que é o baixar e o abrir fora do web.
export const canShareFile = Platform.OS === 'ios';

export async function shareFile(uri: string, headers: Record<string, string> | undefined, name: string): Promise<void> {
  const f = await localCopy(uri, headers, name);
  await Share.share({ url: f.uri });
}
