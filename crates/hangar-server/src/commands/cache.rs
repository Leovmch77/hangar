//! Cache persistente e sondagem compartilhada por conta e versão do CLI.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;

pub type ProbeResult = Result<Vec<Value>, &'static str>;

pub trait Probe: Send + Sync {
    fn signature(&self, config_dir: Option<&Path>) -> Result<String, &'static str>;
    fn run<'a>(
        &'a self,
        config_dir: Option<&'a Path>,
    ) -> Pin<Box<dyn Future<Output = ProbeResult> + Send + 'a>>;
}

type Key = (PathBuf, String);
pub struct Cache {
    path: PathBuf,
    attempts: Mutex<HashMap<Key, Option<Instant>>>,
    writer: Mutex<()>,
}

pub fn valid_commands(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c.is_object() && c.get("name").is_some_and(Value::is_string))
        .cloned()
        .collect()
}

fn read(path: &Path) -> Value {
    match crate::runtime::queue::read_replaced(path) {
        Ok(raw) => match serde_json::from_slice::<Value>(&raw) {
            Ok(value) if value.is_object() => value,
            _ => {
                tracing::warn!(
                    code = "claude_commands_cache_invalid",
                    "cache de comandos inválido; a CLI será sondada novamente"
                );
                json!({})
            }
        },
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(code = "claude_commands_cache_unreadable", io_kind = ?error.kind(), "cache de comandos ilegível");
            }
            json!({})
        }
    }
}

impl Cache {
    pub fn new(home: &Path) -> Self {
        Self {
            path: home.join(".hangar/claude-slash-commands.json"),
            attempts: Mutex::default(),
            writer: Mutex::default(),
        }
    }

    pub async fn get(
        self: &Arc<Self>,
        probe: Arc<dyn Probe>,
        config_dir: Option<PathBuf>,
    ) -> Option<Vec<Value>> {
        let cache = self.clone();
        let runtime = tokio::runtime::Handle::current();
        match tokio::task::spawn_blocking(move || cache.load_or_probe(probe, config_dir, runtime))
            .await
        {
            Ok(Ok(result)) => result,
            _ => {
                tracing::warn!(
                    code = "claude_commands_cli_unavailable",
                    "CLI de comandos não encontrada ou ilegível; usando o catálogo de reserva"
                );
                None
            }
        }
    }

    fn load_or_probe(
        self: &Arc<Self>,
        probe: Arc<dyn Probe>,
        config_dir: Option<PathBuf>,
        runtime: tokio::runtime::Handle,
    ) -> Result<Option<Vec<Value>>, &'static str> {
        let signature = probe.signature(config_dir.as_deref())?;
        // Uma leitura anterior à gravação não pode registrar outra sonda depois dela.
        let _writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let cache = read(&self.path);
        let account = config_dir
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let entry = &cache[&account];
        let commands = valid_commands(&entry["comandos"]);
        if entry["assinatura"].as_str() == Some(&signature) && !commands.is_empty() {
            return Ok(Some(commands));
        }
        let key = (config_dir.clone().unwrap_or_default(), signature);
        {
            let mut attempts = self.attempts.lock().unwrap_or_else(|e| e.into_inner());
            if attempts.get(&key).is_some_and(|failed| {
                failed.is_none_or(|at| at.elapsed() < Duration::from_secs(600))
            }) {
                return Ok(None);
            }
            attempts.insert(key.clone(), None);
        }
        self.start_probe(probe, config_dir, key, runtime);
        Ok(None)
    }

    fn start_probe(
        self: &Arc<Self>,
        probe: Arc<dyn Probe>,
        config_dir: Option<PathBuf>,
        key: Key,
        runtime: tokio::runtime::Handle,
    ) {
        let cache = self.clone();
        runtime.spawn(async move {
            let started = Instant::now();
            let mut attempt = Attempt {
                cache: cache.clone(),
                key: key.clone(),
                completed: false,
            };
            let result = match probe.run(config_dir.as_deref()).await {
                Ok(commands) if !commands.is_empty() => {
                    let count = commands.len();
                    let writing = cache.clone();
                    let signature = key.1.clone();
                    let stored = tokio::task::spawn_blocking(move || {
                        writing.store(config_dir.as_deref(), &signature, commands)
                    })
                    .await;
                    match stored {
                        Ok(Ok(())) => {
                            tracing::info!(
                                code = "claude_commands_probe_ready",
                                count,
                                elapsed_ms = started.elapsed().as_millis() as u64,
                                "catálogo de comandos atualizado"
                            );
                            Ok(())
                        }
                        _ => Err("claude_commands_cache_write_failed"),
                    }
                }
                Ok(_) => Err("claude_commands_probe_empty"),
                Err(code) => Err(code),
            };
            let mut attempts = cache.attempts.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(code) = result {
                attempts.insert(key, Some(Instant::now()));
                tracing::warn!(
                    code,
                    "sondagem do catálogo falhou; usando a lista de reserva"
                );
            } else {
                attempts.remove(&key);
            }
            attempt.completed = true;
        });
    }

    fn store(
        &self,
        config_dir: Option<&Path>,
        signature: &str,
        commands: Vec<Value>,
    ) -> std::io::Result<()> {
        let _writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let mut cache = read(&self.path);
        let key = config_dir
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        cache[&key] = json!({"assinatura":signature,"comandos":commands,"em":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()});
        std::fs::create_dir_all(self.path.parent().unwrap())?;
        crate::runtime::queue::atomic_write(&self.path, &serde_json::to_vec(&cache)?)
    }
}

struct Attempt {
    cache: Arc<Cache>,
    key: Key,
    completed: bool,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.completed {
            self.cache
                .attempts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(self.key.clone(), Some(Instant::now()));
            tracing::warn!(
                code = "claude_commands_probe_interrupted",
                "sondagem interrompida antes de publicar o catálogo"
            );
        }
    }
}
