//! `hangar-open`: o lançador do Hangar como comando de terminal (D-013). O mesmo `resolve_open()`
//! do servidor, lendo os mesmos arquivos, para o terminal abrir igual com o servidor fora do ar.
//!
//!   hangar-open resolve [PEDIDO]  resolve nesta máquina e imprime o spec, sem efeito nenhum
//!   hangar-open open [PEDIDO]     pede ao servidor (`HANGAR_URL`, token `CP_AUTH_TOKEN`); fora do
//!                                 ar, resolve aqui, imprime e sai 3 (abrir sem ele: Task 4)
//!
//! PEDIDO é o JSON do `POST /api/sessions`; omitido, vem da entrada padrão. Recusa sai em stderr
//! no envelope `{"detail": …}` com código 1; uso errado, 2.
use std::io::Read;
use std::process::ExitCode;

use hangar_server::session_open::{OpenError, SessionOpenRequest, facts::LocalFacts, resolve_open};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (command, body) = match args.as_slice() {
        [command] => (command.as_str(), None),
        [command, body] => (command.as_str(), Some(body.clone())),
        _ => return usage(),
    };
    if !matches!(command, "resolve" | "open") {
        return usage();
    }
    let body = match body {
        Some(body) => body.into_bytes(),
        None => {
            let mut bytes = Vec::new();
            if let Err(error) = std::io::stdin().read_to_end(&mut bytes) {
                eprintln!("hangar-open: entrada ilegível: {error}");
                return ExitCode::from(2);
            }
            bytes
        }
    };
    let request = match SessionOpenRequest::parse(&body) {
        Ok(request) => request,
        Err(error) => return refused(&error),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("hangar-open: runtime: {error}");
            return ExitCode::from(2);
        }
    };
    if command == "open" {
        match runtime.block_on(ask_server(&body)) {
            Ask::Answered(status, text) => {
                println!("{text}");
                return if (200..300).contains(&status) { ExitCode::SUCCESS } else { ExitCode::from(1) };
            }
            // Sem resposta a sessão pode estar nascendo lá: resolver aqui abriria uma segunda.
            Ask::Uncertain(reason) => {
                eprintln!("hangar-open: o servidor não respondeu ({reason}); confira a lista antes de tentar de novo");
                return ExitCode::from(1);
            }
            Ask::Down(reason) => eprintln!("hangar-open: servidor fora do ar ({reason}); resolvido nesta máquina, sem abrir"),
        }
    }
    let facts = LocalFacts::new(hangar_server::accounts::environment::AccountEnvironment::capture(), runtime.handle().clone());
    match resolve_open(&request, &facts) {
        Ok(resolved) => {
            println!("{}", serde_json::to_string_pretty(&resolved).unwrap_or_default());
            if command == "open" { ExitCode::from(3) } else { ExitCode::SUCCESS }
        }
        Err(error) => refused(&error),
    }
}

enum Ask { Answered(u16, String), Down(String), Uncertain(String) }

async fn ask_server(body: &[u8]) -> Ask {
    let base = std::env::var("HANGAR_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".into());
    let Ok(token) = std::env::var("CP_AUTH_TOKEN") else { return Ask::Uncertain("sem CP_AUTH_TOKEN".into()) };
    // O mesmo prazo das telas: a criação pode preparar conta e worktree.
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build() {
        Ok(client) => client,
        Err(error) => return Ask::Uncertain(error.to_string()),
    };
    let sent = client.post(format!("{}/api/sessions", base.trim_end_matches('/'))).bearer_auth(token)
        .header("content-type", "application/json").body(body.to_vec()).send().await;
    match sent {
        Ok(response) => {
            let status = response.status().as_u16();
            match response.text().await {
                Ok(text) => Ask::Answered(status, text),
                Err(error) => Ask::Uncertain(error.to_string()),
            }
        }
        Err(error) if error.is_connect() => Ask::Down(error.to_string()),
        Err(error) => Ask::Uncertain(error.to_string()),
    }
}

fn refused(error: &OpenError) -> ExitCode {
    eprintln!("{}", error.body());
    ExitCode::from(1)
}

fn usage() -> ExitCode {
    eprintln!("uso: hangar-open resolve|open [PEDIDO-JSON]");
    ExitCode::from(2)
}
