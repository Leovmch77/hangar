//! Ferramentas do Hangar que a voz resolve pela mesma API dos apps: conversas fechadas, pastas, atalhos, máquinas e
//! interromper. Leitura e ação rodam numa tarefa; o laço só guarda a trava do sim.
use super::tools::{folder_name, folders, pick_machine};
use super::{Controller, Ctx, Done, Key, Want};
use crate::voice::call::CallId;
use crate::voice::machines::{HERE, Machines};
use crate::voice::organizer::{Assist, ConfirmGate, squash, tool_reply};
use crate::voice::rules::{SessionMatch, match_session};
use crate::voice::log;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::{Arc, Mutex}, time::Instant};

/// O teto da rota de recentes.
const RECENT_CAP: usize = 100;
/// Linhas que voltam ao organizador numa lista.
const LIST_LINES: usize = 15;
const FOLDER_LINES: usize = 80;

fn enc(text: &str) -> String { utf8_percent_encode(text, NON_ALPHANUMERIC).to_string() }

fn cut(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max { text } else { format!("{}…", text.chars().take(max).collect::<String>()) }
}

/// Uma conversa do arquivo (`ArchiveEntry` do backend).
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub(super) struct Closed {
    pub project: String,
    pub session_id: String,
    #[serde(default)] pub cwd: Option<String>,
    /// Nome que a sessão tinha ao fechar; conversa fechada antes do registro não tem.
    #[serde(default)] pub name: Option<String>,
    #[serde(default)] pub mtime: f64,
    #[serde(default)] pub preview: String,
    #[serde(default)] pub ultima: String,
    #[serde(default)] pub live: bool,
    #[serde(default)] pub provider: Option<String>,
    #[serde(default)] pub codex_account: Option<String>,
}

impl Closed {
    fn id(&self) -> String { format!("{}/{}", self.project, self.session_id) }
    fn folder(&self) -> &str { self.cwd.as_deref().map(folder_name).unwrap_or_default() }
    fn label(&self) -> &str { self.name.as_deref().filter(|n| !n.is_empty()).unwrap_or_else(|| self.folder()) }
    fn when(&self) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp(self.mtime as i64, 0)
            .map(|t| t.with_timezone(&chrono::Local).format("%d/%m %H:%M").to_string()).unwrap_or_default()
    }
    fn line(&self) -> String {
        let about = if self.ultima.trim().is_empty() { &self.preview } else { &self.ultima };
        format!("- {} (pasta {}, fechada {}, id {}): {}", self.label(), self.folder(), self.when(), self.id(), cut(about, 100))
    }
    /// Todas as palavras da busca (3+ letras) no nome, na pasta ou no assunto.
    fn matches(&self, query: &str) -> bool {
        let hay = squash(&format!("{} {} {} {}", self.name.as_deref().unwrap_or_default(), self.folder(), self.preview, self.ultima));
        let words: Vec<String> = query.split(|c: char| !c.is_alphanumeric()).map(squash).filter(|w| w.chars().count() > 2).collect();
        !words.is_empty() && words.iter().all(|w| hay.contains(w.as_str()))
    }
}

/// As fechadas da máquina, da mais nova; as vivas ficam de fora (estão na lista de sessões).
pub(super) async fn recent(machines: &Machines, machine: &str) -> Result<Vec<Closed>, String> {
    let value = machines.call(machine, reqwest::Method::GET, &format!("/api/archive/recent?cap={RECENT_CAP}"), None).await?;
    let list: Vec<Closed> = serde_json::from_value(value).map_err(|_| "Resposta inválida das conversas fechadas.".to_owned())?;
    Ok(list.into_iter().filter(|c| !c.live).collect())
}

/// Nome falado → conversa. O nome que a sessão tinha vence a pasta; o mesmo nome fechado várias vezes fica com a mais
/// nova. Ambíguo volta com as opções, nunca um palpite.
pub(super) fn pick_closed<'a>(list: &'a [Closed], spoken: &str) -> Result<&'a Closed, String> {
    let options = |found: &[usize]| format!("Mais de uma conversa fechada combina: {}. Pergunte qual e chame de novo com o id.",
        found.iter().take(5).map(|&i| list[i].line()).collect::<Vec<_>>().join(" "));
    let named: Vec<usize> = (0..list.len()).filter(|&i| list[i].name.as_deref().is_some_and(|n| !n.is_empty())).collect();
    let names: Vec<&str> = named.iter().map(|&i| list[i].label()).collect();
    match match_session(spoken, &names, &[]) {
        SessionMatch::One(at) => return Ok(&list[named[at]]),
        SessionMatch::Many(found) => {
            let same: HashSet<String> = found.iter().map(|&at| squash(names[at])).collect();
            // `list` vem da mais nova: o primeiro achado é o último fechamento com esse nome.
            if same.len() == 1 { return Ok(&list[named[found[0]]]); }
            return Err(options(&found.iter().map(|&at| named[at]).collect::<Vec<_>>()));
        }
        SessionMatch::None => {}
    }
    let folders: Vec<&str> = list.iter().map(Closed::folder).collect();
    match match_session(spoken, &folders, &[]) {
        SessionMatch::One(i) => Ok(&list[i]),
        SessionMatch::Many(found) => Err(options(&found)),
        SessionMatch::None => Err(NOT_CLOSED.into()),
    }
}

const NOT_CLOSED: &str = "Não achei conversa fechada com esse nome; chame recent_conversations para ver as fechadas.";

/// Um atalho com a identidade que os apps dão a ele (`global:<id>` ou `project:<repositório>:<id>`).
pub(super) struct Shortcut { pub item: Value, pub key: String, pub project: bool }

impl Shortcut {
    fn global(item: Value) -> Self { let key = format!("global:{}", item["id"].as_str().unwrap_or_default()); Self { item, key, project: false } }
    fn of_project(repo: &str, item: Value) -> Self {
        let key = format!("project:{repo}:{}", item["id"].as_str().unwrap_or_default());
        Self { item, key, project: true }
    }
    /// O app pergunta antes (`confirm`); o comando que o repositório define também pede o sim.
    pub fn needs_yes(&self) -> bool { self.item["confirm"] == true || (self.project && self.item["type"] == "shell") }
}

/// `project_unread`: a sessão tem projeto, mas os atalhos dele não vieram; a resposta diz isso em vez de "não achei".
pub(super) struct Shortcuts { pub items: Vec<Shortcut>, pub project_unread: bool }

const PROJECT_UNREAD: &str = "Os atalhos do projeto da sessão não puderam ser lidos agora.";

/// Atalhos da máquina: os globais (`/api/config`) e os do projeto da sessão `session`, quando há.
async fn shortcuts(machines: &Machines, machine: &str, session: Option<&str>) -> Result<Shortcuts, String> {
    let config = machines.call(machine, reqwest::Method::GET, "/api/config", None).await?;
    let raw = config.pointer("/campos/shortcuts/valor").and_then(Value::as_str).unwrap_or_default();
    let global: Vec<Value> = if raw.trim().is_empty() { Vec::new() }
        else { serde_json::from_str::<Vec<Value>>(raw).map_err(|_| "A lista de atalhos do servidor está ilegível.".to_owned())? };
    let mut found = Shortcuts { items: global.into_iter().map(Shortcut::global).collect(), project_unread: false };
    let Some(name) = session else { return Ok(found) };
    match machines.call(machine, reqwest::Method::GET, &format!("/api/sessions/{}/project-shortcuts", enc(name)), None).await {
        Ok(project) => match project["key"].as_str().filter(|k| !k.is_empty()) {
            Some(repo) => found.items.extend(project["items"].as_array().into_iter().flatten().map(|i| Shortcut::of_project(repo, i.clone()))),
            None => { log("shortcuts project answer without key"); found.project_unread = true; }
        },
        Err(_) => { log("shortcuts project unreadable"); found.project_unread = true; }
    }
    Ok(found)
}

/// Nome falado → atalho. Global aceita pedaço do nome; o do projeto (definido pelo repositório), só o nome inteiro.
pub(super) fn pick_shortcut(items: &[Shortcut], spoken: &str) -> SessionMatch {
    let global: Vec<usize> = (0..items.len()).filter(|&i| !items[i].project).collect();
    let labels: Vec<&str> = global.iter().map(|&i| shortcut_label(&items[i].item)).collect();
    let mut hits: Vec<usize> = match match_session(spoken, &labels, &[]) {
        SessionMatch::One(at) => vec![global[at]],
        SessionMatch::Many(found) => found.iter().map(|&at| global[at]).collect(),
        SessionMatch::None => Vec::new(),
    };
    let spoken = squash(spoken);
    hits.extend((0..items.len()).filter(|&i| items[i].project && !spoken.is_empty() && squash(shortcut_label(&items[i].item)) == spoken));
    match hits.as_slice() { [] => SessionMatch::None, [one] => SessionMatch::One(*one), _ => SessionMatch::Many(hits) }
}

fn shortcut_label(item: &Value) -> &str {
    item["label"].as_str().filter(|l| !l.trim().is_empty()).or_else(|| item["action"].as_str()).unwrap_or_default()
}

fn shortcut_line(item: &Value) -> String {
    let what = match item["type"].as_str() {
        Some("shell") if item["runs_in"] == "hangar" => format!("roda no Hangar: {}", cut(item["command"].as_str().unwrap_or_default(), 60)),
        Some("shell") => format!("roda na pasta da sessão: {}", cut(item["command"].as_str().unwrap_or_default(), 60)),
        Some("send_text") => format!("manda à sessão: {}", cut(item["text"].as_str().unwrap_or_default(), 60)),
        _ => "ação da tela".to_owned(),
    };
    format!("- {}: {what}", shortcut_label(item))
}

/// O mesmo corpo que o app manda ao clicar num atalho de comando.
pub(super) fn shell_body(shortcut: &Shortcut) -> Value {
    let item = &shortcut.item;
    let mut body = json!({"command": item["command"], "label": shortcut_label(item), "ask": item["answer_in_app"] != false,
        "key": shortcut.key});
    if let Some(pasta) = item["pasta"].as_str().map(str::trim).filter(|p| !p.is_empty()) { body["pasta"] = json!(pasta); }
    if item["runs_in"] == "hangar" { body["runs_in"] = json!("hangar"); body["home"] = json!(item["hangar_home"] != false); }
    body
}

impl Controller {
    pub(super) fn assist(&mut self, call: CallId, assist: Assist, turn: String) {
        log(format!("assist {}", match &assist {
            Assist::RecentConversations { .. } => "recent", Assist::ReopenConversation { .. } => "reopen", Assist::ListFolders { .. } => "folders",
            Assist::ListShortcuts { .. } => "shortcuts", Assist::RunShortcut { .. } => "run-shortcut", Assist::ListMachines => "machines",
            Assist::InterruptSession { .. } => "interrupt", Assist::HangarApi { .. } => "api",
        }));
        match assist {
            Assist::ListMachines => self.lookup(Want::Machines(call)),
            Assist::InterruptSession { name, confirmed } => self.lookup(Want::Interrupt { call, name, confirmed, turn }),
            Assist::RecentConversations { query, server } => { let ctx = self.ctx(); tokio::spawn(recent_conversations(ctx, call, query, server)); }
            Assist::ReopenConversation { name, id, server } => {
                // As abertas da máquina: nome que não está fechado mas está aberto vira troca de tela, não "não achei".
                let machine = pick_machine(&self.machines, server.as_deref()).unwrap_or_default();
                let open = self.rows.iter().filter(|(m, _)| *m == machine).map(|(_, r)| r.name.clone()).collect();
                let ctx = self.ctx();
                tokio::spawn(reopen(ctx, call, name, id, server, open));
            }
            Assist::ListFolders { server } => { let ctx = self.ctx(); tokio::spawn(list_folders(ctx, call, server)); }
            Assist::ListShortcuts { server } => {
                let (ctx, session) = (self.ctx(), self.session_on(server.as_deref()));
                tokio::spawn(list_shortcuts(ctx, call, server, session));
            }
            Assist::RunShortcut { name, server, confirmed } => {
                let (ctx, session) = (self.ctx(), self.session_on(server.as_deref()));
                // Atalho "No Hangar" só usa a sessão como endereço: sem a da conversa, qualquer uma da máquina serve.
                let machine = pick_machine(&self.machines, server.as_deref()).unwrap_or_default();
                let any = self.rows.iter().find(|(m, _)| *m == machine).map(|(_, r)| r.name.clone());
                let ask = RunAsk { spoken: name, server, session, any, confirmed, turn, gate: self.shortcut_gate.clone() };
                tokio::spawn(run_shortcut(ctx, call, ask));
            }
            Assist::HangarApi { method, path, body, server, confirmed } => self.hangar_api(call, ApiAsk { method, path, body, server, confirmed }, &turn),
        }
    }

    /// Qualquer rota `/api/` com o token do dono, que nunca sai daqui. A destrutiva pede o sim em duas chamadas, como fechar.
    fn hangar_api(&mut self, call: CallId, ask: ApiAsk, turn: &str) {
        let ApiAsk { method, path, body, server, confirmed } = ask;
        let method = match method.as_str() {
            "GET" => reqwest::Method::GET, "POST" => reqwest::Method::POST, "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH, "DELETE" => reqwest::Method::DELETE,
            _ => { self.voice.reply(call, tool_reply("method deve ser GET, POST, PUT, PATCH ou DELETE.", false)); return; }
        };
        if let Err(text) = api_path(&path) { log("hangar_api refused path"); self.voice.reply(call, tool_reply(text, false)); return; }
        let machine = match pick_machine(&self.machines, server.as_deref()) {
            Ok(machine) => machine,
            Err(text) => { self.voice.reply(call, tool_reply(text, false)); return; }
        };
        let destructive = api_destructive(&method, &path);
        if destructive {
            let target = format!("{machine} {method} {path} {}", body.as_ref().map(Value::to_string).unwrap_or_default());
            if !self.api_gate.check(target, confirmed, turn, Instant::now()) {
                log("hangar_api armed");
                self.voice.reply(call, tool_reply(format!("Nada foi feito. Confirme com o usuário, dizendo o que isso faz: {method} {path} em {}? \
                    Só depois de um sim explícito, chame hangar_api de novo com o mesmo pedido e confirmed true.", self.machines.label(&machine)), true));
                return;
            }
        }
        // Só o método no diário: a rota pode levar nome de sessão ou texto.
        log(format!("hangar_api {method} destructive={destructive}"));
        let ctx = self.ctx();
        tokio::spawn(async move {
            match ctx.machines.api(&machine, method, &path, body).await {
                Ok((status, value)) => {
                    log(format!("hangar_api status={status}"));
                    ctx.voice.reply(call, tool_reply(api_text(status, &value), (200..300).contains(&status)));
                }
                Err(text) => ctx.fail(call, "hangar_api", format!("A chamada não teve resposta: {text}")),
            }
        });
    }

    /// A sessão da conversa, se for da máquina falada (sem máquina, desta).
    fn session_on(&self, server: Option<&str>) -> Option<String> {
        let machine = pick_machine(&self.machines, server).ok()?;
        self.talk_key().filter(|(m, _)| *m == machine).map(|(_, n)| n)
    }

    /// Parar o que a sessão faz é destrutivo pelo pedido dele: duas chamadas (`ConfirmGate`), como fechar.
    pub(super) fn interrupt(&mut self, call: CallId, rows: &[(String, hangar_api::session::SessionRow)], unreachable: &[String], spoken: &str,
        confirmed: bool, turn: &str) {
        let i = match self.resolve("interrupt_session", rows, unreachable, spoken) {
            Ok(i) => i,
            Err(text) => { self.voice.reply(call, tool_reply(text, false)); return; }
        };
        let key: Key = (rows[i].0.clone(), rows[i].1.name.clone());
        if !self.interrupt_gate.check(key.clone(), confirmed, turn, Instant::now()) {
            log("interrupt_session armed");
            self.voice.reply(call, tool_reply(format!("Nada foi interrompido. Confirme com o usuário: interromper a sessão {} em {}? \
                Só depois de um sim explícito, chame interrupt_session de novo com confirmed true.", key.1, self.machines.label(&key.0)), true));
            return;
        }
        log("interrupt_session sent");
        let ctx = self.ctx();
        tokio::spawn(async move {
            let path = format!("/api/sessions/{}/interrupt?clear=false", enc(&key.1));
            match ctx.machines.call(&key.0, reqwest::Method::POST, &path, None).await {
                Ok(done) => {
                    let warning = done["warning"].as_str().filter(|w| !w.trim().is_empty());
                    log(format!("interrupt_session done warning={}", warning.is_some()));
                    let text = warning.map_or_else(|| format!("Sessão {} interrompida.", key.1),
                        |w| format!("Sessão {} interrompida, mas com aviso: {w}", key.1));
                    ctx.voice.reply(call, tool_reply(text, true));
                }
                Err(text) => ctx.fail(call, "interrupt_session", format!("Não consegui interromper a sessão {}: {text}", key.1)),
            }
        });
    }

    pub(super) fn list_machines(&mut self, call: CallId, rows: &[(String, hangar_api::session::SessionRow)], unreachable: &[String]) {
        let machines: Vec<String> = std::iter::once(HERE.to_owned()).chain(self.machines.peers.enabled_ids()).collect();
        let lines: Vec<String> = machines.iter().map(|m| {
            let label = self.machines.label(m);
            let here = if m == HERE { " (esta, onde a voz roda)" } else { "" };
            if unreachable.contains(&label) { return format!("- {label}{here}: sem resposta agora"); }
            format!("- {label}{here}: responde, {} sessão(ões) aberta(s)", rows.iter().filter(|(rm, _)| rm == m).count())
        }).collect();
        log(format!("list_machines count={} unreachable={}", lines.len(), unreachable.len()));
        self.voice.reply(call, tool_reply(lines.join("\n"), true));
    }
}

async fn recent_conversations(ctx: Ctx, call: CallId, query: Option<String>, server: Option<String>) {
    let machine = match pick_machine(&ctx.machines, server.as_deref()) { Ok(m) => m, Err(text) => { ctx.voice.reply(call, tool_reply(text, false)); return; } };
    let list = match recent(&ctx.machines, &machine).await {
        Ok(list) => list,
        Err(text) => { ctx.fail(call, "recent_conversations", format!("Não consegui ler as conversas fechadas: {text}")); return; }
    };
    let Some(query) = query else {
        log(format!("recent_conversations count={}", list.len()));
        let text = if list.is_empty() { "Nenhuma conversa fechada nesta máquina.".to_owned() }
            else { list.iter().take(LIST_LINES).map(Closed::line).collect::<Vec<_>>().join("\n") };
        ctx.voice.reply(call, tool_reply(text, true));
        return;
    };
    let hits: Vec<&Closed> = list.iter().filter(|c| c.matches(&query)).take(LIST_LINES).collect();
    if !hits.is_empty() {
        log(format!("recent_conversations matched={}", hits.len()));
        ctx.voice.reply(call, tool_reply(hits.iter().map(|c| c.line()).collect::<Vec<_>>().join("\n"), true));
        return;
    }
    // Nada no nome, na pasta nem no começo/fim: a busca no texto das conversas, a mesma do "Buscar conversas".
    let found = ctx.machines.call(&machine, reqwest::Method::GET, &format!("/api/search?q={}", enc(&query)), None).await;
    let hits = match found {
        Ok(Value::Array(hits)) => hits,
        Ok(_) => { ctx.fail(call, "recent_conversations", "A busca nas conversas respondeu num formato inesperado.".to_owned()); return; }
        Err(text) => { ctx.fail(call, "recent_conversations", format!("A busca nas conversas falhou: {text}")); return; }
    };
    let mut seen = HashSet::new();
    // Trecho sem id não dá para reabrir: fica de fora.
    let lines: Vec<String> = hits.iter().filter(|h| h["live"] != true)
        .filter(|h| h["session_id"].as_str().is_some_and(|id| !id.is_empty() && seen.insert(id.to_owned())))
        .take(LIST_LINES).map(|h| {
            let folder = folder_name(h["cwd"].as_str().unwrap_or_default());
            let id = format!("{}/{}", h["project"].as_str().unwrap_or_default(), h["session_id"].as_str().unwrap_or_default());
            let name = list.iter().find(|c| c.id() == id).map_or(folder, Closed::label);
            format!("- {name} (pasta {folder}, id {id}): {}", cut(h["line"].as_str().unwrap_or_default(), 100))
        }).collect();
    log(format!("recent_conversations searched={}", lines.len()));
    let text = if lines.is_empty() { format!("Nenhuma conversa fechada fala de '{query}'.") } else { lines.join("\n") };
    ctx.voice.reply(call, tool_reply(text, true));
}

/// `open`: as sessões abertas da máquina, da última lista lida.
async fn reopen(ctx: Ctx, call: CallId, name: Option<String>, id: Option<String>, server: Option<String>, open: Vec<String>) {
    let machine = match pick_machine(&ctx.machines, server.as_deref()) { Ok(m) => m, Err(text) => { ctx.voice.reply(call, tool_reply(text, false)); return; } };
    let list = match recent(&ctx.machines, &machine).await {
        Ok(list) => list,
        Err(text) => { ctx.fail(call, "reopen_conversation", format!("Não consegui ler as conversas fechadas: {text}")); return; }
    };
    let picked = match (&id, &name) {
        (Some(id), _) => match list.iter().find(|c| c.id() == *id || c.session_id == *id) {
            Some(found) => Ok(found.clone()),
            // Mais antiga que a lista de recentes (veio da busca): o id basta, a conta dona é achada pelo backend.
            None => match id.split_once('/') {
                Some((project, session)) => Ok(Closed { project: project.to_owned(), session_id: session.to_owned(), ..Closed::default() }),
                None => Err("Não achei conversa fechada com esse id; use o id que recent_conversations mostrou.".to_owned()),
            },
        },
        (None, Some(name)) => match pick_closed(&list, name) {
            Ok(found) => Ok(found.clone()),
            Err(text) if text == NOT_CLOSED => {
                let open: Vec<&str> = open.iter().map(String::as_str).collect();
                if let SessionMatch::One(i) = match_session(name, &open, &[]) {
                    // Já está aberta: reabrir criaria outra; vai para ela, como switch_session.
                    log("reopen_conversation already open");
                    if ctx.done.send(Done::Switch { call, name: open[i].to_owned() }).is_err() { log("reopen_conversation switch lost: loop gone"); }
                    return;
                }
                Err(text)
            }
            Err(text) => Err(text),
        },
        (None, None) => Err("Diga o nome ou o id da conversa.".to_owned()),
    };
    let closed = match picked { Ok(c) => c, Err(text) => { log("reopen_conversation unresolved"); ctx.voice.reply(call, tool_reply(text, false)); return; } };
    let mut body = json!({"provider": closed.provider.as_deref().unwrap_or("claude")});
    if let Some(account) = &closed.codex_account { body["codex_account"] = json!(account); }
    if let Some(old) = closed.name.as_deref().filter(|n| !n.is_empty()) { body["name"] = json!(old); }
    let path = format!("/api/archive/{}/{}/resume", enc(&closed.project), enc(&closed.session_id));
    match ctx.machines.call(&machine, reqwest::Method::POST, &path, Some(body)).await {
        Ok(info) => {
            let name = info["name"].as_str().filter(|n| !n.is_empty()).map_or_else(|| closed.label().to_owned(), str::to_owned);
            log("reopen_conversation resumed");
            if ctx.done.send(Done::Opened { call, machine, name, sent: None, reopened: true }).is_err() {
                log("reopen_conversation resumed but the loop is gone");
            }
        }
        Err(text) => ctx.fail(call, "reopen_conversation", format!("Não consegui reabrir a conversa {}: {text}", closed.label())),
    }
}

async fn list_folders(ctx: Ctx, call: CallId, server: Option<String>) {
    let machine = match pick_machine(&ctx.machines, server.as_deref()) { Ok(m) => m, Err(text) => { ctx.voice.reply(call, tool_reply(text, false)); return; } };
    match folders(&ctx.machines, &machine).await {
        Ok((list, unread)) => {
            let mut seen = HashSet::new();
            let mut lines: Vec<String> = list.iter().filter(|(_, path)| seen.insert(path.clone())).take(FOLDER_LINES)
                .map(|(name, path)| format!("- {name}: {path}")).collect();
            if lines.is_empty() { lines.push("Nenhuma pasta configurada para abrir sessão.".into()); }
            if unread > 0 { lines.push(format!("{unread} raiz(es) não puderam ser lidas.")); }
            log(format!("list_folders count={} unread={unread}", seen.len()));
            ctx.voice.reply(call, tool_reply(lines.join("\n"), true));
        }
        Err(text) => ctx.fail(call, "list_folders", format!("Não consegui ler as pastas: {text}")),
    }
}

async fn list_shortcuts(ctx: Ctx, call: CallId, server: Option<String>, session: Option<String>) {
    let machine = match pick_machine(&ctx.machines, server.as_deref()) { Ok(m) => m, Err(text) => { ctx.voice.reply(call, tool_reply(text, false)); return; } };
    match shortcuts(&ctx.machines, &machine, session.as_deref()).await {
        Ok(found) => {
            log(format!("list_shortcuts count={} project_unread={}", found.items.len(), found.project_unread));
            let mut lines: Vec<String> = found.items.iter().map(|s| shortcut_line(&s.item)).collect();
            if lines.is_empty() && !found.project_unread { lines.push("Nenhum atalho configurado além dos da tela.".to_owned()); }
            if found.project_unread { lines.push(PROJECT_UNREAD.to_owned()); }
            ctx.voice.reply(call, tool_reply(lines.join("\n"), true));
        }
        Err(text) => ctx.fail(call, "list_shortcuts", format!("Não consegui ler os atalhos: {text}")),
    }
}

/// O que `hangar_api` leva da chamada.
pub(super) struct ApiAsk { pub method: String, pub path: String, pub body: Option<Value>, pub server: Option<String>, pub confirmed: bool }

/// Teto, em caracteres, da resposta da API que volta ao organizador.
const API_CAP: usize = 30_000;

/// Só rotas `/api/`, sem segmento `.`/`..` (nem codificado) nem barra invertida: a URL normaliza e sairia de `/api/`.
pub(super) fn api_path(path: &str) -> Result<(), String> {
    let route = path.split(['?', '#']).next().unwrap_or_default();
    let escapes = route.to_lowercase().contains("%2e") || route.split('/').any(|s| s == "." || s == "..")
        || path.contains('\\') || path.to_lowercase().contains("%5c");
    if !path.starts_with("/api/") || escapes || path.chars().any(char::is_whitespace) {
        return Err("Só rotas que começam por /api/ (ex.: /api/sessions), sem espaço, barra invertida nem . ou .. no caminho; nada foi chamado.".into());
    }
    Ok(())
}

/// DELETE, e a ação no fim da rota que fecha, mata, apaga, descarta, para, interrompe, publica, reinicia, reverte ou desloga.
pub(super) fn api_destructive(method: &reqwest::Method, path: &str) -> bool {
    if *method == reqwest::Method::DELETE { return true; }
    if *method == reqwest::Method::GET { return false; }
    let last = path.split(['?', '#']).next().unwrap_or_default().trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_lowercase();
    ["close", "kill", "delete", "remove", "discard", "reset", "stop", "interrupt", "push", "restart", "reiniciar",
        "revert", "logout"].iter()
        .any(|w| last == *w || last.starts_with(&format!("{w}-")))
}

/// Status e corpo; o corpo longo é cortado e a resposta diz que foi.
pub(super) fn api_text(status: u16, value: &Value) -> String {
    let body = value.to_string();
    let total = body.chars().count();
    if total <= API_CAP { return format!("HTTP {status}\n{body}"); }
    format!("HTTP {status} (resposta cortada: {API_CAP} de {total} caracteres; peça menos, com filtro ou limit)\n{}",
        body.chars().take(API_CAP).collect::<String>())
}

/// O que `run_shortcut` leva da chamada: a sessão da conversa nesta máquina (`session`), qualquer sessão dela (`any`,
/// endereço do atalho "No Hangar") e a trava do sim.
pub(super) struct RunAsk { pub spoken: String, pub server: Option<String>, pub session: Option<String>, pub any: Option<String>,
    pub confirmed: bool, pub turn: String, pub gate: Arc<Mutex<ConfirmGate<Key>>> }

async fn run_shortcut(ctx: Ctx, call: CallId, ask: RunAsk) {
    let RunAsk { spoken, server, session, any, confirmed, turn, gate } = ask;
    let machine = match pick_machine(&ctx.machines, server.as_deref()) { Ok(m) => m, Err(text) => { ctx.voice.reply(call, tool_reply(text, false)); return; } };
    let found = match shortcuts(&ctx.machines, &machine, session.as_deref()).await {
        Ok(found) => found,
        Err(text) => { ctx.fail(call, "run_shortcut", format!("Não consegui ler os atalhos: {text}")); return; }
    };
    let items = &found.items;
    let labels: Vec<&str> = items.iter().map(|s| shortcut_label(&s.item)).collect();
    let shortcut = match pick_shortcut(items, &spoken) {
        SessionMatch::One(i) => &items[i],
        SessionMatch::Many(hits) => {
            let names: Vec<&str> = hits.iter().take(5).map(|&i| labels[i]).collect();
            ctx.voice.reply(call, tool_reply(format!("Mais de um atalho combina: {}. Pergunte qual.", names.join(", ")), false));
            return;
        }
        SessionMatch::None => {
            let unread = if found.project_unread { format!(" {PROJECT_UNREAD}") } else { String::new() };
            ctx.voice.reply(call, tool_reply(format!("Não achei atalho com esse nome. Atalhos: {}.{unread}", labels.join(", ")), false));
            return;
        }
    };
    let item = &shortcut.item;
    let label = shortcut_label(item).to_owned();
    match item["type"].as_str() {
        Some("shell") => {
            let hangar = item["runs_in"] == "hangar";
            let Some(owner) = session.clone().or(if hangar { any } else { None }) else {
                ctx.voice.reply(call, tool_reply(format!("O atalho {label} roda na pasta de uma sessão; não há sessão desta máquina na conversa."), false));
                return;
            };
            let target = (machine.clone(), shortcut.key.clone());
            let open = !shortcut.needs_yes() || {
                let mut gate = gate.lock().unwrap_or_else(|e| e.into_inner());
                gate.check(target, confirmed, &turn, Instant::now())
            };
            if !open {
                log(format!("run_shortcut armed project={}", shortcut.project));
                let from = if shortcut.project { " (definido pelo repositório)" } else { "" };
                ctx.voice.reply(call, tool_reply(format!("Nada rodou. Confirme com o usuário: rodar o atalho {label}{from}, que executa '{}'? \
                    Só depois de um sim explícito, chame run_shortcut de novo com confirmed true.", cut(item["command"].as_str().unwrap_or_default(), 80)), true));
                return;
            }
            let path = format!("/api/sessions/{}/shortcut-shell", enc(&owner));
            match ctx.machines.call(&machine, reqwest::Method::POST, &path, Some(shell_body(shortcut))).await {
                Ok(done) => {
                    log(format!("run_shortcut shell reused={}", done["reused"] == true));
                    let text = if done["reused"] == true { format!("O atalho {label} já estava aberto; foi trazido para a frente.") }
                        else { format!("Atalho {label} rodando no terminal do atalho.") };
                    ctx.voice.reply(call, tool_reply(text, true));
                }
                Err(text) => ctx.fail(call, "run_shortcut", format!("O atalho {label} falhou: {text}")),
            }
        }
        // Não manda daqui: o envio passa por send_to_session, que respeita o modo Planejar e as travas do envio.
        Some("send_text") => {
            log("run_shortcut send_text handed back");
            let ask = if shortcut.needs_yes() { " Este atalho pede confirmação no app: pergunte ao usuário antes de mandar." } else { "" };
            ctx.voice.reply(call, tool_reply(format!("O atalho {label} é um texto para a sessão; nada foi mandado. Para usá-lo, chame \
                send_to_session com exatamente este texto: {}{ask}", item["text"].as_str().unwrap_or_default()), true));
        }
        _ => ctx.voice.reply(call, tool_reply(format!("O atalho {label} é uma ação da tela: use hangar_action."), false)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closed(name: Option<&str>, cwd: &str, id: &str) -> Closed {
        Closed { project: "-p".into(), session_id: id.into(), cwd: Some(cwd.into()), name: name.map(str::to_owned), ..Closed::default() }
    }

    #[test]
    fn api_only_under_api_and_destructive_by_method_or_action() {
        assert!(api_path("/api/sessions").is_ok() && api_path("/api/search?q=a b").is_err(), "espaço na rota");
        for bad in ["/mcp/", "api/sessions", "/api/../mcp/", "/api/%2E%2E/internal", "http://x/api/sessions", "/api/..\\mcp/",
            "/api/x\\y", "/api/%5c..%5cmcp", "/api/%5C..", "/api/x?q=a%5Cb"] { assert!(api_path(bad).is_err(), "{bad}"); }
        let (get, post, delete) = (reqwest::Method::GET, reqwest::Method::POST, reqwest::Method::DELETE);
        assert!(api_destructive(&delete, "/api/sessions/web"));
        for path in ["/api/worktrees/delete", "/api/worktrees/delete-merged", "/api/hangar-terminals/t1/close", "/api/sessions/x/git/push",
            "/api/sessions/x/interrupt?clear=false", "/api/atualizacao/reiniciar", "/api/x/restart", "/api/x/git/revert", "/api/auth/logout"] {
            assert!(api_destructive(&post, path), "{path}");
        }
        assert!(!api_destructive(&post, "/api/sessions/close-x/input"), "só a ação no fim conta, não o nome da sessão");
        assert!(!api_destructive(&get, "/api/worktrees/delete") && !api_destructive(&post, "/api/archive/p/i/resume"));
    }

    #[test]
    fn api_text_cuts_long_bodies_and_says_so() {
        assert_eq!(api_text(200, &json!({"ok": true})), "HTTP 200\n{\"ok\":true}");
        let long = api_text(200, &json!("x".repeat(40_000)));
        assert!(long.starts_with("HTTP 200 (resposta cortada: 30000 de 40002 caracteres"), "{}", &long[..80]);
        assert!(long.chars().count() < 30_200);
    }

    #[test]
    fn closed_name_beats_folder_and_newest_wins_on_repeat() {
        let list = [closed(Some("auditoria-migracao"), "/p/hangar", "a"), closed(None, "/p/auditoria", "b"),
            closed(Some("auditoria-migracao"), "/p/hangar", "c")];
        assert_eq!(pick_closed(&list, "auditoria migracao").unwrap().session_id, "a", "o nome vence; a mais nova primeiro");
        assert_eq!(pick_closed(&list, "auditoria").unwrap().session_id, "a", "pedaço do nome, mesmo nome fechado duas vezes");
        let two = [closed(Some("voz-a"), "/p/x", "a"), closed(Some("voz-b"), "/p/y", "b")];
        let why = pick_closed(&two, "voz").unwrap_err();
        assert!(why.contains("voz-a") && why.contains("id -p/b"), "{why}");
        assert_eq!(pick_closed(&[closed(None, "/p/loja", "z")], "loja").unwrap().session_id, "z", "sem nome, a pasta");
        assert!(pick_closed(&two, "nada").unwrap_err().contains("recent_conversations"));
    }

    #[test]
    fn shell_shortcut_body_copies_what_the_app_sends() {
        let vm = Shortcut::global(json!({"id": "vm", "type": "shell", "label": "VM", "command": "xfreerdp /v:x", "runs_in": "hangar", "answer_in_app": false}));
        assert_eq!(shell_body(&vm), json!({"command": "xfreerdp /v:x", "label": "VM", "ask": false, "key": "global:vm", "runs_in": "hangar", "home": true}));
        let local = Shortcut::of_project("/repo", json!({"id": "t", "type": "shell", "label": "Testes", "command": "make test", "pasta": " backend "}));
        assert_eq!(shell_body(&local), json!({"command": "make test", "label": "Testes", "ask": true, "key": "project:/repo:t", "pasta": "backend"}),
            "a mesma chave do desktop-native (`hangar_live::shortcut_key`) e do core (`shortcuts.ts`)");
    }

    #[test]
    fn project_shortcut_needs_the_exact_name_and_the_yes() {
        let items = [Shortcut::global(json!({"id": "a", "type": "shell", "label": "Deploy VPS", "command": "x"})),
            Shortcut::of_project("/r", json!({"id": "b", "type": "shell", "label": "Deploy", "command": "y"})),
            Shortcut::global(json!({"id": "c", "type": "send_text", "label": "Continuar", "text": "ok", "confirm": true}))];
        assert_eq!(pick_shortcut(&items, "vps"), SessionMatch::One(0), "global aceita pedaço do nome");
        assert_eq!(pick_shortcut(&items, "Deplo"), SessionMatch::One(0), "o do projeto não casa por pedaço");
        assert_eq!(pick_shortcut(&items, "deploy"), SessionMatch::Many(vec![0, 1]), "nome inteiro: o do projeto entra");
        assert!(!items[0].needs_yes() && items[1].needs_yes() && items[2].needs_yes(), "comando do repositório e confirm pedem o sim");
    }
}
