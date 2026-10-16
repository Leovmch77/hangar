//! Para onde vai um link clicado no chat ou numa página da conversa: a mesma regra nos dois.
use super::*;

/// Pull request do GitHub ou merge request do GitLab (de qualquer servidor): abre no painel de navegador da sessão.
pub fn change_request(url: &str) -> bool {
    let Ok(url) = url::Url::parse(url) else { return false };
    if !matches!(url.scheme(), "http" | "https") { return false; }
    let parts: Vec<&str> = url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    let number = |p: Option<&&str>| p.is_some_and(|p| p.bytes().all(|b| b.is_ascii_digit()));
    let github = url.host_str() == Some("github.com") && parts.get(2) == Some(&"pull") && number(parts.get(3));
    let gitlab = parts.windows(2).position(|w| w == ["-", "merge_requests"]).is_some_and(|at| at >= 2 && number(parts.get(at + 2)));
    github || gitlab
}

/// Ctrl/Cmd+clique vai ao navegador do sistema; PR ou MR, ao painel de navegador da sessão (só Linux e Windows têm).
fn to_panel(url: &str, external: bool) -> bool {
    cfg!(any(target_os = "linux", target_os = "windows")) && !external && change_request(url)
}

/// Quem abre o painel de navegador: o link clicado não carrega a entidade do app.
pub(super) struct Owner(pub WeakEntity<Hangar>);
impl Global for Owner {}

/// Link do chat ou da página. O que não vai ao painel (`to_panel`) vai ao navegador do sistema. Só http(s).
pub fn open_link(url: &str, external: bool, window: &mut Window, cx: &mut App) {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return; }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if to_panel(url, external) && let Some(owner) = cx.try_global::<Owner>().and_then(|o| o.0.upgrade()) {
        owner.update(cx, |this, cx| this.open_in_browser_panel(url.to_owned(), window, cx));
        return;
    }
    let _ = (external, window);
    cx.open_url(url);
}

/// Link vindo de uma página: abre fora do empréstimo de quem recebeu o evento, porque o painel é do app. Da tela
/// cheia (`leave_dialog`), o painel abre atrás do diálogo, então ele sai da frente antes.
#[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
pub fn open_link_later(window: AnyWindowHandle, url: String, external: bool, leave_dialog: bool, cx: &mut App) {
    cx.defer(move |cx| { let _ = cx.update_window(window, |_, window, cx| {
        if leave_dialog && to_panel(&url, external) { window.close_dialog(cx); }
        open_link(&url, external, window, cx);
    }); });
}

#[cfg(test)]
mod tests {
    use super::change_request;

    #[test]
    fn pull_and_merge_requests_are_recognized() {
        for yes in ["https://github.com/jeffer1312/hangar/pull/181", "https://github.com/a/b/pull/7/files",
            "https://gitlab.com/g/p/-/merge_requests/3", "https://git.local/prom/promedico/-/merge_requests/12#note_5",
            "https://GITHUB.com/a/b/pull/9"] {
            assert!(change_request(yes), "{yes}");
        }
        for no in ["https://github.com/a/b", "https://github.com/a/b/pulls", "https://github.com/a/b/pull/x",
            "https://example.com/a/b/pull/7", "https://gitlab.com/g/p/-/merge_requests", "http://github.com/a/b/issues/3",
            "javascript:alert(1)", "não é url"] {
            assert!(!change_request(no), "{no}");
        }
    }
}
