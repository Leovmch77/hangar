//! Religação do ator ao MESMO processo quando só o socket caiu: nada é encerrado nem religado; uma
//! tarefa por sessão tenta de novo com espera crescente enquanto o processo viver. Serve ao cano do
//! Claude sem terminal e ao app-server adotado do Codex com terminal (só a tabela de esperas muda).
use super::{actor::RuntimeConnection,cano,process,protocol::*};
use std::time::Duration;
use tokio::task::JoinHandle;

/// Esperas entre tentativas, em segundos; a última se repete.
pub const RECONNECT_WAITS:[u64;8] = [0,1,3,10,30,60,120,300];
/// Com mensagem da pessoa esperando: espera curta.
pub const RECONNECT_WAITS_PENDING:[u64;4] = [0,1,3,10];
/// Mensagem sem entrega há mais que isto, com o cano vivo, vira aviso no estado.
pub const DELIVERY_STALL:Duration = Duration::from_secs(60);
/// A vida do cano é conferida neste intervalo, fora das tentativas: a morte aparece sem esperar a próxima.
pub const CANO_CHECK:Duration = Duration::from_secs(5);

#[derive(Clone,Debug)]
pub struct ReconnectWaits { pub normal:Vec<Duration>, pub pending:Vec<Duration>, pub stall:Duration, pub check:Duration }

impl Default for ReconnectWaits {
    fn default() -> Self {
        Self { normal:RECONNECT_WAITS.map(Duration::from_secs).to_vec(),pending:RECONNECT_WAITS_PENDING.map(Duration::from_secs).to_vec(),
            stall:DELIVERY_STALL,check:CANO_CHECK }
    }
}

pub enum Attempt {
    Connected(RuntimeConnection),
    /// O mesmo processo segue vivo: tenta de novo depois da espera.
    Retry(RuntimeError),
    /// O processo morreu, é outro ou o vínculo mudou: não é mais religação.
    Gone(RuntimeError),
    /// Falta o que prova que o processo é o desta vida: para de tentar.
    Stopped(RuntimeError),
}

/// O cano desta vida: `Some(true)` vivo e o mesmo; `Some(false)` morto ou outro processo no pid;
/// `None` vivo, mas sem nascimento gravado para provar que é o mesmo. Bloqueante (lê o processo).
pub fn cano_alive(pid:u32,key:&str,birth:Option<f64>) -> Option<bool> {
    if process::liveness(pid,key) != process::Liveness::Ours { return Some(false); }
    birth.map(|birth|crate::terminal_facts::agent_birth(pid) == Some(birth))
}

/// Uma tentativa ao cano do Claude: a vida dele antes de conectar.
pub async fn attempt(binding:CanoBinding,key:String,birth:Option<f64>) -> Attempt {
    if binding.token.is_empty() || binding.escuta.is_empty() || binding.pid == 0 {
        return Attempt::Stopped(RuntimeError::new("cano_binding_missing","o vínculo do cano desta vida não existe"));
    }
    let pid = binding.pid;
    match tokio::task::spawn_blocking(move||cano_alive(pid,&key,birth)).await {
        Err(_) => return Attempt::Retry(RuntimeError::new("cano_probe","a leitura do processo do cano falhou")),
        Ok(Some(false)) => return Attempt::Gone(RuntimeError::new("cano_gone","o cano da sessão não está mais vivo")),
        Ok(None) => return Attempt::Stopped(RuntimeError::new("lifecycle_process_birth_missing","o nascimento do cano desta vida não é conhecido")),
        Ok(Some(true)) => {},
    }
    match cano::connect(&binding).await {
        Ok(connection) => Attempt::Connected(RuntimeConnection::Cano(connection)),
        Err(error) => Attempt::Retry(error),
    }
}

/// Estado de tamanho fixo: prazo da próxima tentativa (relógio do ator), a tarefa em voo, a época do
/// transporte em que ela nasceu e quantas esperas já passaram.
#[derive(Default)]
pub struct CanoReconnect {
    pub next_at:Option<f64>,
    pub task:Option<JoinHandle<Attempt>>,
    pub epoch:u64,
    step:usize,
    waits:ReconnectWaits,
}

impl CanoReconnect {
    pub fn new(waits:ReconnectWaits) -> Self { Self { waits,..Self::default() } }
    pub fn waits(&self) -> &ReconnectWaits { &self.waits }
    /// Próxima tentativa: a espera da vez na lista curta (mensagem esperando) ou na normal. A espera
    /// conta do fim da tentativa anterior, por mais que ela tenha demorado.
    pub fn schedule(&mut self,now:f64,pending:bool) {
        let list = if pending { &self.waits.pending } else { &self.waits.normal };
        let wait = list.get(self.step.min(list.len().saturating_sub(1))).copied().unwrap_or_default();
        self.step = self.step.saturating_add(1);
        self.next_at = Some(now + wait.as_secs_f64());
    }
    /// Gatilho (mensagem nova, conversa aberta): só antecipa a tentativa já marcada, nunca cria outra.
    pub fn wake(&mut self,now:f64) {
        if let Some(at) = self.next_at.as_mut() && *at > now { *at = now; }
    }
    pub fn connected(&mut self) { self.step = 0; self.next_at = None; }
    /// Fechamento, queda real ou parada: timer e tentativa saem.
    pub fn cancel(&mut self) {
        self.step = 0;
        self.next_at = None;
        if let Some(task) = self.task.take() { task.abort(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waits_of(reconnect:&mut CanoReconnect,pending:&[bool]) -> Vec<f64> {
        pending.iter().map(|pending|{ reconnect.schedule(100.0,*pending); reconnect.next_at.unwrap() - 100.0 }).collect()
    }

    #[test]
    fn waits_grow_and_repeat_the_last_one() {
        let mut reconnect = CanoReconnect::default();
        assert_eq!(waits_of(&mut reconnect,&[false;10]),vec![0.0,1.0,3.0,10.0,30.0,60.0,120.0,300.0,300.0,300.0]);
    }

    #[test]
    fn a_waiting_message_uses_the_short_waits_and_after_reconnecting_the_normal_ones_return() {
        let mut reconnect = CanoReconnect::default();
        assert_eq!(waits_of(&mut reconnect,&[true;6]),vec![0.0,1.0,3.0,10.0,10.0,10.0]);
        reconnect.connected();
        assert_eq!(reconnect.next_at,None);
        assert_eq!(waits_of(&mut reconnect,&[false;5]),vec![0.0,1.0,3.0,10.0,30.0]);
        // Mensagem que chega no meio de uma queda longa troca para a lista curta sem voltar ao começo.
        assert_eq!(waits_of(&mut reconnect,&[false,true]),vec![60.0,10.0]);
    }

    #[test]
    fn wake_only_brings_the_marked_attempt_forward() {
        let mut reconnect = CanoReconnect::default();
        reconnect.wake(5.0);
        assert_eq!(reconnect.next_at,None,"sem queda, o gatilho não cria tentativa");
        for _ in 0..5 { reconnect.schedule(0.0,false); }
        assert_eq!(reconnect.next_at,Some(30.0));
        reconnect.wake(7.0);
        assert_eq!(reconnect.next_at,Some(7.0));
        reconnect.wake(9.0);
        assert_eq!(reconnect.next_at,Some(7.0),"nunca adia");
    }
}
