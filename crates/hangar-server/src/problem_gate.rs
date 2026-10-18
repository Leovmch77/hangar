//! Problema de estado observado só chega à tela se ainda valer depois de `HOLD`: troca de vida, Claude
//! subindo e leitura isolada passam sem aviso. Some na hora quando o estado vem sem ele. Erro de ação
//! (resposta de um clique ou envio) não passa por aqui.
use std::time::{Duration, Instant};

pub const HOLD: Duration = Duration::from_secs(3);

/// O que fazer com o problema que o estado traz agora.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Sem problema: nada a mostrar.
    Clear,
    /// Valeu pelo prazo: mostra.
    Show,
    /// Ainda no prazo: esconde e confere de novo em `Instant`.
    Hold(Instant),
}

/// Um por sessão; código diferente do anterior conta como problema novo.
#[derive(Default)]
pub struct ProblemGate { shown: Option<String>, pending: Option<(String, Instant)> }

/// O problema que a lista mostra de cada sessão: a conversa aberta depois começa do mesmo ponto, sem
/// esconder de novo pelo prazo o que a lista já mostra.
#[derive(Default)]
pub struct Shown(std::sync::Mutex<std::collections::HashMap<String, String>>);
impl Shown {
    pub fn set(&self, name: &str, code: Option<&str>) {
        let mut shown = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match code { Some(code) => { shown.insert(name.to_owned(), code.to_owned()); }, None => { shown.remove(name); } }
    }
    pub fn get(&self, name: &str) -> Option<String> { self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(name).cloned() }
    pub fn retain(&self, keep: impl Fn(&str) -> bool) { self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|name, _| keep(name)); }
}

impl ProblemGate {
    /// Já mostrando `code` (o que a lista mostra): o mesmo problema sai sem esperar de novo.
    pub fn showing(code: Option<String>) -> Self { Self { shown: code, pending: None } }

    pub fn admit(&mut self, code: Option<&str>, now: Instant, hold: Duration) -> Gate {
        let Some(code) = code else { self.shown = None; self.pending = None; return Gate::Clear };
        if self.shown.as_deref() == Some(code) { return Gate::Show; }
        self.shown = None;
        let since = match &self.pending { Some((pending, since)) if pending == code => *since, _ => now };
        if now.saturating_duration_since(since) >= hold {
            self.pending = None;
            self.shown = Some(code.to_owned());
            return Gate::Show;
        }
        self.pending = Some((code.to_owned(), since));
        Gate::Hold(since + hold)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problem_shows_only_after_it_held_and_clears_at_once() {
        let (mut gate, t0) = (ProblemGate::default(), Instant::now());
        assert_eq!(gate.admit(None, t0, HOLD), Gate::Clear);
        assert_eq!(gate.admit(Some("runtime_binding"), t0, HOLD), Gate::Hold(t0 + HOLD));
        assert_eq!(gate.admit(Some("runtime_binding"), t0 + Duration::from_secs(2), HOLD), Gate::Hold(t0 + HOLD), "o prazo conta do primeiro");
        assert_eq!(gate.admit(Some("runtime_binding"), t0 + HOLD, HOLD), Gate::Show);
        assert_eq!(gate.admit(Some("runtime_binding"), t0 + Duration::from_secs(9), HOLD), Gate::Show, "mostrado segue mostrado");
        assert_eq!(gate.admit(None, t0 + Duration::from_secs(10), HOLD), Gate::Clear, "resolveu: some na hora");
        let t1 = t0 + Duration::from_secs(11);
        assert_eq!(gate.admit(Some("runtime_binding"), t1, HOLD), Gate::Hold(t1 + HOLD), "voltou: espera de novo");
    }

    #[test]
    fn a_transient_problem_never_shows_and_a_new_code_waits_again() {
        let (mut gate, t0) = (ProblemGate::default(), Instant::now());
        assert_eq!(gate.admit(Some("a"), t0, HOLD), Gate::Hold(t0 + HOLD));
        assert_eq!(gate.admit(None, t0 + Duration::from_secs(1), HOLD), Gate::Clear, "durou menos que o prazo");
        assert_eq!(gate.admit(Some("a"), t0 + Duration::from_secs(2), HOLD), Gate::Hold(t0 + Duration::from_secs(2) + HOLD));
        assert_eq!(gate.admit(Some("a"), t0 + Duration::from_secs(6), HOLD), Gate::Show);
        let t1 = t0 + Duration::from_secs(7);
        assert_eq!(gate.admit(Some("b"), t1, HOLD), Gate::Hold(t1 + HOLD), "código novo é problema novo");
    }
}
