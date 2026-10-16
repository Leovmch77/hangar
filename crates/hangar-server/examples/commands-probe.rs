//! Medição isolada do catálogo e prova do initialize com o Claude instalado.
use hangar_server::{
    accounts::{AccountService, environment::AccountEnvironment},
    commands::{Catalog, cache::Probe, probe::NativeProbe},
};
use serde_json::json;
use std::time::Instant;

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--native") {
        let account = tempfile::tempdir().unwrap();
        std::fs::write(
            account.path().join("settings.json"),
            r#"{"disableAllHooks":true}"#,
        )
        .unwrap();
        let probe = NativeProbe {
            accounts: AccountService::new(AccountEnvironment::capture()),
        };
        let started = Instant::now();
        match probe.run(Some(account.path())).await {
            Ok(commands) => println!(
                "{}",
                json!({"count":commands.len(),"reload_plugins":commands.iter().any(|c| c["name"] == "reload-plugins"),"elapsed_ms":started.elapsed().as_secs_f64()*1000.0})
            ),
            Err(code) => {
                eprintln!("A sondagem do CLI falhou: {code}");
                std::process::exit(1);
            }
        }
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".claude/commands");
    std::fs::create_dir_all(&directory).unwrap();
    for number in 0..200 {
        std::fs::write(
            directory.join(format!("command-{number:03}.md")),
            "---\ndescription: Ação de caracterização\nargument-hint: <alvo>\n---\n",
        )
        .unwrap();
    }
    let mut catalog = Catalog::default();
    let started = Instant::now();
    let count = catalog.compose(home.path(), None, None, &[], true).len();
    let cold = started.elapsed().as_secs_f64() * 1000.0;
    let mut times = Vec::new();
    for _ in 0..50 {
        let started = Instant::now();
        catalog.compose(home.path(), None, None, &[], true);
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    let pid = sysinfo::get_current_pid().unwrap();
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_memory()
            .with_cpu(),
    );
    let process = system.process(pid).unwrap();
    println!(
        "{}",
        json!({"commands":count,"cold_ms":cold,"p50_ms":(times[24]+times[25])/2.0,"p95_ms":times[47],"process_cpu_ms":process.accumulated_cpu_time(),"rss_kib":process.memory()/1024})
    );
}
