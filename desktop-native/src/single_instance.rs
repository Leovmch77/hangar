//! Uma janela só: a segunda execução (o link `hangar://` aberto pelo sistema) entrega o link à primeira e sai.
use std::{io::{BufRead, BufReader, Read, Write}, net::{Shutdown, TcpListener, TcpStream}, path::{Path, PathBuf}, time::Duration};

pub enum Claim { Forwarded, Primary(async_channel::Sender<String>, async_channel::Receiver<String>) }

pub fn invite_arg(args: impl Iterator<Item = String>) -> Option<String> { args.skip(1).find(|a| a.starts_with("hangar://")) }

fn port_file() -> Option<PathBuf> {
    let base = if cfg!(windows) { std::env::var_os("APPDATA").map(PathBuf::from) }
        else { std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))) };
    base.map(|b| b.join("hangar-native").join("instance"))
}

pub fn claim(link: Option<String>) -> Claim {
    match port_file() {
        Some(file) => claim_at(&file, link),
        // Sem pasta de configuração não há como achar a outra instância: abre sozinha, como antes.
        None => { let (tx, rx) = async_channel::unbounded(); if let Some(link) = link { let _ = tx.try_send(link); } Claim::Primary(tx, rx) }
    }
}

fn forward(file: &Path, link: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let Some((port, nonce)) = text.split_once('\n') else { return false };
    let Ok(port) = port.trim().parse::<u16>() else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if write!(stream, "{}\n{link}\n", nonce.trim()).is_err() { return false; }
    let _ = stream.shutdown(Shutdown::Write);
    let mut answer = String::new();
    BufReader::new(stream).read_line(&mut answer).is_ok() && answer.trim() == "ok"
}

pub fn claim_at(file: &Path, link: Option<String>) -> Claim {
    // Sem link a segunda execução também só avisa: a primeira vem para a frente.
    if forward(file, link.as_deref().unwrap_or("")) { return Claim::Forwarded; }
    let (tx, rx) = async_channel::unbounded();
    if let Some(link) = link { let _ = tx.try_send(link); }
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return Claim::Primary(tx, rx) };
    let thread_tx = tx.clone();
    let nonce = format!("{:x}{:x}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    if let Ok(mut f) = options.open(file) { let _ = write!(f, "{port}\n{nonce}"); }
    std::thread::Builder::new().name("single-instance".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            // Quem conecta e não fala não pode travar a fila: prazo de leitura e teto de tamanho.
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut reader = BufReader::new((&stream).take(8192));
            let (mut got, mut link) = (String::new(), String::new());
            if reader.read_line(&mut got).is_err() || got.trim() != nonce { continue; }
            let _ = reader.read_line(&mut link);
            let _ = (&stream).write_all(b"ok\n");
            if thread_tx.send_blocking(link.trim().to_owned()).is_err() { break; }
        }
    }).ok();
    Claim::Primary(tx, rx)
}

#[cfg(test)]
mod tests {
    use super::{Claim, claim_at, invite_arg};
    use core::prelude::v1::test;

    #[test]
    fn only_the_first_hangar_link_counts() {
        let args = ["hangar-native", "--x", "hangar://convite/h:8443/AB", "hangar://convite/h:8443/CD"].map(String::from);
        assert_eq!(invite_arg(args.into_iter()).as_deref(), Some("hangar://convite/h:8443/AB"));
        assert_eq!(invite_arg(["hangar-native".to_owned()].into_iter()), None);
    }

    #[test]
    fn second_launch_hands_the_link_to_the_first_and_exits() {
        let dir = std::env::temp_dir().join(format!("hangar-si-{}", std::process::id()));
        let file = dir.join("instance");
        let Claim::Primary(_, rx) = claim_at(&file, None) else { panic!("first launch must be primary") };
        assert!(matches!(claim_at(&file, Some("hangar://convite/h:8443/AB".into())), Claim::Forwarded));
        assert_eq!(rx.recv_blocking().unwrap(), "hangar://convite/h:8443/AB");
        // Arquivo velho de outra execução (nonce que ninguém escuta): a nova vira a primária.
        std::fs::write(&file, "1\nnonce-velho").unwrap();
        assert!(matches!(claim_at(&file, None), Claim::Primary(..)));
        let _ = std::fs::remove_dir_all(dir);
    }
}
