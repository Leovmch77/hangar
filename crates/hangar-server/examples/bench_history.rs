//! Mede `merged_history` em transcripts fixos: mediana de 7 rodadas, hash do resultado e se a
//! cauda com `limit` bate com o fim do histórico inteiro. Uso: bench_history <arquivo.jsonl>...
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::Instant;

use hangar_server::transcript::{merged_history, HistoryRequest, Provider, TAIL_WINDOW};

fn main() {
    for file in std::env::args().skip(1) {
        let req = |limit| HistoryRequest {
            provider: Provider::Claude,
            jsonl: PathBuf::from(&file),
            queue: None,
            limit,
            tail_window: TAIL_WINDOW,
        };
        let full = merged_history(&req(None)).unwrap();
        for limit in [Some(50), Some(400), None] {
            let mut times = Vec::new();
            let mut evs = Vec::new();
            for _ in 0..7 {
                let t = Instant::now();
                evs = merged_history(&req(limit)).unwrap();
                times.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            times.sort_by(f64::total_cmp);
            let bytes = serde_json::to_vec(&evs).unwrap();
            let mut h = DefaultHasher::new();
            bytes.hash(&mut h);
            let truth = limit.map(|l| {
                let tail = &full[full.len().saturating_sub(l)..];
                serde_json::to_vec(tail).unwrap() == bytes
            });
            println!(
                "{} limit={} med_ms={:.1} events={} hash={:016x} igual_ao_inteiro={}",
                file.rsplit('/').next().unwrap(),
                limit.map_or("full".into(), |l| l.to_string()),
                times[3],
                evs.len(),
                h.finish(),
                truth.map_or("-".into(), |t| t.to_string()),
            );
        }
    }
}
