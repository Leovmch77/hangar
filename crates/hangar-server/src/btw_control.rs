//! Pergunta lateral (`/btw`) no Claude com terminal, inteira na trava do pane do executor terminal.
//!
//! O `/btw` responde num overlay da TUI e não grava a resposta em lugar nenhum. A tecla `c` copia a
//! resposta INTEIRA por OSC 52, e o multiplexador a guarda num buffer: é daí que ela sai, sem corte na
//! largura da janela. O overlay aceita o `/btw` no meio de um turno, e o Esc que o fecha não interrompe
//! o turno principal.
use crate::terminal_input::{ComposerSnapshot, PermissionSequence, TerminalDriver};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::{LazyLock, Mutex}, time::Duration};
use tokio::time::Instant;

// Rodapé do overlay: `· Answering…` enquanto responde; `c to copy` só quando a resposta terminou.
const READY: &str = "c to copy";
const OPEN: &str = "Esc to close";
const COPIED: &str = "Copied to clipboard";
const FOOTER_LINES: usize = 3;
/// C-u apaga UMA linha do composer; o teto existe porque nem toda tela honra o C-u.
const CLEAR_MAX_KEYS: usize = 12;

/// Prazos do Python (`btw.py`); os testes os encurtam.
#[derive(Clone, Debug)]
pub struct BtwLimits { pub poll: Duration, pub settle: Duration, pub open: Duration, pub copy: Duration, pub answer: Duration }
impl Default for BtwLimits {
    fn default() -> Self {
        Self { poll: Duration::from_millis(300), settle: Duration::from_millis(300), open: Duration::from_secs(6),
            copy: Duration::from_secs(3), answer: Duration::from_secs(60) }
    }
}

/// Recusa com o status HTTP e o código que o app já traduz.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtwError { pub status: u16, pub code: String, pub message: String }
pub fn fail(status: u16, code: &str, message: &str) -> BtwError { BtwError { status, code: code.into(), message: message.into() } }

/// A pergunta que dá panic vira erro com código: sem resultado o ator não soltaria o pane nem fecharia o diário.
pub async fn contained(work: impl std::future::Future<Output = Result<serde_json::Value, BtwError>>) -> Result<serde_json::Value, BtwError> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(work).catch_unwind().await
        .unwrap_or_else(|_| Err(fail(500, "erro_btw_tarefa_morreu", "a pergunta lateral parou no meio; tente de novo")))
}

// Buffers do tmux são do SERVIDOR, não do pane: dois `c` em sessões diferentes trocariam as respostas.
// A trava do pane é por sessão; o trecho "c → achar → apagar" tem trava própria, global.
static COPY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
// No tmux `-t` é flag desconhecida nos comandos de buffer; no psmux os buffers são da SESSÃO, e sem `-t`
// o comando fala com outra. Ausente = ainda não medido para esse multiplexador.
static BUFFER_TARGET: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Mutex::default);

/// O `isspace` do Python: o Rust não conta os separadores U+001C–U+001F.
fn py_space(c: char) -> bool { c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c) }
fn py_strip(s: &str) -> &str { s.trim_matches(py_space) }
/// `" ".join(pergunta.split())`.
pub fn normalize(question: &str) -> String { question.split(py_space).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ") }
/// As três últimas linhas, com as linhas vazias do fim fora (redesenho as deixa).
pub fn footer(screen: &str) -> String {
    let lines: Vec<&str> = screen.trim_end_matches('\n').split('\n').collect();
    lines[lines.len().saturating_sub(FOOTER_LINES)..].join("\n")
}

/// Plano B (multiplexador que não vira OSC 52 em buffer): o overlay como está na tela.
pub fn answer_from_pane(screen: &str) -> String {
    let lines: Vec<&str> = screen.trim_end_matches('\n').split('\n').collect();
    let start = lines.iter().rposition(|l| py_strip(l).starts_with("/btw "));
    let end = lines.iter().rposition(|l| l.contains(OPEN));
    let (Some(start), Some(end)) = (start, end) else { return String::new() };
    if end <= start { return String::new(); }
    let body: Vec<&str> = lines[start + 1..end].iter().map(|l| l.strip_prefix("      ").unwrap_or_else(|| py_strip(l))).collect();
    py_strip(&body.join("\n")).to_owned()
}

/// Captura que falha vale tela vazia, como no Python: quem chama decide pelo que (não) viu.
async fn screen(seq: &PermissionSequence<'_>) -> String {
    match seq.plain_screen().await {
        Ok(screen) => screen,
        Err(failure) => {
            if crate::warn_limit::allow(Some(seq.binding().name.as_str()), "btw_capture") {
                tracing::warn!(session=%seq.binding().name, code=failure.code, "btw: captura do pane falhou; lida como tela vazia");
            }
            String::new()
        }
    }
}

/// O composer sem glifo e sem espaço. `Some("")` = vazio, `None` = ilegível.
async fn composer(seq: &PermissionSequence<'_>) -> Option<String> {
    let typed = seq.typed_screen().await.ok()?;
    let snapshot = ComposerSnapshot::parse(&typed)?;
    Some(snapshot.content.chars().filter(|c| *c != '❯' && !py_space(*c)).collect())
}

/// Apaga o que estiver parado no composer. C-u apaga uma linha, então repete enquanto o conteúdo DIMINUI:
/// o que resiste ao C-u não é texto digitado, e a pergunta segue. Ilegível: não aperta nada.
async fn clear_composer(seq: &PermissionSequence<'_>, limits: &BtwLimits) {
    let Some(mut current) = composer(seq).await else { return };
    if current.is_empty() { return; }
    for _ in 0..CLEAR_MAX_KEYS {
        let _ = seq.key("C-u").await;
        let mut after = composer(seq).await;
        // Tela igual pode ser a leitura correndo na frente do redesenho: espera só nesse caso.
        if after.as_ref() == Some(&current) {
            tokio::time::sleep(limits.settle).await;
            after = composer(seq).await;
        }
        let Some(after) = after else { return };
        if after.is_empty() { return; }
        if after.chars().count() >= current.chars().count() {
            tracing::warn!(session=%seq.binding().name, left=after.chars().count(), "btw: o composer não esvaziou com C-u; a pergunta segue");
            return;
        }
        current = after;
    }
}

/// Às cegas: com a tela desalinhada a leitura não vê o resto, e o próximo envio sairia grudado nele.
async fn blind_clear(seq: &PermissionSequence<'_>) {
    for _ in 0..3 {
        if seq.key("C-u").await.is_err() {
            tracing::warn!(session=%seq.binding().name, "btw: o C-u da limpeza não chegou; pode ter sobrado texto no composer");
        }
    }
}

async fn close(seq: &PermissionSequence<'_>, limits: &BtwLimits) -> Result<(), BtwError> {
    if seq.key("Escape").await.is_err() {
        return Err(fail(502, "erro_btw_overlay_aberto", "não consegui fechar o /btw no terminal"));
    }
    let until = Instant::now() + limits.open;
    loop {
        tokio::time::sleep(limits.poll).await;
        let pane = screen(seq).await;
        if !py_strip(&pane).is_empty() && !footer(&pane).contains(OPEN) { return Ok(()); }
        // Sem repetir o Esc: o overlay pode já ter fechado, e a tecla interromperia o turno.
        if Instant::now() >= until { return Err(fail(502, "erro_btw_overlay_aberto", "não consegui confirmar o fechamento do /btw")); }
    }
}

/// `(sucesso, saída)` do comando de buffer. Só a recusa da FLAG desliga o `-t`, e para sempre no
/// processo: gravar "sem alvo" por outra falha (sessão que caiu) faria o psmux ler e apagar o buffer
/// da sessão padrão, de outra pessoa.
async fn buffer_cmd(seq: &PermissionSequence<'_>, sub: &str, args: &[&str]) -> (bool, String) {
    let mux = seq.binding().mux_argv.join("\u{0}");
    let run = |targeted: bool| async move {
        let mut argv = vec![sub.to_owned()];
        if targeted { argv.extend(["-t".to_owned(), format!("={}", seq.binding().name)]); }
        argv.extend(args.iter().map(|a| a.to_string()));
        match seq.mux(argv).await {
            Ok((output, stderr)) => (output.success, String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&stderr).into_owned()),
            Err(_) => (false, String::new(), String::new()),
        }
    };
    let known = BUFFER_TARGET.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&mux).copied();
    if known != Some(false) {
        let (ok, out, err) = run(true).await;
        if known == Some(true) || ok {
            BUFFER_TARGET.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(mux, true);
            return (ok, out);
        }
        if !err.contains("unknown flag") && !err.contains("unknown option") { return (ok, out); }
        BUFFER_TARGET.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(mux, false);
    }
    let (ok, out, _) = run(false).await;
    (ok, out)
}

async fn buffers(seq: &PermissionSequence<'_>) -> Vec<String> {
    buffer_cmd(seq, "list-buffers", &["-F", "#{buffer_name}"]).await.1.split('\n').filter(|b| !b.is_empty()).map(str::to_owned).collect()
}

async fn read_buffer(seq: &PermissionSequence<'_>, name: &str) -> String {
    // O psmux ignora o `-b` (vazio com sucesso); sem `-b` vem o mais recente, que é o do `c` — a trava
    // da cópia garante que ninguém copiou no meio.
    let (ok, text) = buffer_cmd(seq, "show-buffer", &["-b", name]).await;
    if !py_strip(&text).is_empty() { return text; }
    // Falha de verdade (buffer sumiu): no tmux o "mais recente" seria a cópia de outra pessoa.
    if !ok { return String::new(); }
    buffer_cmd(seq, "show-buffer", &[]).await.1
}

async fn delete_buffers(seq: &PermissionSequence<'_>, fresh: &[String], before: usize) {
    for name in fresh { buffer_cmd(seq, "delete-buffer", &["-b", name]).await; }
    // psmux (aceitou o `-t`): o `-b` não apagou nada e o OSC 52 vira duas cópias. No tmux o `-b` já
    // apagou, e apagar por contagem levaria a cópia manual de outra pessoa (buffers do servidor inteiro).
    if BUFFER_TARGET.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&seq.binding().mux_argv.join("\u{0}")).copied() != Some(true) { return; }
    for _ in 0..4 {
        if buffers(seq).await.len() <= before { break; }
        buffer_cmd(seq, "delete-buffer", &[]).await;
    }
}

/// Recusa da guarda inicial: painel de terminal aberto tem o código que o app explica.
fn guard_refusal(code: &str) -> BtwError {
    match code {
        "terminal_panel_active" | "terminal_panel_open" => fail(409, "erro_terminal_aberto", "Terminal aberto nesta sessão. Feche o painel pra perguntar por aqui."),
        _ => fail(503, code, "o terminal da sessão não respondeu"),
    }
}

/// Digita `/btw <pergunta>`, espera a resposta, copia pelo `c`, fecha o overlay e devolve
/// `{question, answer, fonte, ts}`. Um Enter só: um segundo, com o overlay aberto, seria tecla dentro dele.
pub async fn ask(driver: &TerminalDriver, question: &str, limits: &BtwLimits) -> Result<Value, BtwError> {
    let seq = driver.permission_sequence().await;
    seq.guard().await.map_err(|failure| guard_refusal(failure.code))?;
    let question = normalize(question);
    if question.is_empty() { return Err(fail(400, "erro_btw_vazia", "pergunta vazia")); }
    // Overlay de uma pergunta anterior ainda fechando: digitar agora perdia a `/`.
    let until = Instant::now() + limits.open;
    while footer(&screen(&seq).await).contains(OPEN) {
        // Preso aberto (um /btw feito à mão no terminal): digitar agora cairia dentro dele.
        if Instant::now() >= until {
            return Err(fail(409, "erro_btw_overlay_aberto", "há um /btw aberto no terminal da sessão; feche antes de perguntar"));
        }
        tokio::time::sleep(limits.poll).await;
    }
    // O rascunho é APAGADO, como no envio normal; quem protege a conversa de um "<resíduo>/btw …" é a
    // conferência do composer antes do Enter.
    clear_composer(&seq, limits).await;
    let command = format!("/btw {question}");
    let mut typed = String::new();
    let mut confirmed = false;
    for attempt in 0..2 {
        if seq.write(&command).await.is_err() {
            return Err(fail(502, "erro_btw_nao_digitou", "não consegui digitar o /btw no terminal da sessão"));
        }
        tokio::time::sleep(limits.settle).await;
        let mut read = composer(&seq).await;
        if read.is_none() {
            tokio::time::sleep(limits.settle).await;
            read = composer(&seq).await;
        }
        // Ilegível não confirma nada: com Enter às cegas a pergunta podia cair na conversa.
        let Some(read) = read else {
            tracing::warn!(session=%seq.binding().name, "btw: composer ilegível depois de digitar; parado sem Enter");
            blind_clear(&seq).await;
            return Err(fail(502, "erro_btw_composer_ilegivel", "não consegui conferir o /btw digitado; nada foi enviado pra conversa"));
        };
        if read.is_empty() || read.starts_with("/btw") { confirmed = true; break; }
        // No Windows a `/` inicial sumiu e o Enter submeteu "btw <pergunta>" como mensagem.
        tracing::warn!(session=%seq.binding().name, attempt=attempt + 1, "btw: o composer recebeu sem a barra; apagando");
        clear_composer(&seq, limits).await;
        typed = read;
    }
    if !confirmed {
        blind_clear(&seq).await;
        // A barra chegou: o que estragou a linha foi o que já estava no composer e não sai com C-u.
        if typed.contains("/btw") {
            return Err(fail(409, "erro_btw_composer_ocupado", "sobrou texto no composer do terminal que não sai com Ctrl-U; apague no terminal antes de perguntar"));
        }
        return Err(fail(502, "erro_btw_barra_perdida", "o terminal perdeu a / do /btw; nada foi enviado pra conversa"));
    }
    if seq.key("Enter").await.is_err() {
        blind_clear(&seq).await;
        return Err(fail(502, "erro_btw_enter_nao_enviado", "o Enter do /btw não chegou ao terminal; nada foi enviado pra conversa"));
    }
    let start = Instant::now();
    let mut open = false;
    loop {
        tokio::time::sleep(limits.poll).await;
        let footer = footer(&screen(&seq).await);
        if footer.contains(OPEN) {
            open = true;
            if footer.contains(READY) { break; }
        } else if open {
            // Fechado por fora (Esc no terminal, Parar do app): um Esc nosso cairia no turno principal.
            return Err(fail(409, "erro_btw_fechado", "o /btw foi fechado no terminal antes de eu ler a resposta"));
        }
        let elapsed = start.elapsed();
        if !open && elapsed > limits.open { return Err(fail(409, "erro_btw_nao_abriu", "o /btw não abriu no terminal da sessão")); }
        if elapsed > limits.answer {
            close(&seq, limits).await?;
            return Err(fail(504, "erro_btw_sem_resposta", "o /btw não respondeu a tempo"));
        }
    }
    let copied = {
        let _copy = COPY_LOCK.lock().await;
        let before = buffers(&seq).await;
        let _ = seq.key("c").await;
        let until = Instant::now() + limits.copy;
        let mut fresh = Vec::new();
        while Instant::now() < until {
            tokio::time::sleep(limits.poll).await;
            fresh = buffers(&seq).await.into_iter().filter(|b| !before.contains(b)).collect();
            if !fresh.is_empty() || footer(&screen(&seq).await).contains(COPIED) { break; }
        }
        let mut copied = String::new();
        if let Some(first) = fresh.first() {
            copied = read_buffer(&seq, first).await;
            delete_buffers(&seq, &fresh, before.len()).await;
        }
        copied
    };
    let (answer, source) = if !py_strip(&copied).is_empty() { (copied, "buffer") } else {
        tracing::warn!(session=%seq.binding().name, "btw: o buffer do OSC 52 não trouxe a resposta; resposta lida do pane");
        (answer_from_pane(&screen(&seq).await), "pane")
    };
    close(&seq, limits).await?;
    let answer = answer.trim_end_matches('\n');
    if answer.is_empty() { return Err(fail(502, "erro_btw_ilegivel", "o /btw respondeu, mas não consegui ler a resposta")); }
    Ok(json!({"question": question, "answer": answer, "fonte": source, "ts": now()}))
}

pub fn now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64()) }

#[cfg(test)]
mod contained_tests {
    /// Um panic no meio da pergunta chega ao ator como erro, nunca como resultado que falta.
    #[tokio::test]
    async fn a_panic_in_the_side_question_is_an_error_with_a_code() {
        let failed = super::contained(async { panic!("caiu") }).await.unwrap_err();
        assert_eq!((failed.status, failed.code.as_str()), (500, "erro_btw_tarefa_morreu"));
        assert_eq!(super::contained(async { Ok(serde_json::json!(1)) }).await.unwrap(), serde_json::json!(1));
    }
}
