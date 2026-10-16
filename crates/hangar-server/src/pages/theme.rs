//! Tema e script de ponte que vão no começo do `<head>` de toda página publicada.
use super::store::PageMeta;
use regex::Regex;
use std::sync::LazyLock;

const DARK: &str = "--background:transparent;--foreground:#d2cbcd;--muted-foreground:#8d8489;--surface:#1a171a;\
--border:rgba(255,248,244,0.12);--accent:#7c87e8;--accent-foreground:#ffffff;--danger:#ff453a;--warning:#ff9f0a;\
--success:#34c759;--info:#5b9cf5;--code-background:#100e11;--chart-1:#7c87e8;--chart-2:#d95926;--chart-3:#199e70;\
--chart-4:#c98500;--chart-5:#b07ce8;--chart-6:#e8607c;--destructive-foreground:#100e11;--warning-foreground:#100e11;\
--success-foreground:#100e11;--info-foreground:#100e11;";
const LIGHT: &str = "--background:transparent;--foreground:#221d1b;--muted-foreground:#6f6660;--surface:#fffdfa;\
--border:rgba(50,40,35,0.14);--accent:#5b6ad0;--accent-foreground:#ffffff;--danger:#b3251c;--warning:#7a5408;\
--success:#146c30;--info:#2f6fd6;--code-background:#f8f6f2;--chart-1:#5b6ad0;--chart-2:#eb6834;--chart-3:#1baf7a;\
--chart-4:#eda100;--chart-5:#8a4fd0;--chart-6:#c93d62;--destructive-foreground:#ffffff;--warning-foreground:#ffffff;\
--success-foreground:#ffffff;--info-foreground:#ffffff;";
const COMMON: &str = "--radius:10px;--font-sans:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",system-ui,sans-serif;\
--font-mono:\"JetBrains Mono\",ui-monospace,\"SF Mono\",monospace;";
const BASE: &str = "html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans);\
scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}";
/// Nomes comuns de tema de componente, derivados das cores-base: seguem o tema do app e a troca dele. Especificidade
/// zero: a página e o cliente sobrescrevem. O `-foreground` de cada cor de estado é o texto sobre ela e mora nos
/// esquemas (escuro sobre as cores claras do tema escuro, branco sobre as escuras do claro); sobre a superfície suave o
/// texto é a própria cor.
const DERIVED: &str = ":where(:root){--muted:var(--surface);--card:var(--surface);--card-foreground:var(--foreground);\
--popover:var(--surface);--popover-foreground:var(--foreground);--secondary:var(--surface);\
--secondary-foreground:var(--foreground);--input:var(--border);--ring:var(--accent);--primary:var(--accent);\
--primary-foreground:var(--accent-foreground);--accent-surface:color-mix(in srgb,var(--accent) 14%,transparent);\
--accent-surface-foreground:var(--foreground);--destructive:var(--danger);\
--destructive-surface:color-mix(in srgb,var(--danger) 14%,transparent);\
--warning-surface:color-mix(in srgb,var(--warning) 14%,transparent);--code-foreground:var(--foreground)}";

/// Ponte com o app: tamanho, link e troca de tema, no formato JSON-RPC do MCP Apps.
const HOST: &str = r#"(()=>{const send=m=>{const s=JSON.stringify(m);if(window.hangarHost)window.hangarHost(s);
else if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else if(window.parent!==window)window.parent.postMessage(m,"*")};
let last=0;const size=()=>{const d=document.documentElement,b=document.body;if(!d)return;
const h=Math.ceil(d.scrollHeight>d.clientHeight?d.scrollHeight:Math.max(d.getBoundingClientRect().height,b?b.getBoundingClientRect().height:0));
if(h!==last){last=h;send({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:h}})}};
const watch=()=>{const r=new ResizeObserver(size);r.observe(document.documentElement);if(document.body)r.observe(document.body);size()};
document.readyState==="loading"?document.addEventListener("DOMContentLoaded",watch):watch();addEventListener("load",size);
document.addEventListener("click",e=>{if(!e.isTrusted)return;const a=e.target.closest&&e.target.closest("a[href]");if(!a)return;
const u=a.href;if(!/^https?:/i.test(u))return;e.preventDefault();
send({jsonrpc:"2.0",method:"ui/open-link",params:{url:u,ctrlKey:e.ctrlKey,metaKey:e.metaKey}})},true);
const apply=p=>{const v=(p&&p.styles&&p.styles.variables)||{};const t=p&&p.theme==="light"?"light":"dark";
const css=Object.entries(v).filter(([k])=>/^--[a-z0-9-]+$/.test(k)).map(([k,x])=>k+":"+String(x).replace(/[;{}<]/g,"")).join(";");
const el=document.getElementById("hangar-theme");if(el)el.textContent=":root{color-scheme:"+t+";"+(el.dataset[t]||"")+css+"}"+el.dataset.base};
window.__hangarApply=apply;addEventListener("message",e=>{const d=e.data;if(d&&d.method==="ui/notifications/host-context-changed")apply(d.params)})})();"#;

static HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<head(\s[^>]*)?>").unwrap());
static HTML: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<html(\s[^>]*)?>").unwrap());
static DOCTYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\x{FEFF}?\s*<!doctype[^>]*>").unwrap());
static INERT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<!--.*?-->|<script\b.*?</script\s*>|<style\b.*?</style\s*>|<template\b.*?</template\s*>").unwrap()
});

/// `data-dark` e `data-light` guardam os padrões de cada esquema (cores, raio e fontes), de onde a troca de tema parte
/// antes de aplicar as do cliente; `data-base`, o CSS que ela não reescreve e que vem depois, sem variável que o
/// cliente mande (senão venceria a dele).
/// Página com tema próprio leva só a ponte: tamanho e link ainda passam por ela.
fn block(follow_app_theme: bool) -> String {
    let host = format!("<script id=\"hangar-host\">{HOST}</script>");
    if !follow_app_theme { return host; }
    let css = format!(":root{{color-scheme:dark;{DARK}{COMMON}}}@media (prefers-color-scheme: light){{:root{{color-scheme:light;{LIGHT}}}}}{BASE}{DERIVED}");
    let attr = |v: &str| v.replace('"', "&quot;");
    let (dark, light, base) = (attr(&format!("{DARK}{COMMON}")), attr(&format!("{LIGHT}{COMMON}")), attr(&format!("{BASE}{DERIVED}")));
    format!("<style id=\"hangar-theme\" data-base=\"{base}\" data-dark=\"{dark}\" data-light=\"{light}\">{css}</style>{host}")
}

/// Posições cobertas por comentário, script, style ou template: um `<head>` ali dentro não conta.
fn inert_ranges(html: &str) -> Vec<(usize, usize)> {
    INERT.find_iter(html).map(|m| (m.start(), m.end())).collect()
}

fn first_live(re: &Regex, html: &str, inert: &[(usize, usize)]) -> Option<usize> {
    re.find_iter(html).find(|m| !inert.iter().any(|(a, b)| m.start() >= *a && m.start() < *b)).map(|m| m.end())
}

static INJECTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<style id="hangar-theme"[^>]*>[^<]*</style>|<script id="hangar-host">.*?</script>"#).unwrap()
});

/// O documento que o app mostra: tema e ponte na frente da página gravada.
pub fn served(stored: String, meta: &PageMeta) -> String {
    if meta.original { inject(&stored, !meta.own_theme) } else { stored }
}

/// A página como o agente a escreveu, para a Fonte, copiar e salvar. Só a página gravada antes de `original` precisa
/// tirar o bloco do arquivo, e ali o `<head>` que o `inject` criou fica, vazio.
pub fn source(stored: String, meta: &PageMeta) -> String {
    if meta.original { stored } else { INJECTED.replacen(&stored, 2, "").into_owned() }
}

pub fn inject(html: &str, follow_app_theme: bool) -> String {
    let inert = inert_ranges(html);
    let ours = block(follow_app_theme);
    if let Some(at) = first_live(&HEAD, html, &inert) {
        return format!("{}{ours}{}", &html[..at], &html[at..]);
    }
    if let Some(at) = first_live(&HTML, html, &inert) {
        return format!("{}<head>{ours}</head>{}", &html[..at], &html[at..]);
    }
    // Antes do doctype o navegador cai em modo quirks, e o layout e a altura mudam.
    let at = DOCTYPE.find(html).map_or(0, |m| m.end());
    format!("{}<head>{ours}</head>{}", &html[..at], &html[at..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_goes_first_in_head() {
        let out = inject("<!doctype html><html><head><style>p{}</style></head><body>x</body></html>", true);
        let head = out.find("<head>").unwrap();
        let ours = out.find("<style id=\"hangar-theme\"").unwrap();
        let theirs = out.find("<style>p{}").unwrap();
        assert!(head < ours && ours < theirs);
        assert!(out.contains("<script id=\"hangar-host\">"));
    }

    #[test]
    fn inject_into_commented_head() {
        let out = inject("<!-- <head> --><html><head></head><body></body></html>", true);
        let comment_end = out.find("-->").unwrap();
        assert!(out.find("hangar-theme").unwrap() > comment_end);
    }

    #[test]
    fn inject_without_head_or_html() {
        let out = inject("<p>oi</p>", true);
        assert!(out.starts_with("<head>"));
        assert!(out.ends_with("<p>oi</p>"));
    }

    #[test]
    fn inject_after_doctype_without_head() {
        let out = inject("<!doctype html><p>oi</p>", true);
        assert!(out.starts_with("<!doctype html><head>"));
        assert!(out.ends_with("</head><p>oi</p>"));
    }

    #[test]
    fn link_click_says_ctrl_and_cmd_and_ignores_synthetic_clicks() {
        // Ctrl/Cmd+clique vai ao navegador do sistema, como no chat; `a.click()` da própria página não abre nada.
        assert!(HOST.contains("ctrlKey:e.ctrlKey,metaKey:e.metaKey") && HOST.contains("if(!e.isTrusted)return;"));
    }

    fn meta(original: bool, own_theme: bool) -> PageMeta {
        PageMeta { title: "t".into(), height: None, heights: Default::default(), created: 0, draft: false, own_theme, url: None, original }
    }

    #[test]
    fn source_is_exactly_what_the_agent_wrote_and_the_bridge_comes_on_read() {
        for original in ["<!doctype html><html><head><title>t</title></head><body><p>oi</p></body></html>", "<p>oi</p>",
            "<!doctype html><p>oi</p>", "<html><head><style id=\"hangar-theme\">:root{--a:1}</style></head><body>x</body></html>"] {
            for own_theme in [false, true] {
                let m = meta(true, own_theme);
                assert_eq!(source(original.to_owned(), &m), original);
                assert_eq!(served(original.to_owned(), &m), inject(original, !own_theme));
            }
        }
    }

    #[test]
    fn theme_block_keeps_both_schemes_for_the_live_switch() {
        let out = inject("<p></p>", true);
        // A troca ao vivo parte dos padrões do esquema do app: cliente que manda só parte das cores não apaga as outras.
        for scheme in ["dark", "light"] {
            let attr = format!(" data-{scheme}=\"");
            let at = out.find(&attr).unwrap_or_else(|| panic!("sem data-{scheme}")) + attr.len();
            let defaults = &out[at..at + out[at..].find('"').unwrap()];
            for var in ["--foreground:", "--info:", "--chart-6:", "--code-background:", "--font-sans:"] { assert!(defaults.contains(var), "{scheme} sem {var}"); }
        }
        // O que vem depois das cores do cliente não pode trazer variável que ele mande: venceria a dele.
        let at = out.find(" data-base=\"").unwrap() + 12;
        let base = &out[at..at + out[at..].find('"').unwrap()];
        assert!(["--font-sans:", "--font-mono:", "--radius:"].iter().all(|v| !base.contains(v)), "{base}");
    }

    #[test]
    fn derived_variables_follow_the_base_ones_and_yield_to_the_page() {
        let out = inject("<p></p>", true);
        for var in ["--card:var(--surface)", "--popover:var(--surface)", "--primary:var(--accent)", "--ring:var(--accent)",
            "--destructive:var(--danger)", "--input:var(--border)", "--code-foreground:var(--foreground)"] {
            assert!(out.contains(var), "sem {var}");
        }
        assert!(out.contains(":where(:root){"), "derivadas com especificidade zero: a página e o cliente sobrescrevem");
        assert!(out.contains("--destructive-surface:color-mix("));
    }

    /// Contraste WCAG entre duas cores `#rrggbb`.
    fn contrast(a: &str, b: &str) -> f64 {
        let lum = |hex: &str| {
            let c = |i: usize| f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap()) / 255.;
            let f = |c: f64| if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
            0.2126 * f(c(1)) + 0.7152 * f(c(3)) + 0.0722 * f(c(5))
        };
        let (x, y) = (lum(a), lum(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    #[test]
    fn status_foreground_is_readable_on_its_color() {
        // `background: var(--destructive); color: var(--destructive-foreground)` é o uso comum: o texto não some no fundo.
        let value = |scheme: &str, var: &str| {
            let at = scheme.find(&format!("{var}:")).unwrap_or_else(|| panic!("sem {var}")) + var.len() + 1;
            scheme[at..at + 7].to_owned()
        };
        for scheme in [DARK, LIGHT] {
            for (color, on) in [("--danger", "--destructive-foreground"), ("--warning", "--warning-foreground"),
                ("--success", "--success-foreground"), ("--info", "--info-foreground")] {
                let ratio = contrast(&value(scheme, color), &value(scheme, on));
                assert!(ratio >= 4.5, "{on} sobre {color}: {ratio:.2}");
            }
        }
    }

    #[test]
    fn page_saved_with_the_block_in_the_file_is_served_as_is_and_its_source_drops_it() {
        let m = meta(false, false);
        let stored = inject("<html><head></head><body>x</body></html>", true);
        assert_eq!(served(stored.clone(), &m), stored);
        assert_eq!(source(stored, &m), "<html><head></head><body>x</body></html>");
    }

    #[test]
    fn draft_backdrop_is_the_conversation_background() {
        // O fundo do print do rascunho é o mesmo `--code-background` (o `--bg-base` da conversa) de cada esquema.
        for (theme, colors) in [(super::super::Theme::Dark, DARK), (super::super::Theme::Light, LIGHT)] {
            let (r, g, b) = theme.backdrop();
            assert!(colors.contains(&format!("--code-background:#{r:02x}{g:02x}{b:02x};")), "{theme:?}");
        }
    }

    #[test]
    fn background_is_transparent_in_both_schemes() {
        let out = inject("<p></p>", true);
        let css = &out[out.find("\">").unwrap()..out.find("</style>").unwrap()];
        assert_eq!(css.matches("--background:transparent").count(), 2, "escuro e claro no CSS");
        assert!(DARK.contains("--background:transparent") && LIGHT.contains("--background:transparent"), "e na troca ao vivo");
    }

    #[test]
    fn own_theme_gets_only_the_bridge() {
        let out = inject("<!doctype html><html><head><style>p{}</style></head><body></body></html>", false);
        assert!(!out.contains("<style id=\"hangar-theme\"") && !out.contains("--background"));
        assert!(out.contains("<head><script id=\"hangar-host\">"));
        assert!(out.find("hangar-host").unwrap() < out.find("<style>p{}").unwrap());
        assert!(inject("<!doctype html><p>oi</p>", false).starts_with("<!doctype html><head><script id=\"hangar-host\">"));
    }
}
