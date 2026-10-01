import { applyBackgroundEffect, effectSize } from '@hangar/core';

// A página recebe o texto das funções do core: é a mesma fórmula que o teste do core confere.
// Sem o 'show source' (minificador que tira diretivas, por exemplo) o Hermes devolve só
// "[bytecode]"; aí a página não nasce e o app avisa, em vez de cair noutro caminho.
const effectSource = applyBackgroundEffect.toString();
const sizeSource = effectSize.toString();
export const effectSourceOk = /show source/.test(effectSource) && /BAYER/.test(effectSource) && /show source/.test(sizeSource);

/**
 * Pedido: `{type:'render', id, mime, data(base64), effect, light}`. Resposta: `{id, png(base64), ms}`
 * ou `{id, error}`. Só o último id vale; um pedido mais novo descarta o anterior entre as etapas.
 */
export const effectWorkerHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
var applyBackgroundEffect = (${effectSource});
var effectSize = (${sizeSource});
var current = 0;
function reply(o) { (window.ReactNativeWebView || window.__fxHost).postMessage(JSON.stringify(o)); }
function stale(id) { return id !== current; }
// Foto do iPhone vem em Display P3. Num canvas sRGB o WebKit converte e corta o que passa do gamut,
// e o fundo fica mais apagado que a foto crua. Em canvas P3 o efeito recebe os mesmos números P3 que
// o Rust (que lê os bytes sem converter) e o PNG sai com o perfil P3.
function isDisplayP3(b64) {
  var head = atob(b64.slice(0, 262144));
  return head.indexOf('Display P3') >= 0 || head.indexOf('D\\0i\\0s\\0p\\0l\\0a\\0y\\0 \\0P\\x003') >= 0;
}
function hasIccp(b64) { return atob(b64.slice(0, 200)).indexOf('iCCP') >= 0; }
function draw(img, size, msg, colorSpace) {
  var canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: colorSpace });
  var got = ctx.getContextAttributes ? ctx.getContextAttributes().colorSpace || 'srgb' : 'srgb';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, size.width, size.height);
  var pixels = ctx.getImageData(0, 0, size.width, size.height, { colorSpace: got });
  var t1 = Date.now();
  pixels.data.set(applyBackgroundEffect(pixels.data, size.width, size.height, msg.effect, msg.light));
  ctx.putImageData(pixels, 0, 0);
  var t2 = Date.now();
  return new Promise(function (ok) { canvas.toBlob(ok, 'image/png'); }).then(function (blob) {
    if (!blob) throw new Error('toBlob');
    return new Promise(function (ok, fail) {
      var r = new FileReader();
      r.onload = function () { ok(r.result); };
      r.onerror = function () { fail(r.error); };
      r.readAsDataURL(blob);
    });
  }).then(function (url) {
    return { png: url.slice(url.indexOf(',') + 1), colorSpace: got, t1: t1, t2: t2 };
  });
}
function run(msg) {
  var t0 = Date.now(), img = new Image();
  var wanted = isDisplayP3(msg.data) ? 'display-p3' : 'srgb';
  img.src = 'data:' + msg.mime + ';base64,' + msg.data;
  return img.decode().then(function () {
    if (stale(msg.id)) return;
    var size = effectSize(img.naturalWidth, img.naturalHeight);
    return draw(img, size, msg, wanted).then(function (out) {
      // PNG P3 sem o perfil seria lido como sRGB: desbotado. Refaz em sRGB, que ao menos converte.
      if (out.colorSpace === 'display-p3' && !hasIccp(out.png)) return draw(img, size, msg, 'srgb');
      return out;
    }).then(function (out) {
      if (stale(msg.id)) return;
      reply({ id: msg.id, png: out.png, width: size.width, height: size.height, colorSpace: out.colorSpace, source: wanted,
        ms: { decode: out.t1 - t0, effect: out.t2 - out.t1, png: Date.now() - out.t2 } });
    });
  });
}
function onMessage(e) {
  var msg;
  try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (!msg || msg.type !== 'render') return;
  current = msg.id;
  run(msg).catch(function (err) { if (!stale(msg.id)) reply({ id: msg.id, error: String((err && err.message) || err) }); });
}
window.addEventListener('message', onMessage);
document.addEventListener('message', onMessage);
reply({ ready: true });
</script></body></html>`;
