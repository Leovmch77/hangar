// Sem meta viewport o WebView do iOS desenha a página com 980 pt de largura e a encolhe inteira.
export function withDeviceViewport(doc: string): string {
  if (!doc || /<meta[^>]+name\s*=\s*["']?viewport/i.test(doc)) return doc;
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  return /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (h) => h + meta) : meta + doc;
}
