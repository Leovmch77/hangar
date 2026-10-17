//! Pergunta lateral (`/btw`): os casos de `backend/tests/test_btw.py`, com o overlay simulado por uma
//! sequência de telas e o multiplexador falso nos dois sabores (tmux e psmux 3.3.8, como lá).
use hangar_server::btw_control::{self, BtwLimits};
use hangar_server::session_write::btw::*;
use hangar_server::terminal_input::*;
use serde_json::{Value, json};
use std::{collections::VecDeque, path::Path, sync::{Arc, Mutex}, time::Duration};

// Rodapés reais do overlay (os mesmos do teste Python).
const WALKING: &str = "    ⇧←/→ to browse · x to clear history · Esc to close";
const READY: &str = "    ↑/↓ to scroll · c to copy · f to fork · Esc to close";
const COPIED: &str = "    ↑/↓ to scroll · Copied to clipboard · f to fork · Esc to close";
const WIN_ESC: &str = "\u{1b}[27;1;27;1;0;1_\u{1b}[27;1;27;0;0;1_";

fn screen(lines: &[&str]) -> String { format!("conversa\n{}\n", lines.join("\n")) }

#[derive(Clone, Copy, PartialEq)]
enum Mux { Tmux, Psmux }

/// O `TmuxFalso` do Python: cada captura tira uma tela da fila (a última fica); o composer é o texto
/// digitado sem espaço, e `resist` é o que o C-u não apaga.
struct Fake {
    screens: Mutex<VecDeque<String>>, keys: Mutex<Vec<String>>, raw: Mutex<Vec<Vec<String>>>,
    buffers: Mutex<Vec<(String, String)>>, mux: Mux, answer: String, buffer_after_c: bool,
    composer: Mutex<String>, resist: String, lose_slash: Mutex<usize>,
    after_typing: Mutex<Option<VecDeque<Option<String>>>>, typed_once: Mutex<bool>,
    fail_enter: bool, fail_literal: bool, fail_escape: bool, close_to: Option<String>,
    target_gone: bool, at_typing: Mutex<Option<String>>, name: String,
}
impl Fake {
    fn new(screens: &[String]) -> Self {
        Self { screens: Mutex::new(screens.iter().cloned().collect()), keys: Mutex::default(), raw: Mutex::default(),
            buffers: Mutex::default(), mux: Mux::Tmux, answer: "1. Apple\n2. Banana\n".into(), buffer_after_c: true,
            composer: Mutex::default(), resist: String::new(), lose_slash: Mutex::new(0), after_typing: Mutex::new(None),
            typed_once: Mutex::new(false), fail_enter: false, fail_literal: false, fail_escape: false,
            close_to: Some(screen(&["❯ "])), target_gone: false, at_typing: Mutex::new(None), name: "s".into() }
    }
    fn keys(&self) -> Vec<String> { self.keys.lock().unwrap().clone() }
    fn composer_screen(&self) -> String {
        let scripted = if *self.typed_once.lock().unwrap() { self.after_typing.lock().unwrap().as_mut().and_then(VecDeque::pop_front) } else { None };
        let rule = "─".repeat(30);
        match scripted {
            Some(None) => "sem réguas\n".into(),
            Some(Some(text)) => format!("{rule}\n❯ {text}\n{rule}\n"),
            None => format!("{rule}\n❯ {}{}\n{rule}\n", self.resist, self.composer.lock().unwrap()),
        }
    }
    fn buffer(&self, args: &[String]) -> (bool, String, String) {
        let (sub, rest) = (args[0].as_str(), &args[1..]);
        let targeted = rest.iter().any(|a| a == "-t");
        let named = rest.iter().position(|a| a == "-b").map(|i| rest[i + 1].clone());
        if targeted && self.target_gone { return (false, String::new(), "can't find session: =s\n".into()); }
        if self.mux == Mux::Tmux && targeted { return (false, String::new(), format!("command {sub}: unknown flag -t\n")); }
        let mut all = self.buffers.lock().unwrap();
        let mut none = Vec::new();
        // psmux sem alvo: a sessão padrão é outra, que não tem os buffers desta.
        let buffers = if self.mux == Mux::Tmux || targeted { &mut *all } else { &mut none };
        match sub {
            "list-buffers" if self.mux == Mux::Psmux => (true, (0..buffers.len()).map(|i| format!("buffer{i:04}\n")).collect(), String::new()),
            "list-buffers" => (true, buffers.iter().map(|(n, _)| format!("{n}\n")).collect(), String::new()),
            "show-buffer" if self.mux == Mux::Psmux && named.is_some() => (true, String::new(), String::new()),
            "show-buffer" => (true, buffers.iter().find(|(n, _)| named.as_ref().is_none_or(|b| b == n)).map(|(_, c)| c.clone()).unwrap_or_default(), String::new()),
            "delete-buffer" if self.mux == Mux::Psmux && named.is_some() => (true, String::new(), String::new()),
            "delete-buffer" => {
                if let Some(i) = buffers.iter().position(|(n, _)| named.as_ref().is_none_or(|b| b == n)) { buffers.remove(i); }
                (true, String::new(), String::new())
            }
            other => panic!("comando de buffer inesperado: {other}"),
        }
    }
    fn send(&self, rest: &[String]) -> bool {
        let key = match rest {
            [l, dash, cr] if l == "-l" && dash == "--" && cr == "\r" => "Enter".to_owned(),
            [l, dash, esc] if l == "-l" && dash == "--" && esc == WIN_ESC => "Escape".to_owned(),
            [l, dash, text] if l == "-l" && dash == "--" => {
                if self.fail_literal { return false; }
                *self.at_typing.lock().unwrap() = self.screens.lock().unwrap().front().cloned();
                let mut text = text.clone();
                let mut lose = self.lose_slash.lock().unwrap();
                if text.starts_with('/') && *lose > 0 { *lose -= 1; text.remove(0); }
                *self.composer.lock().unwrap() = text.split_whitespace().collect();
                *self.typed_once.lock().unwrap() = true;
                self.keys.lock().unwrap().push(rest[2].clone());
                return true;
            }
            [key] => key.clone(),
            other => panic!("tecla inesperada: {other:?}"),
        };
        self.keys.lock().unwrap().push(key.clone());
        match key.as_str() {
            "Enter" => { if self.fail_enter { return false; } self.composer.lock().unwrap().clear(); }
            "C-u" => self.composer.lock().unwrap().clear(),
            "Escape" => {
                if self.fail_escape { return false; }
                if let Some(to) = &self.close_to { *self.screens.lock().unwrap() = [to.clone()].into(); }
            }
            "c" if self.buffer_after_c => {
                // O OSC 52 do psmux vira DOIS buffers iguais (medido).
                let mut buffers = self.buffers.lock().unwrap();
                for _ in 0..if self.mux == Mux::Psmux { 2 } else { 1 } {
                    let name = format!("buffer{}", 7 + buffers.len());
                    buffers.insert(0, (name, self.answer.clone()));
                }
            }
            _ => {}
        }
        true
    }
}
impl TerminalIo for Fake {
    fn command<'a>(&'a self, r: CommandRequest) -> IoFuture<'a, CommandOutput> {
        Box::pin(async move { let (output, _) = self.command_stderr(r).await?; Ok(output) })
    }
    fn command_stderr<'a>(&'a self, r: CommandRequest) -> IoFuture<'a, (CommandOutput, Vec<u8>)> {
        Box::pin(async move {
            self.raw.lock().unwrap().push(r.args.clone());
            let ok = |stdout: String| Ok((CommandOutput { success: true, stdout: stdout.into_bytes() }, vec![]));
            match r.args[0].as_str() {
                "display-message" => ok(format!("{}\t%7\t17\n", self.name)),
                "capture-pane" if r.args.iter().any(|a| a == "-e") => ok(self.composer_screen()),
                "capture-pane" => {
                    let mut screens = self.screens.lock().unwrap();
                    ok(if screens.len() > 1 { screens.pop_front().unwrap() } else { screens[0].clone() })
                }
                "send-keys" => {
                    let sent = self.send(&r.args[3..]);
                    Ok((CommandOutput { success: sent, stdout: vec![] }, vec![]))
                }
                _ => {
                    let (success, stdout, stderr) = self.buffer(&r.args);
                    Ok((CommandOutput { success, stdout: stdout.into_bytes() }, stderr.into_bytes()))
                }
            }
        })
    }
    fn socket<'a>(&'a self, _: &'a NativeMessage, _: Vec<u8>) -> IoFuture<'a, WriteOutcome> { Box::pin(async { Ok(WriteOutcome::NotWritten) }) }
}

fn binding(tag: &str, windows: bool) -> TerminalBinding {
    TerminalBinding { name: "s".into(), pane: if windows { "=s:0.0" } else { "%7" }.into(), conversation: "sid".into(), generation: 1, created: 17,
        mux_argv: vec![format!("fake-{tag}")], windows, clipboard_lock_path: None }
}
struct Services { binding: TerminalBinding, panel: bool }
impl TerminalServices for Services {
    fn facts<'a>(&'a self, _: &'a TerminalBinding) -> ServiceFuture<'a, InputFacts> {
        Box::pin(async { Ok(InputFacts { binding: self.binding.clone(), ready: true, idle: true, open_question: false, plugin_live: false,
            plugin_user: false, clipboard_available: false, native: None, screen: None }) })
    }
    fn publish<'a>(&'a self, _: &'a TerminalBinding, _: PluginRequest) -> ServiceFuture<'a, PluginReply> { Box::pin(async { Ok(PluginReply::Unavailable) }) }
    fn permission_guard<'a>(&'a self, _: &'a TerminalBinding) -> ServiceFuture<'a, ()> {
        Box::pin(async { if self.panel { Err(ServiceError("terminal_panel_active")) } else { Ok(()) } })
    }
}
fn limits() -> BtwLimits {
    BtwLimits { poll: Duration::from_millis(1), settle: Duration::from_millis(1), open: Duration::from_millis(40), copy: Duration::from_millis(40), answer: Duration::from_secs(5) }
}
/// Cada teste com o seu multiplexador: a medida do `-t` é por multiplexador, e os testes correm juntos.
async fn ask_with(fake: Arc<Fake>, tag: &str, question: &str, windows: bool, panel: bool, limits: BtwLimits) -> Result<Value, btw_control::BtwError> {
    let binding = binding(tag, windows);
    let driver = TerminalDriver::new(binding.clone(), Arc::new(Services { binding, panel }), fake, InputLimits::default()).controls();
    btw_control::ask(&driver, question, &limits).await
}
async fn ask(fake: &Arc<Fake>, tag: &str, question: &str) -> Result<Value, btw_control::BtwError> { ask_with(fake.clone(), tag, question, false, false, limits()).await }
fn code(result: Result<Value, btw_control::BtwError>) -> (u16, String) { let e = result.unwrap_err(); (e.status, e.code) }

fn answered() -> Vec<String> { vec![screen(&["❯ "]), screen(&["    /btw q", "      4", READY]), screen(&["    /btw q", "      4", COPIED])] }

/// B7, B15, B20, B23 (`test_le_a_resposta_do_buffer_e_fecha_o_overlay`). O `C-u` da sequência do
/// Python vem do composer falso dele, que apaga sempre: aqui o composer começa com um rascunho.
#[tokio::test]
async fn reads_the_answer_from_the_buffer_and_closes_the_overlay() {
    let mut fake = Fake::new(&[screen(&["❯ "]), screen(&["    /btw list fruits", "      · Answering…", WALKING]),
        screen(&["    /btw list fruits", "      1. Apple", READY]), screen(&["    /btw list fruits", "      1. Apple", COPIED])]);
    fake.composer = Mutex::new("rascunho".into());
    let fake = Arc::new(fake);
    let r = ask(&fake, "read", "list   fruits").await.unwrap();
    assert_eq!((r["answer"].as_str(), r["fonte"].as_str(), r["question"].as_str()), (Some("1. Apple\n2. Banana"), Some("buffer"), Some("list fruits")));
    assert!(r["ts"].as_f64().is_some_and(|ts| ts > 1.0e9));
    assert_eq!(r.as_object().unwrap().keys().collect::<Vec<_>>(), ["question", "answer", "fonte", "ts"]);
    assert_eq!(fake.keys(), ["C-u", "/btw list fruits", "Enter", "c", "Escape"]);
    assert!(fake.buffers.lock().unwrap().is_empty());
}

/// B20 (`test_close_failure_is_not_reported_as_success`): Esc que não sai, overlay que não fecha e tela
/// ilegível depois dele não viram sucesso, e o Esc não se repete.
#[tokio::test]
async fn close_failure_is_not_reported_as_success() {
    for (tag, failure) in [("close-a", "not_sent"), ("close-b", "still_open"), ("close-c", "unreadable")] {
        let mut fake = Fake::new(&answered());
        fake.buffer_after_c = true;
        match failure { "not_sent" => fake.fail_escape = true, "still_open" => fake.close_to = Some(screen(&["x", READY])), _ => fake.close_to = Some(String::new()) }
        let fake = Arc::new(fake);
        assert_eq!(code(ask(&fake, tag, "q").await), (502, "erro_btw_overlay_aberto".into()), "{failure}");
        assert_eq!(fake.keys().iter().filter(|k| *k == "Escape").count(), 1, "{failure}");
    }
}

/// B16, B17, B18 (`test_psmux_le_o_buffer_da_sessao_e_apaga_as_duas_copias`).
#[tokio::test]
async fn psmux_reads_the_session_buffer_and_deletes_both_copies() {
    let mut fake = Fake::new(&[screen(&["❯ "]), screen(&["    /btw q", "      corte da tela", READY]), screen(&["    /btw q", "      corte da tela", COPIED])]);
    (fake.mux, fake.answer) = (Mux::Psmux, "resposta inteira\ncom duas linhas\n".into());
    let fake = Arc::new(fake);
    let r = ask(&fake, "psmux", "q").await.unwrap();
    assert_eq!((r["answer"].as_str(), r["fonte"].as_str()), (Some("resposta inteira\ncom duas linhas"), Some("buffer")));
    assert!(fake.buffers.lock().unwrap().is_empty());
}

/// B19 (`test_buffer_vazio_cai_no_pane`).
#[tokio::test]
async fn empty_buffer_falls_back_to_the_pane() {
    let mut fake = Fake::new(&answered());
    fake.answer = String::new();
    let fake = Arc::new(fake);
    let r = ask(&fake, "empty-buffer", "q").await.unwrap();
    assert_eq!((r["answer"].as_str(), r["fonte"].as_str()), (Some("4"), Some("pane")));
}

/// B19 (`test_sem_buffer_cai_no_pane`).
#[tokio::test]
async fn no_buffer_falls_back_to_the_pane_and_still_closes() {
    let mut fake = Fake::new(&answered());
    fake.buffer_after_c = false;
    let fake = Arc::new(fake);
    let r = ask(&fake, "no-buffer", "q").await.unwrap();
    assert_eq!((r["answer"].as_str(), r["fonte"].as_str()), (Some("4"), Some("pane")));
    assert_eq!(fake.keys().last().map(String::as_str), Some("Escape"));
}

/// B16 (`test_sessao_que_sumiu_nao_desliga_o_alvo_pra_sempre`): recusa sem "unknown flag" não decide
/// pelo psmux sem alvo: nenhum comando de buffer sai sem `-t`.
#[tokio::test]
async fn vanished_session_does_not_turn_the_target_off() {
    let mut fake = Fake::new(&answered());
    (fake.mux, fake.target_gone) = (Mux::Psmux, true);
    let fake = Arc::new(fake);
    assert_eq!(ask(&fake, "gone", "q").await.unwrap()["fonte"], "pane");
    let buffer_calls: Vec<Vec<String>> = fake.raw.lock().unwrap().iter().filter(|a| a[0].ends_with("-buffer") || a[0] == "list-buffers").cloned().collect();
    assert!(!buffer_calls.is_empty());
    assert!(buffer_calls.iter().all(|a| a.iter().any(|x| x == "-t")), "{buffer_calls:?}");
}

/// B16: a recusa da flag no tmux desliga o `-t` uma vez para esse multiplexador.
#[tokio::test]
async fn tmux_refusing_the_flag_turns_the_target_off_once() {
    let fake = Arc::new(Fake::new(&answered()));
    ask(&fake, "flag-once", "q").await.unwrap();
    let targeted = fake.raw.lock().unwrap().iter().filter(|a| (a[0].ends_with("-buffer") || a[0] == "list-buffers") && a.iter().any(|x| x == "-t")).count();
    assert_eq!(targeted, 1);
}

/// B18 (`test_tmux_nao_apaga_por_contagem`).
#[tokio::test]
async fn tmux_never_deletes_by_count() {
    let fake = Arc::new(Fake::new(&[screen(&["❯ "]), screen(&["    /btw q", "      x", READY]), screen(&["    /btw q", "      x", COPIED])]));
    fake.buffers.lock().unwrap().push(("alheio".into(), "copia de outra pessoa".into()));
    assert_eq!(ask(&fake, "count", "q").await.unwrap()["fonte"], "buffer");
    assert_eq!(*fake.buffers.lock().unwrap(), [("alheio".to_owned(), "copia de outra pessoa".to_owned())]);
}

/// B14 (`test_overlay_que_nao_abre_e_409`).
#[tokio::test]
async fn overlay_that_never_opens_is_409_without_escape() {
    let fake = Arc::new(Fake::new(&[screen(&["❯ "])]));
    assert_eq!(code(ask(&fake, "never", "q").await), (409, "erro_btw_nao_abriu".into()));
    assert!(!fake.keys().contains(&"Escape".to_owned()));
}

/// B7 (`test_pergunta_vazia_nao_digita`).
#[tokio::test]
async fn blank_question_types_nothing() {
    let fake = Arc::new(Fake::new(&[screen(&["❯ "])]));
    assert_eq!(code(ask(&fake, "blank", "   ").await), (400, "erro_btw_vazia".into()));
    assert!(fake.keys().is_empty());
}

/// B10 (`test_rascunho_que_sai_com_c_u_nao_impede_a_pergunta`).
#[tokio::test]
async fn draft_cleared_by_ctrl_u_does_not_stop_the_question() {
    let mut fake = Fake::new(&answered());
    (fake.buffer_after_c, fake.composer) = (false, Mutex::new("rascunho".into()));
    let fake = Arc::new(fake);
    assert_eq!(ask(&fake, "draft", "q").await.unwrap()["answer"], "4");
    assert!(fake.keys().contains(&"Enter".to_owned()));
}

/// B12 (`test_residuo_que_resiste_ao_c_u_para_sem_enter`).
#[tokio::test]
async fn residue_that_resists_ctrl_u_stops_without_enter() {
    let mut fake = Fake::new(&[screen(&["❯ lixo"])]);
    fake.resist = "lixo".into();
    let fake = Arc::new(fake);
    assert_eq!(code(ask(&fake, "residue", "q").await), (409, "erro_btw_composer_ocupado".into()));
    assert!(!fake.keys().contains(&"Enter".to_owned()));
}

/// B14 (`test_overlay_fechado_por_fora_aborta_sem_escape`).
#[tokio::test]
async fn overlay_closed_from_outside_aborts_without_escape() {
    let fake = Arc::new(Fake::new(&[screen(&["❯ "]), screen(&["    /btw q", "      · Answering…", WALKING]), screen(&["❯ "])]));
    assert_eq!(code(ask(&fake, "outside", "q").await), (409, "erro_btw_fechado".into()));
    assert!(!fake.keys().contains(&"Escape".to_owned()));
}

/// B12 (`test_barra_perdida_redigita_sem_mandar_a_pergunta_pra_conversa`). Rascunho inicial pelo mesmo
/// motivo do primeiro teste.
#[tokio::test]
async fn lost_slash_retypes_without_sending_to_the_conversation() {
    let mut fake = Fake::new(&answered());
    (fake.buffer_after_c, fake.composer, fake.lose_slash) = (false, Mutex::new("x".into()), Mutex::new(1));
    let fake = Arc::new(fake);
    assert_eq!(ask(&fake, "slash", "q").await.unwrap()["answer"], "4");
    let keys = fake.keys();
    let enter = keys.iter().position(|k| k == "Enter").unwrap();
    assert_eq!(keys[..enter], ["C-u", "/btw q", "C-u", "/btw q"]);
}

/// B12 (`test_barra_perdida_de_novo_para_sem_enter`).
#[tokio::test]
async fn lost_slash_twice_stops_without_enter_and_clears_blindly() {
    let mut fake = Fake::new(&[screen(&["❯ "])]);
    fake.lose_slash = Mutex::new(5);
    let fake = Arc::new(fake);
    assert_eq!(code(ask(&fake, "slash-twice", "q").await), (502, "erro_btw_barra_perdida".into()));
    let keys = fake.keys();
    assert!(!keys.contains(&"Enter".to_owned()));
    assert!(fake.composer.lock().unwrap().is_empty());
    assert_eq!(keys[keys.len() - 3..], ["C-u", "C-u", "C-u"]);
}

/// B9 (`test_espera_o_overlay_anterior_fechar_antes_de_digitar`).
#[tokio::test]
async fn waits_for_the_previous_overlay_to_close_before_typing() {
    let mut fake = Fake::new(&[screen(&["    /btw antiga", "      x", READY]), screen(&["❯ "]), screen(&["❯ "]),
        screen(&["    /btw q", "      4", READY]), screen(&["    /btw q", "      4", COPIED])]);
    fake.buffer_after_c = false;
    let fake = Arc::new(fake);
    ask(&fake, "previous", "q").await.unwrap();
    assert!(!fake.at_typing.lock().unwrap().clone().unwrap().contains("Esc to close"));
}

/// B9 (`test_overlay_que_nao_fecha_para_sem_digitar`).
#[tokio::test]
async fn stuck_overlay_stops_without_typing() {
    let fake = Arc::new(Fake::new(&[screen(&["    /btw alheia", "      x", READY])]));
    assert_eq!(code(ask(&fake, "stuck", "q").await), (409, "erro_btw_overlay_aberto".into()));
    assert!(fake.keys().is_empty());
}

/// B12 (`test_composer_ilegivel_depois_de_digitar_para_sem_enter`).
#[tokio::test]
async fn unreadable_composer_after_typing_stops_without_enter() {
    let fake = Arc::new(Fake::new(&[screen(&["❯ "])]));
    *fake.after_typing.lock().unwrap() = Some([None, None].into());
    assert_eq!(code(ask(&fake, "unreadable", "q").await), (502, "erro_btw_composer_ilegivel".into()));
    let keys = fake.keys();
    assert!(!keys.contains(&"Enter".to_owned()));
    assert_eq!(keys[keys.len() - 3..], ["C-u", "C-u", "C-u"]);
}

/// B13 (`test_enter_que_nao_chega_diz_isso_na_hora`).
#[tokio::test]
async fn enter_that_does_not_arrive_says_so_at_once() {
    let mut fake = Fake::new(&[screen(&["❯ "])]);
    fake.fail_enter = true;
    let fake = Arc::new(fake);
    assert_eq!(code(ask(&fake, "enter", "q").await), (502, "erro_btw_enter_nao_enviado".into()));
    let keys = fake.keys();
    assert_eq!(keys[keys.len() - 3..], ["C-u", "C-u", "C-u"]);
}

/// B12 (`test_composer_ilegivel_uma_vez_relê_e_segue`).
#[tokio::test]
async fn composer_unreadable_once_rereads_and_goes_on() {
    let mut fake = Fake::new(&answered());
    fake.buffer_after_c = false;
    let fake = Arc::new(fake);
    *fake.after_typing.lock().unwrap() = Some([None, Some("/btwq".into())].into());
    assert_eq!(ask(&fake, "once", "q").await.unwrap()["answer"], "4");
}

/// B11 (`btw.py:180`): o texto que não chega ao pane para antes do Enter.
#[tokio::test]
async fn text_that_cannot_be_typed_is_502() {
    let mut fake = Fake::new(&[screen(&["❯ "])]);
    fake.fail_literal = true;
    let fake = Arc::new(fake);
    assert_eq!(code(ask(&fake, "literal", "q").await), (502, "erro_btw_nao_digitou".into()));
    assert!(!fake.keys().contains(&"Enter".to_owned()));
}

/// B14 (`btw.py:228`): aberto sem resposta no prazo fecha com Esc e responde 504.
#[tokio::test]
async fn open_overlay_without_answer_closes_and_is_504() {
    let fake = Arc::new(Fake::new(&[screen(&["❯ "]), screen(&["    /btw q", "      · Answering…", WALKING])]));
    let short = BtwLimits { answer: Duration::from_millis(30), ..limits() };
    assert_eq!(code(ask_with(fake.clone(), "slow", "q", false, false, short).await), (504, "erro_btw_sem_resposta".into()));
    assert_eq!(fake.keys().last().map(String::as_str), Some("Escape"));
}

/// B22 (`btw.py:255`): nem buffer nem pane trazem texto.
#[tokio::test]
async fn nothing_readable_is_502() {
    let mut fake = Fake::new(&[screen(&["❯ "]), screen(&["sem pergunta", READY])]);
    fake.buffer_after_c = false;
    let fake = Arc::new(fake);
    assert_eq!(code(ask(&fake, "nothing", "q").await), (502, "erro_btw_ilegivel".into()));
}

/// B21 (`tmux.py:1077`): no Windows o Esc vai como a sequência Win32.
#[tokio::test]
async fn windows_escape_is_the_win32_sequence() {
    let mut fake = Fake::new(&answered());
    fake.buffer_after_c = false;
    let fake = Arc::new(fake);
    ask_with(fake.clone(), "windows", "q", true, false, limits()).await.unwrap();
    let raw = fake.raw.lock().unwrap();
    let escape = raw.iter().find(|a| a[0] == "send-keys" && a.last().is_some_and(|k| k == WIN_ESC)).expect("Esc Win32");
    assert_eq!(escape[3..], ["-l", "--", WIN_ESC]);
}

/// B5 (`api.py:5036`): painel de terminal aberto recusa com o código do app, sem tecla.
#[tokio::test]
async fn open_terminal_panel_refuses_without_keys() {
    let fake = Arc::new(Fake::new(&answered()));
    assert_eq!(code(ask_with(fake.clone(), "panel", "q", false, true, limits()).await), (409, "erro_terminal_aberto".into()));
    assert!(fake.keys().is_empty());
}

// ── Rota: corpo, decisão, histórico ─────────────────────────────────────────────────────────────

/// B6 (`api.py:1919`): `question` de 1 a 4000 caracteres (code points), nada a mais, com o 422 do FastAPI.
#[test]
fn body_is_the_strict_python_model() {
    assert_eq!(parse_body(br#"{"question":"oi"}"#).unwrap(), "oi");
    assert_eq!(parse_body(format!(r#"{{"question":"{}"}}"#, "é".repeat(4000)).as_bytes()).unwrap().chars().count(), 4000);
    let kind = |body: &[u8]| parse_body(body).unwrap_err()["detail"][0]["type"].as_str().unwrap().to_owned();
    assert_eq!(kind(format!(r#"{{"question":"{}"}}"#, "é".repeat(4001)).as_bytes()), "string_too_long");
    assert_eq!(kind(br#"{"question":""}"#), "string_too_short");
    assert_eq!(kind(br#"{}"#), "missing");
    assert_eq!(kind(br#"{"question":3}"#), "string_type");
    assert_eq!(kind(br#"{"question":null}"#), "string_type");
    assert_eq!(kind(br#"{"question":"q","x":1}"#), "extra_forbidden");
    assert_eq!(kind(b"[]"), "model_attributes_type");
    assert_eq!(kind(b"nao json"), "json_invalid");
    assert_eq!(parse_body(br#"{"question":"q","x":1}"#).unwrap_err()["detail"][0]["loc"], json!(["body", "x"]));
}

/// B1, B3, B4 (`api.py:5348`, `:5351`, `:5338`): sessão que não existe, sem terminal e outro provedor.
#[test]
fn route_follows_provider_terminal_and_existence() {
    use axum::http::StatusCode;
    assert_eq!(route("claude", true), Ok(Route::Terminal));
    assert_eq!(route("claude", false), Ok(Route::Headless));
    for other in ["codex", "pi", "omp", "kimi"] {
        for terminal in [true, false] { assert_eq!(route(other, terminal), Err((StatusCode::BAD_REQUEST, "erro_btw_so_claude"))); }
    }
    assert_eq!(route_of_row(None), Err((StatusCode::NOT_FOUND, "erro_sessao_inexistente")));
    let row = |provider: &str, headless: bool| serde_json::from_value::<hangar_api::session::SessionRow>(json!({"name":"s","provider":provider,"headless":headless})).unwrap();
    assert_eq!(route_of_row(Some(&row("claude", true))), Ok(Route::Headless));
    assert_eq!(route_of_row(Some(&row("claude", false))), Ok(Route::Unowned));
    assert_eq!(route_of_row(Some(&row("pi", false))), Err((StatusCode::BAD_REQUEST, "erro_btw_so_claude")));
}

/// B24 (`test_historico_guarda_so_os_ultimos`): as últimas 50, no formato do `json.dumps` do Python.
#[test]
fn history_keeps_only_the_last_ones_in_the_python_format() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..55 { assert!(record(dir.path(), "s/x", &json!({"question": i.to_string(), "answer": "á", "fonte": "buffer", "ts": i})).unwrap()); }
    let items = history(dir.path(), "s/x").unwrap();
    assert_eq!(items.len(), 50);
    assert_eq!(items[0]["question"], "5");
    let file = dir.path().join(".hangar-btw/s-x.jsonl");
    let text = std::fs::read_to_string(file).unwrap();
    assert_eq!(text.lines().count(), 50);
    assert_eq!(text.lines().next().unwrap(), r#"{"question": "5", "answer": "á", "fonte": "buffer", "ts": 5}"#);
}

/// B24 (`api.py:5360`): disco que falha não vira erro: `salvo: false`.
#[test]
fn history_that_cannot_be_written_is_false_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".hangar-btw"), "arquivo no lugar da pasta").unwrap();
    assert!(!record(dir.path(), "s", &json!({"question": "q"})).unwrap());
}

/// B25 (`btw.py:370`): sem arquivo é `[]` e a pasta nasce; linha inválida é pulada.
#[test]
fn history_without_file_is_empty_and_skips_bad_lines() {
    let dir = tempfile::tempdir().unwrap();
    assert!(history(dir.path(), "s").unwrap().is_empty());
    assert!(dir.path().join(".hangar-btw").is_dir());
    std::fs::write(dir.path().join(".hangar-btw/s.jsonl"), "{\"question\": \"a\"}\nnao json\n\n   \n{\"question\": \"b\"}\n").unwrap();
    assert_eq!(history(dir.path(), "s").unwrap(), [json!({"question":"a"}), json!({"question":"b"})]);
}

// ── Sem terminal: o fork ─────────────────────────────────────────────────────────────────────────

/// B31 (`test_sem_terminal_*`): argv do fork, modelo, motor e `--` antes da pergunta.
#[test]
fn fork_argv_matches_the_python() {
    let argv = fork_argv(&json!({"session_id":"sid-antigo"}), "novo", "quanto é 2+2?");
    assert_eq!(argv[..2], ["claude", "-p"]);
    assert_eq!(argv[argv.iter().position(|a| a == "--resume").unwrap() + 1], "sid-antigo");
    assert!(argv.contains(&"--fork-session".into()));
    assert!(argv[argv.iter().position(|a| a == "--disallowed-tools").unwrap() + 1].contains("Bash"));
    assert_eq!(argv[argv.iter().position(|a| a == "--session-id").unwrap() + 1], "novo");
    assert_eq!(argv[argv.len() - 2..], ["--", "quanto é 2+2?"]);
    assert!(!argv.contains(&"--model".into()));
    let flag = fork_argv(&json!({"session_id":"s"}), "n", "--dangerously-skip-permissions");
    assert_eq!(flag[flag.len() - 2..], ["--", "--dangerously-skip-permissions"]);
    let model = fork_argv(&json!({"session_id":"s","model":"haiku"}), "n", "q");
    assert_eq!(model[model.iter().position(|a| a == "--model").unwrap() + 1], "haiku");
    let engine = fork_argv(&json!({"session_id":"s","engine":"kimi","model":"k3","context_window":256000}), "n", "q");
    assert_eq!(engine[..7], ["hangar-engine", "--exec", "kimi", "--model", "k3", "--context", "256000"]);
    assert_eq!(engine[engine.iter().position(|a| a == "--").unwrap() + 1], "claude");
    let no_model = fork_argv(&json!({"session_id":"s","engine":"kimi","model":"","context_window":256000}), "n", "q");
    assert_eq!(no_model[..4], ["hangar-engine", "--exec", "kimi", "--"]);
}

/// B32: `is_error`, resposta vazia e saída que não é JSON.
#[test]
fn fork_answer_refuses_errors_and_blank() {
    assert_eq!(fork_answer(br#"{"result": "  4\n"}"#).unwrap(), "4");
    assert_eq!(fork_answer(br#"{"result":"Credit balance is too low","is_error":true}"#).unwrap_err().code, "erro_btw_fork_falhou");
    for blank in [&br#"{"result":""}"#[..], br#"{"result":null}"#, b"", b"nao json", br#"[1]"#] {
        assert_eq!(fork_answer(blank).unwrap_err().code, "erro_btw_ilegivel", "{}", String::from_utf8_lossy(blank));
    }
}

#[cfg(unix)]
mod fork {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Claude falso: grava argv, cwd e conta, cria o transcript do fork como a CLI e responde `out`.
    fn fake_claude(dir: &Path, out: &str, code: i32, sleep: u32) -> std::path::PathBuf {
        let script = dir.join("claude-falso");
        let log = dir.join("rodou");
        std::fs::write(&script, format!(r#"#!/bin/bash
printf '%s\n' "$@" > '{log}.argv'; pwd > '{log}.cwd'; printf '%s' "$CLAUDE_CONFIG_DIR" > '{log}.conta'
while [ $# -gt 0 ]; do [ "$1" = --session-id ] && sid=$2; shift; done
for d in "$CLAUDE_CONFIG_DIR"/projects/*/; do : > "$d$sid.jsonl"; done
sleep {sleep}
printf '%s' '{out}'
exit {code}
"#, log = log.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }
    struct Case { dir: tempfile::TempDir, meta: Value }
    fn case(with_transcript: bool, extra: Value) -> Case {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let conta = dir.path().join("conta");
        let project = conta.join("projects").join(hangar_workspace::worktrees::sanitize_cwd(cwd.to_str().unwrap()));
        std::fs::create_dir_all(&project).unwrap();
        if with_transcript { std::fs::write(project.join("sid-antigo.jsonl"), "{}\n").unwrap(); }
        let mut meta = json!({"name":"s1","cwd":cwd,"session_id":"sid-antigo","config_dir":conta});
        for (k, v) in extra.as_object().unwrap() { meta[k] = v.clone(); }
        Case { dir, meta }
    }
    fn project(c: &Case) -> std::path::PathBuf { std::fs::read_dir(c.dir.path().join("conta/projects")).unwrap().next().unwrap().unwrap().path() }
    async fn run(c: &Case, question: &str, out: &str, code: i32, sleep: u32, timeout: Duration) -> Result<Value, btw_control::BtwError> {
        let claude = fake_claude(c.dir.path(), out, code, sleep);
        ask_headless(&c.meta, question, &c.dir.path().join("padrao/projects"), &Programs { claude: claude.clone(), engine: claude }, timeout).await
    }
    fn ran(c: &Case, what: &str) -> Option<String> { std::fs::read_to_string(c.dir.path().join(format!("rodou.{what}"))).ok() }

    /// B31, B32 (`test_sem_terminal_forka_a_conversa_e_apaga_o_transcript_do_fork`).
    #[tokio::test]
    async fn forks_the_conversation_and_deletes_the_fork_transcript() {
        let c = case(true, json!({"model":"haiku"}));
        let r = run(&c, "quanto   é 2+2?", r#"{"result": "4"}"#, 0, 0, FORK_TIMEOUT).await.unwrap();
        assert_eq!((r["question"].as_str(), r["answer"].as_str(), r["fonte"].as_str()), (Some("quanto é 2+2?"), Some("4"), Some("fork")));
        let argv: Vec<String> = ran(&c, "argv").unwrap().lines().map(str::to_owned).collect();
        assert_eq!(argv.last().unwrap(), "quanto é 2+2?");
        assert_eq!(argv[argv.iter().position(|a| a == "--model").unwrap() + 1], "haiku");
        assert_eq!(ran(&c, "conta").unwrap(), c.meta["config_dir"].as_str().unwrap());
        assert_eq!(ran(&c, "cwd").unwrap().trim(), c.meta["cwd"].as_str().unwrap());
        let left: Vec<_> = std::fs::read_dir(project(&c)).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(left, ["sid-antigo.jsonl"], "só a conversa original fica");
    }

    /// B32 (`test_sem_terminal_sem_conversa_nao_roda_nada`): 409 sem transcript, 404 sem conversa.
    #[tokio::test]
    async fn without_a_conversation_nothing_runs() {
        let c = case(false, json!({}));
        assert_eq!(code(run(&c, "q", "{}", 0, 0, FORK_TIMEOUT).await), (409, "erro_btw_sem_conversa".into()));
        assert!(ran(&c, "argv").is_none());
        let c = case(true, json!({"session_id": null}));
        assert_eq!(code(run(&c, "q", "{}", 0, 0, FORK_TIMEOUT).await), (404, "erro_btw_sem_conversa".into()));
        assert_eq!(code(ask_headless(&Value::Null, "q", c.dir.path(), &Programs::default(), FORK_TIMEOUT).await), (404, "erro_btw_sem_conversa".into()));
        assert_eq!(code(ask_headless(&Value::Null, "  ", c.dir.path(), &Programs::default(), FORK_TIMEOUT).await), (400, "erro_btw_vazia".into()));
    }

    /// B32 (`test_sem_terminal_falha_do_cli_nao_vira_resposta`): código ≠ 0 é 502 e o fork some igual.
    #[tokio::test]
    async fn cli_failure_is_not_an_answer_and_still_cleans_up() {
        let c = case(true, json!({}));
        assert_eq!(code(run(&c, "q", "", 1, 0, FORK_TIMEOUT).await), (502, "erro_btw_fork_falhou".into()));
        assert_eq!(std::fs::read_dir(project(&c)).unwrap().count(), 1);
    }

    /// B32 (`test_sem_terminal_resposta_de_erro_nao_passa_por_resposta`).
    #[tokio::test]
    async fn error_reply_is_not_an_answer() {
        let c = case(true, json!({}));
        assert_eq!(code(run(&c, "q", r#"{"result": "Credit balance is too low", "is_error": true}"#, 0, 0, FORK_TIMEOUT).await), (502, "erro_btw_fork_falhou".into()));
    }

    /// B32 (`test_sem_terminal_que_nao_responde_a_tempo`): 504, e o fork some igual.
    #[tokio::test]
    async fn fork_that_does_not_answer_in_time_is_504() {
        let c = case(true, json!({}));
        assert_eq!(code(run(&c, "q", "{}", 0, 5, Duration::from_millis(300)).await).0, 504);
        assert_eq!(std::fs::read_dir(project(&c)).unwrap().count(), 1);
    }

    /// B31 (`test_sem_terminal_com_motor_passa_pelo_hangar_engine`): o motor recebe o argv inteiro.
    #[tokio::test]
    async fn engine_runs_through_hangar_engine() {
        let c = case(true, json!({"engine":"kimi","model":"k3","context_window":256000}));
        run(&c, "q", r#"{"result":"4"}"#, 0, 0, FORK_TIMEOUT).await.unwrap();
        let argv: Vec<String> = ran(&c, "argv").unwrap().lines().map(str::to_owned).collect();
        assert_eq!(argv[..6], ["--exec", "kimi", "--model", "k3", "--context", "256000"]);
        assert_eq!(argv[argv.iter().position(|a| a == "--").unwrap() + 1], "claude");
    }
}

// ── Entradas externas: nenhuma derruba o servidor ───────────────────────────────────────────────

proptest::proptest! {
    #[test]
    fn pane_text_never_panics(screen in "\\PC*", raw in proptest::collection::vec(proptest::prelude::any::<char>(), 0..400)) {
        let raw: String = raw.into_iter().collect();
        for text in [screen.as_str(), raw.as_str()] {
            let _ = btw_control::answer_from_pane(text);
            let _ = btw_control::footer(text);
            let _ = btw_control::normalize(text);
        }
    }
    #[test]
    fn fork_output_and_body_never_panic(bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..600), text in "\\PC*") {
        let _ = fork_answer(&bytes);
        let _ = parse_body(&bytes);
        let _ = fork_answer(text.as_bytes());
        let _ = parse_body(format!(r#"{{"question":{}}}"#, Value::String(text.clone())).as_bytes());
    }
}
