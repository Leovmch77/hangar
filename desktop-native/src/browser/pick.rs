//! Escolher elemento no navegador do painel: o que se lê do elemento escolhido e o recorte da foto dele. O modo de
//! escolha é o de inspeção do próprio Chromium (`Overlay.setInspectMode`), que segura o clique antes da página; aqui
//! fica só a leitura, sem estado.
use serde::Deserialize;
use serde_json::{Value, json};

use super::control::{Page, returned, screenshot_bytes, within};
use super::preview_fmt::snapshot_identity;
use crate::context_refs::{Element, HTML_MAX};

/// Folga em volta do elemento no recorte, em px CSS (a mesma do T3).
pub const CROP_PAD: f64 = 20.;
/// Página travada ou com diálogo aberto não responde: a leitura desiste e o painel avisa.
const READ_MS: u64 = 15_000;
const SHOT_MS: u64 = 15_000;
/// Falhas que o painel traduz; o resto sobe como o Chromium disse.
pub const TIMEOUT: &str = "timeout";
pub const OFFSCREEN: &str = "offscreen";
pub const GONE: &str = "gone";
/// Níveis da cadeia lidos acima do elemento quando não há âncora com id antes do `body`.
const CHAIN_MAX: usize = 10;

/// Realce do modo de escolha. O `chrome-headless-shell` do Linux não pinta o overlay de inspeção, então ali o painel
/// desenha o realce e o do navegador vai transparente, para não dobrar quando o motor é um Chrome completo. Desligar o
/// modo também exige a configuração: sem ela o Chromium recusa o `none` e o modo continua ligado.
pub fn highlight_config(visible: bool) -> Value {
    let color = |a: f64| json!({"r": 124, "g": 135, "b": 232, "a": if visible { a } else { 0. }});
    json!({"borderColor": color(1.), "contentColor": color(0.18), "paddingColor": color(0.1), "marginColor": color(0.06), "showInfo": false})
}

pub fn inspect_mode(on: bool, visible: bool) -> Value {
    json!({"mode": if on { "searchForNode" } else { "none" }, "highlightConfig": highlight_config(visible)})
}

/// Um nível da cadeia do elemento até a âncora, como a página o descreve. `id` e `classes` já vêm escapados
/// (`CSS.escape`), e `id` só vem quando é único na página.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Step {
    pub tag: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub classes: Vec<String>,
    #[serde(default)]
    pub nth: u32,
    #[serde(default)]
    pub of: u32,
}

/// `nth`: com a posição entre os irmãos de mesma tag, quando há mais de um.
fn segment(step: &Step, nth: bool) -> String {
    if let Some(id) = step.id.as_deref().filter(|id| !id.is_empty()) { return format!("#{id}"); }
    let mut out = step.tag.clone();
    if matches!(step.tag.as_str(), "body" | "html") { return out; }
    for class in step.classes.iter().take(2) { out.push('.'); out.push_str(class); }
    if nth && step.of > 1 && step.nth > 0 { out.push_str(&format!(":nth-of-type({})", step.nth)); }
    out
}

/// Seletores do mais curto ao mais longo: o elemento sozinho, depois com o pai, até a âncora (id único ou `body`). Cada
/// nível entra primeiro sem a posição, que só fica quando as classes não bastam. A página fica com o primeiro que acha
/// só o elemento; nenhum achando, vale o último.
pub fn selector_candidates(chain: &[Step]) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for step in chain {
        let anchor = step.id.as_deref().is_some_and(|id| !id.is_empty()) || step.tag == "body";
        let (loose, exact) = (segment(step, false), segment(step, true));
        if loose != exact { out.push(std::iter::once(loose).chain(parts.iter().cloned()).collect::<Vec<_>>().join(" > ")); }
        parts.insert(0, exact);
        out.push(parts.join(" > "));
        if anchor { break; }
    }
    out
}

/// A borda medida pelo `DOM.getBoxModel`: quad de 4 pontos relativo à área visível.
pub fn border(model: &Value) -> Vec<f64> {
    model["model"]["border"].as_array().map(|q| q.iter().filter_map(Value::as_f64).collect()).unwrap_or_default()
}

/// Cantos (x0, y0, x1, y1) de um quad; `None` sem os 8 números.
pub fn quad_bounds(quad: &[f64]) -> Option<[f64; 4]> {
    if quad.len() < 8 { return None; }
    let (x0, x1) = quad.iter().step_by(2).fold((f64::MAX, f64::MIN), |(a, b), &x| (a.min(x), b.max(x)));
    let (y0, y1) = quad.iter().skip(1).step_by(2).fold((f64::MAX, f64::MIN), |(a, b), &y| (a.min(y), b.max(y)));
    Some([x0, y0, x1, y1])
}

/// Caixa do recorte em px CSS da área visível (x, y, largura, altura): a do elemento (`border`) com a folga, cortada
/// ao que está na tela (`cssLayoutViewport`, sem a barra de rolagem). `None` quando nada do elemento está à vista.
pub fn crop_rect(quad: &[f64], viewport: &Value) -> Option<[f64; 4]> {
    let [x0, y0, x1, y1] = quad_bounds(quad)?;
    let (width, height) = (viewport["clientWidth"].as_f64()?, viewport["clientHeight"].as_f64()?);
    let (left, top) = ((x0 - CROP_PAD).max(0.), (y0 - CROP_PAD).max(0.));
    let (right, bottom) = ((x1 + CROP_PAD).min(width), (y1 + CROP_PAD).min(height));
    (right - left >= 1. && bottom - top >= 1.).then_some([left, top, right - left, bottom - top])
}

/// Recorta a foto da área visível. `css_width` é a largura dela em px CSS (`innerWidth`, com a barra): a razão para a
/// largura do PNG é a densidade da tela. Px inteiros que cobrem a caixa inteira, dentro da foto.
pub fn crop_png(png: &[u8], rect: [f64; 4], css_width: f64) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    if css_width <= 0. { return Err("a pagina sem largura".into()); }
    let scale = f64::from(image.width()) / css_width;
    let edge = |v: f64, max: u32| (v * scale).clamp(0., f64::from(max)) as u32;
    let (x, y) = (edge(rect[0].floor(), image.width()), edge(rect[1].floor(), image.height()));
    let (x1, y1) = (edge((rect[0] + rect[2]).ceil(), image.width()), edge((rect[1] + rect[3]).ceil(), image.height()));
    if x1 <= x || y1 <= y { return Err(OFFSCREEN.into()); }
    let mut out = std::io::Cursor::new(Vec::new());
    image.crop_imm(x, y, x1 - x, y1 - y).write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// O elemento lido e a foto dele; a foto pode faltar sem perder o elemento.
pub struct Picked {
    pub element: Element,
    pub png: Result<Vec<u8>, String>,
}

/// Tag, HTML, a cadeia até a âncora e o título da página, lidos de uma vez no próprio elemento (`this`). O título vem
/// daqui porque o do alvo, que o painel guarda, pode ser ainda o do endereço.
const DESCRIBE: &str = "function(max,depth){const el=this,root=el.getRootNode(),all=s=>{try{return root.querySelectorAll(s)}catch(e){return []}};const chain=[];for(let n=el;n&&n.nodeType===1;n=n.parentElement){const tag=n.localName;const id=n.id&&all('#'+CSS.escape(n.id)).length===1?CSS.escape(n.id):null;const same=n.parentElement?[...n.parentElement.children].filter(c=>c.localName===tag):[n];chain.push({tag,id,classes:[...n.classList].slice(0,2).map(c=>CSS.escape(c)),nth:same.indexOf(n)+1,of:same.length});if(id||tag==='body'||chain.length>=depth)break}let title='';try{title=top.document.title}catch(e){title=document.title}return {tag:el.localName,html:el.outerHTML.slice(0,max),chain,title}}";
/// O primeiro seletor que acha só este elemento; `''` quando nenhum acha.
const UNIQUE: &str = "function(list){const root=this.getRootNode();for(const s of list){try{const m=root.querySelectorAll(s);if(m.length===1&&m[0]===this)return s}catch(e){}}return ''}";

/// Lê o elemento `backend` escolhido na página `url` e tira a foto recortada dele. `title` vale quando a página não
/// tem título.
pub async fn capture<P: Page>(page: &P, backend: i64, url: String, title: String) -> Result<Picked, String> {
    let element = within(page, READ_MS, describe(page, backend, url, title)).await.ok_or(TIMEOUT)??;
    let png = within(page, SHOT_MS, shot(page, backend)).await.unwrap_or_else(|| Err(TIMEOUT.into()));
    Ok(Picked { element, png })
}

async fn describe<P: Page>(page: &P, backend: i64, url: String, title: String) -> Result<Element, String> {
    let resolved = page.call("DOM.resolveNode", json!({"backendNodeId": backend})).await?;
    let object = resolved["object"]["objectId"].as_str().ok_or(GONE)?.to_owned();
    let call = |function: &str, args: Value| page.call("Runtime.callFunctionOn",
        json!({"functionDeclaration": function, "objectId": object, "arguments": args, "returnByValue": true}));
    let read = async {
        let described = call(DESCRIBE, json!([{"value": HTML_MAX}, {"value": CHAIN_MAX}])).await?;
        let value = returned(&described)?.clone();
        let chain: Vec<Step> = serde_json::from_value(value["chain"].clone()).map_err(|e| format!("cadeia do elemento ilegivel: {e}"))?;
        let candidates = selector_candidates(&chain);
        let unique = call(UNIQUE, json!([{"value": candidates}])).await?;
        let selector = returned(&unique)?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
            .or_else(|| candidates.last().cloned()).unwrap_or_default();
        let text = |k: &str| value[k].as_str().unwrap_or_default().to_owned();
        Ok::<_, String>((text("tag"), text("html"), selector, text("title")))
    };
    let result = read.await;
    drop(page.call("Runtime.releaseObject", json!({"objectId": object})));
    let (tag, html, selector, page_title) = result?;
    let title = if page_title.trim().is_empty() { title } else { page_title };
    // Sem papel e nome o elemento ainda vale: o rótulo cai para a tag.
    let (role, name) = match page.call("Accessibility.getPartialAXTree", json!({"backendNodeId": backend, "fetchRelatives": false})).await {
        Ok(tree) => snapshot_identity(tree["nodes"].as_array().map_or(&[][..], Vec::as_slice), backend),
        Err(e) => { eprintln!("[nav] papel do elemento escolhido nao lido: {e}"); Default::default() }
    };
    Ok(Element { url, title, role, name, tag, selector, html, comment: String::new() })
}

/// Foto da área visível inteira, recortada aqui. O `clip` do `Page.captureScreenshot` redimensiona a página para tirar
/// a foto, e o screencast do Linux ficava parado no quadro ampliado até a página mudar sozinha. O recorte decodifica e
/// recodifica o PNG fora da thread da janela.
async fn shot<P: Page>(page: &P, backend: i64) -> Result<Vec<u8>, String> {
    let model = page.call("DOM.getBoxModel", json!({"backendNodeId": backend})).await?;
    let metrics = page.call("Page.getLayoutMetrics", json!({})).await?;
    let rect = crop_rect(&border(&model), &metrics["cssLayoutViewport"]).ok_or(OFFSCREEN)?;
    let width = page.call("Runtime.evaluate", json!({"expression": "innerWidth", "returnByValue": true})).await?;
    let width = returned(&width)?.as_f64().unwrap_or(0.);
    // O realce do modo de escolha (Windows) sairia na foto.
    let _ = page.call("Overlay.hideHighlight", json!({})).await;
    let r = page.call("Page.captureScreenshot", json!({"format": "png"})).await?;
    let bytes = screenshot_bytes(&r)?;
    if bytes.is_empty() { return Err("a foto veio vazia".into()); }
    page.background(move || crop_png(&bytes, rect, width)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use futures::executor::block_on;
    use std::cell::RefCell;

    fn step(tag: &str, id: Option<&str>, classes: &[&str], nth: u32, of: u32) -> Step {
        Step { tag: tag.into(), id: id.map(Into::into), classes: classes.iter().map(|c| c.to_string()).collect(), nth, of }
    }

    #[test]
    fn unique_id_is_the_whole_selector() {
        assert_eq!(selector_candidates(&[step("button", Some("salvar"), &["btn"], 1, 3)]), vec!["#salvar"]);
    }

    #[test]
    fn chain_climbs_to_the_id_anchor_shortest_first() {
        let chain = [step("li", None, &["destaque", "ativo", "extra"], 3, 3), step("ul", None, &["lista"], 1, 1),
            step("form", Some("cadastro"), &["card"], 1, 1), step("body", None, &[], 1, 1)];
        assert_eq!(selector_candidates(&chain), vec![
            "li.destaque.ativo",
            "li.destaque.ativo:nth-of-type(3)",
            "ul.lista > li.destaque.ativo:nth-of-type(3)",
            "#cadastro > ul.lista > li.destaque.ativo:nth-of-type(3)",
        ]);
    }

    #[test]
    fn chain_without_id_stops_at_body_without_classes() {
        let chain = [step("p", None, &[], 1, 1), step("section", None, &["card"], 2, 2), step("body", None, &["tema"], 1, 1)];
        assert_eq!(selector_candidates(&chain), vec!["p", "section.card > p", "section.card:nth-of-type(2) > p", "body > section.card:nth-of-type(2) > p"]);
        assert!(selector_candidates(&[]).is_empty());
    }

    /// Elemento no fim de uma página rolada 1256 px: o quad vem relativo à área visível, sem a rolagem.
    #[test]
    fn crop_adds_padding_and_clamps_to_the_view() {
        let view = json!({"pageX": 0, "pageY": 1256, "clientWidth": 785, "clientHeight": 600});
        let quad = [24., 464.4375, 761., 464.4375, 761., 576.4375, 24., 576.4375];
        assert_eq!(crop_rect(&quad, &view), Some([4., 444.4375, 777., 152.]));
        // Maior que a tela: fica o pedaço visível, sem folga para fora dela.
        assert_eq!(crop_rect(&[-50., -30., 900., -30., 900., 700., -50., 700.], &view), Some([0., 0., 785., 600.]));
        // Fora da tela, ou sem medida: sem foto.
        assert_eq!(crop_rect(&[10., 900., 20., 900., 20., 950., 10., 950.], &view), None);
        assert_eq!(crop_rect(&quad, &json!({})), None);
        assert_eq!(crop_rect(&[], &view), None);
    }

    fn png(w: u32, h: u32, paint: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let image = image::RgbImage::from_fn(w, h, |x, y| image::Rgb(paint(x, y)));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn crop_follows_the_screen_density() {
        // Tela de densidade 2: 100 px CSS viram 200 px na foto; o quadrado vermelho fica em 10..30 CSS.
        let shot = png(200, 100, |x, y| if (20..60).contains(&x) && (20..60).contains(&y) { [255, 0, 0] } else { [255, 255, 255] });
        let out = image::load_from_memory(&crop_png(&shot, [10., 10., 20.5, 20.], 100.).unwrap()).unwrap().to_rgb8();
        assert_eq!(out.dimensions(), (42, 40), "o meio px da borda entra inteiro");
        assert_eq!(out.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(out.get_pixel(41, 39).0, [255, 255, 255]);
        assert_eq!(crop_png(&shot, [150., 0., 10., 10.], 100.), Err(OFFSCREEN.to_owned()));
        assert!(crop_png(b"nada", [0., 0., 1., 1.], 100.).is_err());
    }

    #[test]
    fn box_model_border_becomes_corners() {
        let model = json!({"model": {"border": [24., 464.5, 761., 464.5, 761., 576.5, 24., 576.5]}});
        assert_eq!(quad_bounds(&border(&model)), Some([24., 464.5, 761., 576.5]));
        assert_eq!(quad_bounds(&border(&json!({}))), None);
    }

    #[test]
    fn mode_off_still_carries_the_highlight_config() {
        assert_eq!(inspect_mode(false, true)["mode"], "none");
        assert!(inspect_mode(false, true)["highlightConfig"].is_object());
        assert_eq!(highlight_config(false)["borderColor"]["a"], 0.);
    }

    struct Fake { calls: RefCell<Vec<String>>, shot_fails: bool }
    impl Page for Fake {
        fn call(&self, method: &str, params: Value) -> impl Future<Output = Result<Value, String>> {
            self.calls.borrow_mut().push(method.to_owned());
            let fn_decl = params["functionDeclaration"].as_str().unwrap_or("").to_owned();
            let r = match method {
                "DOM.resolveNode" => Ok(json!({"object": {"objectId": "o1"}})),
                "Runtime.callFunctionOn" if fn_decl == DESCRIBE => Ok(json!({"result": {"value": {"tag": "button", "html": "<button id=\"salvar\">Salvar</button>",
                    "chain": [{"tag": "button", "id": "salvar", "classes": ["btn"], "nth": 1, "of": 3}]}}})),
                "Runtime.callFunctionOn" => Ok(json!({"result": {"value": "#salvar"}})),
                "Accessibility.getPartialAXTree" => Ok(json!({"nodes": [{"nodeId": "1", "role": {"value": "button"}, "name": {"value": "Salvar"}, "backendDOMNodeId": 7}]})),
                "DOM.getBoxModel" => Ok(json!({"model": {"border": [41., 99., 107., 99., 107., 130., 41., 130.]}})),
                "Page.getLayoutMetrics" => Ok(json!({"cssLayoutViewport": {"pageX": 0, "pageY": 0, "clientWidth": 785, "clientHeight": 600}})),
                "Page.captureScreenshot" if self.shot_fails => Err("sem quadro".into()),
                "Page.captureScreenshot" => Ok(json!({"data": base64::engine::general_purpose::STANDARD.encode(png(785, 600, |_, _| [9, 9, 9]))})),
                "Runtime.evaluate" => Ok(json!({"result": {"value": 785}})),
                _ => Ok(json!({})),
            };
            std::future::ready(r)
        }
        fn sleep(&self, _: u64) -> impl Future<Output = ()> { std::future::pending() }
    }

    #[test]
    fn capture_reads_the_element_and_keeps_it_when_the_shot_fails() {
        let page = Fake { calls: RefCell::default(), shot_fails: false };
        let picked = block_on(capture(&page, 7, "http://x/".into(), "Prova".into())).unwrap();
        assert_eq!(picked.element, Element { url: "http://x/".into(), title: "Prova".into(), role: "button".into(), name: "Salvar".into(),
            tag: "button".into(), selector: "#salvar".into(), html: "<button id=\"salvar\">Salvar</button>".into(), comment: String::new() });
        let shot = image::load_from_memory(&picked.png.unwrap()).unwrap();
        assert_eq!((shot.width(), shot.height()), (106, 71), "botão de 66×31 com 20 px de folga");
        assert!(page.calls.borrow().contains(&"Runtime.releaseObject".to_owned()), "o objeto da página é solto");
        let failing = Fake { calls: RefCell::default(), shot_fails: true };
        let picked = block_on(capture(&failing, 7, "http://x/".into(), String::new())).unwrap();
        assert_eq!(picked.element.selector, "#salvar");
        assert_eq!(picked.png, Err("sem quadro".into()));
    }
}
