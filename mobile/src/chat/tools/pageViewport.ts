const META = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const HEAD = /<head(\s[^>]*)?>/i;
const HTML = /<html(\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

// Sem meta viewport o WebView do iOS desenha a página com 980 pt de largura e a encolhe inteira.
// O meta nunca vai antes do doctype: ali o WebView cai no modo de compatibilidade antigo.
export function withDeviceViewport(doc: string): string {
  if (!doc || /<meta[^>]+name\s*=\s*["']?viewport/i.test(doc)) return doc;
  if (HEAD.test(doc)) return doc.replace(HEAD, (tag) => tag + META);
  if (HTML.test(doc)) return doc.replace(HTML, (tag) => `${tag}<head>${META}</head>`);
  if (DOCTYPE.test(doc)) return doc.replace(DOCTYPE, (tag) => tag + META);
  return META + doc;
}
