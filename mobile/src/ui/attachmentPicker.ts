import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import type { DraftAttachment } from '../stores/drafts';
import * as m from '../paraglide/messages';

export type PickedAttachment = DraftAttachment & { size?: number };

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

const fromImageAsset = (asset: ImagePicker.ImagePickerAsset): PickedAttachment => ({
  uri: asset.uri,
  name: asset.fileName ?? 'imagem.jpg',
  mime: asset.mimeType ?? 'image/jpeg',
  kind: 'image',
  size: asset.fileSize,
});

const isDenied = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ERR_USER_REJECTED_PERMISSIONS' || (e instanceof Error && /permission/i.test(e.message));
};

// Galeria do aparelho. Permissão negada vira o aviso de fotos; cancelar devolve null.
export async function pickImage(): Promise<PickedAttachment | null> {
  try {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (res.canceled || !res.assets?.[0]) return null;
    return fromImageAsset(res.assets[0]);
  } catch (e) {
    if (isDenied(e)) throw new Error(m.composer_sem_acesso_fotos());
    throw e;
  }
}

// Foto na hora. A permissão é pedida antes: negada, o aviso diz onde liberar em vez de falhar calado.
export async function pickCamera(): Promise<PickedAttachment | null> {
  try {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error(m.composer_sem_acesso_camera());
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (res.canceled || !res.assets?.[0]) return null;
    return fromImageAsset(res.assets[0]);
  } catch (e) {
    if (isDenied(e)) throw new Error(m.composer_sem_acesso_camera());
    throw e;
  }
}

// Qualquer arquivo; versões antigas do picker devolvem o asset solto, sem `assets`.
export async function pickFile(): Promise<PickedAttachment | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (res.canceled) return null;
  type Asset = { uri: string; name: string; mimeType?: string; size?: number };
  const asset = (res as unknown as { assets?: Asset[] }).assets?.[0] ?? (res as unknown as Asset);
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    name: asset.name ?? 'arquivo',
    mime: asset.mimeType ?? 'application/octet-stream',
    kind: IMAGE_NAME.test(asset.name ?? '') ? 'image' : 'file',
    size: asset.size,
  };
}
