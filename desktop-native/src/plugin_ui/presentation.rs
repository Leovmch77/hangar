//! A pergunta tem prioridade sem alterar a escolha manual de minimizar o mod.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Display {
    #[default]
    None,
    Panel,
    Minimized,
    Question,
}

#[derive(Debug, Default)]
pub struct Presentation {
    minimized: bool,
}

impl Presentation {
    pub fn display(&self, has_panel: bool, has_question: bool) -> Display {
        if has_question {
            Display::Question
        } else if !has_panel {
            Display::None
        } else if self.minimized {
            Display::Minimized
        } else {
            Display::Panel
        }
    }

    pub fn minimize(&mut self) {
        self.minimized = true;
    }

    pub fn restore(&mut self) {
        self.minimized = false;
    }

    pub fn reserves_panel(&self, has_panel: bool) -> bool {
        has_panel && !self.minimized
    }
}

#[cfg(test)]
mod tests {
    use super::{Display, Presentation};

    #[test]
    fn question_replaces_the_panel_until_the_interaction_is_resolved() {
        let view = Presentation::default();
        assert_eq!(view.display(true, false), Display::Panel);
        assert_eq!(view.display(true, true), Display::Question);
        assert_eq!(
            view.display(true, true),
            Display::Question,
            "resposta pendente ou pergunta sucessiva"
        );
        assert!(
            view.reserves_panel(true),
            "a pergunta ocupa o mesmo espaço do painel aberto"
        );
        assert_eq!(view.display(true, false), Display::Panel);
        assert_eq!(
            view.display(false, false),
            Display::None,
            "não restaurar um painel removido pelo mod"
        );
    }

    #[test]
    fn manual_minimization_survives_questions_and_isolated_sessions() {
        let mut view = Presentation::default();
        view.minimize();
        assert_eq!(view.display(true, false), Display::Minimized);
        assert!(!view.reserves_panel(true));
        assert_eq!(view.display(true, true), Display::Question);
        assert_eq!(view.display(true, false), Display::Minimized);
        assert_eq!(view.display(false, false), Display::None);
        assert_eq!(view.display(false, true), Display::Question);
        assert_eq!(Presentation::default().display(true, false), Display::Panel);
        view.restore();
        assert_eq!(view.display(true, false), Display::Panel);
        assert!(view.reserves_panel(true));
    }
}
