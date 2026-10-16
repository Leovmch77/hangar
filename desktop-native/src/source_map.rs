//! Correspondência entre a fonte de uma mensagem e o Markdown desenhado depois das trocas locais (chip de arquivo
//! citado, escape de `<`, imagem). A seleção é feita sobre o desenhado, mas a citação tem de levar o que o agente
//! escreveu: um `[app.rs:12](hangar-file:…)` ou `&lt;` que ele nunca escreveu confunde o modelo.
use std::ops::Range;

/// Trechos trocados por uma transformação, em ordem: a faixa na entrada e a faixa na saída. Fora deles a saída é a
/// entrada byte a byte, só deslocada.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Edits(Vec<(Range<usize>, Range<usize>)>);

impl Edits {
    pub fn push(&mut self, input: Range<usize>, output: Range<usize>) { self.0.push((input, output)); }

    /// Faixa da saída na entrada; ponta que cai no meio de um trecho trocado se alarga até a borda dele.
    pub fn to_input(&self, range: Range<usize>) -> Range<usize> {
        let edits = self.0.iter().map(|(i, o)| (o, i));
        point(edits.clone(), range.start, false)..point(edits, range.end, true)
    }

    /// Faixa da entrada na saída, com o mesmo alargamento.
    pub fn to_output(&self, range: Range<usize>) -> Range<usize> {
        let edits = self.0.iter().map(|(i, o)| (i, o));
        point(edits.clone(), range.start, false)..point(edits, range.end, true)
    }
}

/// Leva `at` do espaço `from` ao `to`. Dentro de um trecho trocado, o começo vai para a borda esquerda e o fim
/// para a direita.
fn point<'a>(edits: impl Iterator<Item = (&'a Range<usize>, &'a Range<usize>)>, at: usize, end: bool) -> usize {
    let (mut from_end, mut to_end) = (0, 0);
    for (from, to) in edits {
        if at <= from.start { break; }
        if at < from.end { return if end { to.end } else { to.start }; }
        (from_end, to_end) = (from.end, to.end);
    }
    to_end + (at - from_end)
}

/// As duas trocas de uma mensagem: a dos arquivos citados (fonte → meio) e a do escape seguro (meio → desenhado).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceMap { pub cite: Edits, pub safe: Edits, pub source_len: usize }

impl SourceMap {
    pub fn to_source(&self, drawn: Range<usize>) -> Range<usize> { self.cite.to_input(self.safe.to_input(drawn)) }
    pub fn to_drawn(&self, source: Range<usize>) -> Range<usize> { self.safe.to_output(self.cite.to_output(source)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Troca `from` por `to` em todas as ocorrências, anotando cada troca.
    fn replace(text: &str, from: &str, to: &str) -> (String, Edits) {
        let (mut out, mut edits, mut last) = (String::new(), Edits::default(), 0);
        for (at, _) in text.match_indices(from) {
            out.push_str(&text[last..at]);
            let start = out.len();
            out.push_str(to);
            edits.push(at..at + from.len(), start..out.len());
            last = at + from.len();
        }
        out.push_str(&text[last..]);
        (out, edits)
    }

    #[test]
    fn plain_text_maps_with_the_shift_of_the_edits_before() {
        let (out, edits) = replace("a <b> c <d> e", "<", "&lt;");
        assert_eq!(out, "a &lt;b> c &lt;d> e");
        let c = out.find('c').unwrap();
        assert_eq!(edits.to_input(c..c + 1), 6..7);
        assert_eq!(edits.to_output(6..7), c..c + 1);
        assert_eq!(edits.to_input(0..out.len()), 0..13);
        assert_eq!(Edits::default().to_input(3..5), 3..5);
    }

    #[test]
    fn a_cut_inside_an_edit_widens_to_its_borders() {
        let (out, edits) = replace("x LINK y", "LINK", "[app.rs:12](hangar-file:?path=/a/app.rs&line=12)");
        let inner = out.find("rs:12").unwrap();
        // Começa no meio do link e acaba no meio dele: a fonte inteira do link.
        assert_eq!(edits.to_input(inner..inner + 3), 2..6);
        // Começa antes e acaba no meio: até o fim do trecho na fonte.
        assert_eq!(edits.to_input(0..inner), 0..6);
        // A volta: o trecho da fonte cobre o link inteiro do desenhado.
        let back = edits.to_output(2..6);
        assert_eq!(&out[back], "[app.rs:12](hangar-file:?path=/a/app.rs&line=12)");
        // Borda exata não alarga.
        let after = out.find(" y").unwrap();
        assert_eq!(edits.to_input(after..out.len()), 6..8);
    }

    #[test]
    fn two_steps_compose_both_ways() {
        let source = "veja `app.rs:12` e <Button>";
        let (mid, cite) = replace(source, "`app.rs:12`", "[app.rs:12](hangar-file:?path=app.rs&line=12)");
        let (drawn, safe) = replace(&mid, "<", "&lt;");
        let map = SourceMap { cite, safe, source_len: source.len() };
        let button = drawn.find("Button").unwrap();
        assert_eq!(&source[map.to_source(button..drawn.len())], "Button>");
        let lt = drawn.find("&lt;").unwrap();
        assert_eq!(&source[map.to_source(lt + 1..drawn.len())], "<Button>");
        let link = drawn.find("hangar-file").unwrap();
        assert_eq!(&source[map.to_source(link..button)], "`app.rs:12` e <");
        let at = source.find("`app").unwrap();
        assert_eq!(&drawn[map.to_drawn(at..source.len())], &drawn[drawn.find("[app").unwrap()..]);
    }
}
