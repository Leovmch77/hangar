//! Diagramas já desenhados em `~/.hangar/mermaid/`: `<chave>.png` ou `<chave>.err` (mensagem do parser).
//! O tamanho CSS sai do próprio PNG (escala 2): um arquivo por entrada, sem par para desencontrar.
//! Também os que estão sendo desenhados: um voo por chave, que os pedidos iguais esperam juntos.
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::sync::OnceCell;

use crate::pages::Theme;

pub const KEEP: usize = 256;
/// Temporário mais velho que isto é sobra de um processo que caiu no meio da gravação.
const STALE_TMP: Duration = Duration::from_secs(3600);

#[derive(Clone)]
pub enum Entry { Png { png: Vec<u8>, width: u32, height: u32 }, Invalid(String) }

/// O que um voo entrega a quem esperou: a entrada ou o motivo do 503, que não fica no disco.
pub type Outcome = Result<Entry, &'static str>;

type Flight = Arc<OnceCell<Outcome>>;

pub struct Cache {
    root: PathBuf,
    flights: Mutex<HashMap<String, Flight>>,
    /// A pasta já foi criada e fechada (0700) por este processo; volta a `false` se ela sumir.
    ready: AtomicBool,
    /// Entradas no disco, contadas na última poda e somadas a cada gravação: a pasta só é varrida quando
    /// a conta passa do teto. Gravar por cima conta a mais, o que só antecipa a poda. `None` = não contada.
    entries: Mutex<Option<usize>>,
}

/// `sha256(versão \0 tema \0 largura \0 fonte)` em hexadecimal.
pub fn key(version: &str, theme: Theme, width: u32, source: &str) -> String {
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    for part in [version, theme.as_str(), &width.to_string()] {
        hash.update(part.as_bytes());
        hash.update(b"\0");
    }
    hash.update(source.as_bytes());
    hash.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Tamanho CSS de um PNG em escala 2; `None` quando não é PNG ou a medida não é par.
pub fn css_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" { return None; }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    (w > 0 && h > 0 && w % 2 == 0 && h % 2 == 0).then_some((w / 2, h / 2))
}

impl Cache {
    pub fn new(root: PathBuf) -> Cache { Cache { root, flights: Mutex::default(), ready: AtomicBool::new(false), entries: Mutex::new(None) } }

    pub fn default_root() -> PathBuf {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
        home.join(".hangar").join("mermaid")
    }

    fn path(&self, key: &str, ext: &str) -> PathBuf { self.root.join(format!("{key}.{ext}")) }

    /// `Ok(None)` só quando não há entrada; PNG que não se mede conta como ausente e é desenhado de novo.
    pub fn get(&self, key: &str) -> io::Result<Option<Entry>> {
        if let Some(png) = absent_is_none(std::fs::read(self.path(key, "png")))? {
            touch(&self.path(key, "png"));
            return Ok(css_size(&png).map(|(width, height)| Entry::Png { png, width, height }));
        }
        let Some(message) = absent_is_none(std::fs::read_to_string(self.path(key, "err")))? else { return Ok(None) };
        touch(&self.path(key, "err"));
        Ok(Some(Entry::Invalid(message)))
    }

    pub fn put(&self, key: &str, entry: &Entry) -> io::Result<()> {
        if !self.ready.load(Ordering::Acquire) {
            std::fs::create_dir_all(&self.root)?;
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?; }
            self.ready.store(true, Ordering::Release);
        }
        let written = match entry {
            Entry::Png { png, .. } => self.write(&self.path(key, "png"), png),
            Entry::Invalid(message) => self.write(&self.path(key, "err"), message.as_bytes()),
        };
        if let Err(e) = written {
            if e.kind() == io::ErrorKind::NotFound { self.ready.store(false, Ordering::Release); }
            return Err(e);
        }
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        match *entries {
            Some(n) if n < KEEP => *entries = Some(n + 1),
            _ => *entries = Some(self.prune(KEEP)?),
        }
        Ok(())
    }

    /// Temporário de nome único na mesma pasta: duas gravações da mesma chave nunca escrevem no mesmo
    /// arquivo, e o que não chega ao `rename` some no drop.
    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        use std::io::Write as _;
        let mut tmp = tempfile::Builder::new().prefix(".").suffix(".tmp").tempfile_in(&self.root)?;
        tmp.write_all(bytes)?;
        tmp.persist(path).map(drop).map_err(|e| e.error)
    }

    /// Um voo por chave: quem pede a chave que já está sendo desenhada espera o mesmo resultado em vez de
    /// desenhar de novo. Se quem desenha desiste (cliente que caiu), o próximo que espera assume com o
    /// próprio `work`.
    pub async fn once<F, Fut>(&self, key: &str, work: F) -> Outcome
    where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Outcome> {
        let flight = self.flights.lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_owned()).or_default().clone();
        let leave = Leave { flights: &self.flights, key, flight };
        leave.flight.get_or_init(work).await.clone()
    }

    /// Apaga os mais antigos (pela modificação, que a leitura renova) até sobrarem `keep` entradas. O
    /// temporário de uma gravação em curso não conta nem é apagado; o abandonado há mais de uma hora sai.
    /// Devolve quantas entradas ficaram.
    pub fn prune(&self, keep: usize) -> io::Result<usize> {
        let now = SystemTime::now();
        let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
        for e in std::fs::read_dir(&self.root)?.flatten() {
            if !e.file_type().is_ok_and(|t| t.is_file()) { continue; }
            let modified = e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let path = e.path();
            match path.extension().and_then(|x| x.to_str()) {
                Some("png" | "err") => files.push((modified, path)),
                Some("tmp") if now.duration_since(modified).is_ok_and(|age| age > STALE_TMP) => { let _ = std::fs::remove_file(&path); }
                _ => {}
            }
        }
        if files.len() <= keep { return Ok(files.len()); }
        files.sort();
        for (_, path) in &files[..files.len() - keep] {
            if let Err(e) = std::fs::remove_file(path) && e.kind() != io::ErrorKind::NotFound { return Err(e); }
        }
        Ok(keep)
    }
}

/// Sai do mapa quando o voo acabou ou quando ninguém mais o espera; enquanto houver quem espere sem
/// resultado, ele fica, para que um pedido novo se junte em vez de desenhar em paralelo.
struct Leave<'a> { flights: &'a Mutex<HashMap<String, Flight>>, key: &'a str, flight: Flight }
impl Drop for Leave<'_> {
    fn drop(&mut self) {
        let mut flights = self.flights.lock().unwrap_or_else(|e| e.into_inner());
        // Os clones só nascem com o mapa travado: 2 = o do mapa e o deste pedido.
        let last = Arc::strong_count(&self.flight) <= 2;
        if flights.get(self.key).is_some_and(|f| Arc::ptr_eq(f, &self.flight)) && (self.flight.initialized() || last) {
            flights.remove(self.key);
        }
    }
}

/// Leitura renova a entrada para a poda; falhar aqui só antecipa a poda dela.
fn touch(path: &std::path::Path) {
    let _ = std::fs::File::options().append(true).open(path).and_then(|f| f.set_modified(SystemTime::now()));
}

fn absent_is_none<T>(r: io::Result<T>) -> io::Result<Option<T>> {
    match r { Ok(v) => Ok(Some(v)), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Cabeçalho PNG mínimo com a medida pedida; o resto do arquivo não é lido.
    fn fake_png(w: u32, h: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&w.to_be_bytes());
        png.extend_from_slice(&h.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png
    }

    #[test]
    fn key_separates_every_part() {
        let k = key("12.2.0", Theme::Dark, 728, "graph TD; A-->B");
        assert_eq!(k.len(), 64);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(k, key("12.2.0", Theme::Dark, 728, "graph TD; A-->B"));
        for other in [key("12.2.1", Theme::Dark, 728, "graph TD; A-->B"), key("12.2.0", Theme::Light, 728, "graph TD; A-->B"),
            key("12.2.0", Theme::Dark, 729, "graph TD; A-->B"), key("12.2.0", Theme::Dark, 728, "graph TD; A-->C")] {
            assert_ne!(k, other);
        }
        // O separador impede que a largura e a fonte troquem dígitos entre si.
        assert_ne!(key("v", Theme::Dark, 72, "8x"), key("v", Theme::Dark, 728, "x"));
    }

    #[test]
    fn css_size_is_half_of_the_png() {
        assert_eq!(css_size(&fake_png(1456, 300)), Some((728, 150)));
        assert_eq!(css_size(&fake_png(1455, 300)), None, "escala 2 sempre dá medida par");
        assert_eq!(css_size(b"GIF89a"), None);
        assert_eq!(css_size(&fake_png(0, 2)), None);
    }

    #[test]
    fn put_then_get_both_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path().join("mermaid"));
        assert!(cache.get("a").unwrap().is_none());
        cache.put("a", &Entry::Png { png: fake_png(800, 120), width: 400, height: 60 }).unwrap();
        cache.put("b", &Entry::Invalid("Parse error on line 1".into())).unwrap();
        let Some(Entry::Png { png, width, height }) = cache.get("a").unwrap() else { panic!("png") };
        assert_eq!((png, width, height), (fake_png(800, 120), 400, 60));
        let Some(Entry::Invalid(m)) = cache.get("b").unwrap() else { panic!("err") };
        assert_eq!(m, "Parse error on line 1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("mermaid")).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::write(dir.path().join("mermaid/c.png"), b"lixo").unwrap();
        assert!(cache.get("c").unwrap().is_none(), "PNG ilegível é desenhado de novo");
    }

    #[test]
    fn prune_drops_the_oldest_and_reading_renews() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path().into());
        let base = SystemTime::now() - Duration::from_secs(1000);
        for i in 0..5u64 {
            let p = dir.path().join(format!("k{i}.err"));
            std::fs::write(&p, "x").unwrap();
            std::fs::File::options().append(true).open(&p).unwrap().set_modified(base + Duration::from_secs(i)).unwrap();
        }
        assert!(cache.get("k0").unwrap().is_some(), "lida agora, k0 vira a mais nova");
        cache.prune(3).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["k0.err", "k3.err", "k4.err"]);
        cache.prune(3).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3, "abaixo do teto não apaga nada");
    }

    #[test]
    fn prune_skips_writes_in_progress_and_drops_abandoned_ones() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path().into());
        let old = SystemTime::now() - STALE_TMP - Duration::from_secs(60);
        for name in ["a.err", "b.err", ".k.writing.tmp", ".k.left.tmp"] { std::fs::write(dir.path().join(name), "x").unwrap(); }
        for name in ["a.err", ".k.left.tmp"] {
            std::fs::File::options().append(true).open(dir.path().join(name)).unwrap().set_modified(old).unwrap();
        }
        cache.prune(1).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, [".k.writing.tmp", "b.err"], "o temporário em curso não conta nem sai; o abandonado sai");
    }

    #[test]
    fn concurrent_puts_of_one_key_never_share_a_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(Cache::new(dir.path().into()));
        let writers: Vec<_> = (0..8u32).map(|i| {
            let cache = cache.clone();
            std::thread::spawn(move || cache.put("k", &Entry::Png { png: fake_png(800 + 2 * i, 120), width: 400 + i, height: 60 }))
        }).collect();
        for w in writers { w.join().unwrap().unwrap(); }
        let names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["k.png"], "nenhum temporário sobra");
        let Some(Entry::Png { png, .. }) = cache.get("k").unwrap() else { panic!("png") };
        assert!(css_size(&png).is_some(), "um dos PNGs inteiro, nunca dois misturados");
    }

    #[tokio::test]
    async fn a_waiter_takes_over_when_the_drawer_gives_up() {
        let cache = Arc::new(Cache::new(PathBuf::new()));
        let started = Arc::new(tokio::sync::Notify::new());
        let first = {
            let (cache, started) = (cache.clone(), started.clone());
            tokio::spawn(async move {
                cache.once("k", || async move { started.notify_one(); std::future::pending::<Outcome>().await }).await
            })
        };
        started.notified().await;
        let second = tokio::spawn({
            let cache = cache.clone();
            async move { cache.once("k", || async { Err("segundo") }).await }
        });
        // O segundo já espera no mesmo voo (mapa, primeiro e segundo) antes de o primeiro desistir.
        while cache.flights.lock().unwrap().get("k").map_or(0, Arc::strong_count) < 3 { tokio::task::yield_now().await; }
        first.abort();
        assert!(matches!(second.await.unwrap(), Err("segundo")), "quem esperava assume o desenho");
        assert!(cache.flights.lock().unwrap().is_empty(), "o voo acabado sai do mapa");
    }
}
