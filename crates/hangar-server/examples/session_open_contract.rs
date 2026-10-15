//! Lado Rust do harness de contrato da abertura (`backend/tests/fixtures/contract/session_open_contract.py
//! diff --side rust`). O ambiente do processo é o do cenário (`base_env`), montado pelo harness.
//!
//!   session_open_contract prepare <cenário.json> <raiz> <repo>
//!   session_open_contract run <cenário.json> <raiz> <repo> <saída.json>
#[cfg(unix)]
fn main() -> std::process::ExitCode {
    use hangar_server::session_open::contract;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let read = |path: &str| serde_json::from_slice::<serde_json::Value>(&std::fs::read(path).expect("cenário")).expect("cenário JSON");
    match args.as_slice() {
        [command, scenario, root, repo] if command == "prepare" => {
            contract::prepare(&read(scenario), std::path::Path::new(root), std::path::Path::new(repo)).expect("preparo do cenário");
        }
        [command, scenario, root, _repo, out] if command == "run" => {
            let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
            let env = std::env::vars().collect();
            let raw = runtime.block_on(contract::run(&read(scenario), std::path::Path::new(root), env));
            std::fs::write(out, serde_json::to_vec(&raw).expect("saída")).expect("saída gravada");
        }
        _ => {
            eprintln!("uso: session_open_contract prepare|run <cenário.json> <raiz> <repo> [<saída.json>]");
            return std::process::ExitCode::from(2);
        }
    }
    std::process::ExitCode::SUCCESS
}

#[cfg(not(unix))]
fn main() {}
