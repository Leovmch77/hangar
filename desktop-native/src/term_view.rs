//! Grade de terminal alimentada por bytes; o painel da sessão é dono do redesenho.
use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    term::{Config, Term, cell::{Cell, Flags}, color::COUNT},
    vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb},
};
use gpui_kit::{App, Bounds, ContentMask, Element, ElementId, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, Pixels, ShapedLine, StrikethroughStyle, Style, TextAlign, TextRun, UnderlineStyle,
    Window, fill, font, point, px, relative, rgb, size};

const TERM_FONT: &str = "JetBrains Mono";
const FONT_SIZE: f32 = 13.;
const LINE_HEIGHT: f32 = 19.;
// Cores ANSI são dados do protocolo; texto e fundo padrão vêm do tema ativo.
const ANSI16: [u32; 16] = [
    0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf,
    0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec,
];

struct GridSize { cols: usize, rows: usize }

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize { self.rows }
    fn screen_lines(&self) -> usize { self.rows }
    fn columns(&self) -> usize { self.cols }
}

#[derive(PartialEq, Eq)]
struct Snapshot {
    cells: Vec<Cell>,
    colors: [Option<Rgb>; COUNT],
    cursor: alacritty_terminal::term::RenderableCursor,
    offset: usize,
    cols: usize,
    rows: usize,
}

pub struct TermView {
    term: Term<VoidListener>,
    parser: Processor,
}

impl TermView {
    pub fn new(cols: usize, rows: usize) -> Self {
        let size = GridSize { cols: cols.max(2), rows: rows.max(1) };
        Self { term: Term::new(Config::default(), &size, VoidListener), parser: Processor::new() }
    }

    /// A fixture é opt-in; nenhum dado da sessão real entra nesta vista de prova.
    pub fn from_fixture_env(cols: usize, rows: usize) -> std::io::Result<Option<Self>> {
        let Some(path) = std::env::var_os("HANGAR_NATIVE_TERM_FIXTURE") else { return Ok(None) };
        let bytes = std::fs::read(path)?;
        let mut view = Self::new(cols, rows);
        view.feed(&bytes);
        Ok(Some(view))
    }

    /// O dono da vista chama notify apenas quando esta resposta for true.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        if bytes.is_empty() { return false; }
        let before = self.snapshot();
        self.parser.advance(&mut self.term, bytes);
        let after = self.snapshot();
        let cursor_changed = if before.cursor.shape == CursorShape::Hidden && after.cursor.shape == CursorShape::Hidden {
            false
        } else { before.cursor != after.cursor };
        before.cols != after.cols || before.rows != after.rows || before.offset != after.offset
            || before.colors != after.colors || cursor_changed
            || !before.cells.iter().zip(&after.cells).all(|(a, b)| {
                const PAINTED: Flags = Flags::from_bits_retain(Flags::INVERSE.bits() | Flags::BOLD.bits() | Flags::DIM.bits()
                    | Flags::ITALIC.bits() | Flags::ALL_UNDERLINES.bits() | Flags::HIDDEN.bits() | Flags::STRIKEOUT.bits()
                    | Flags::WIDE_CHAR.bits() | Flags::WIDE_CHAR_SPACER.bits());
                a.c == b.c && a.fg == b.fg && a.bg == b.bg && a.flags & PAINTED == b.flags & PAINTED
                    && a.zerowidth() == b.zerowidth() && a.underline_color() == b.underline_color()
            })
    }

    fn snapshot(&self) -> Snapshot {
        let visible = self.term.renderable_content();
        Snapshot {
            cells: visible.display_iter.map(|indexed| indexed.cell.clone()).collect(),
            colors: std::array::from_fn(|index| visible.colors[index]),
            cursor: visible.cursor,
            offset: visible.display_offset,
            cols: self.term.grid().columns(),
            rows: self.term.grid().screen_lines(),
        }
    }

    pub fn element(&self) -> impl IntoElement {
        TerminalGrid { snapshot: self.snapshot(), foreground: crate::theme::text(), background: crate::theme::background() }
    }
}

fn indexed_rgb(index: u8) -> u32 {
    match index {
        0..=15 => ANSI16[index as usize],
        16..=231 => {
            let n = index as u32 - 16;
            let step = |v| if v == 0 { 0 } else { 55 + v * 40 };
            step(n / 36) << 16 | step(n / 6 % 6) << 8 | step(n % 6)
        },
        _ => {
            let gray = 8 + (index as u32 - 232) * 10;
            gray << 16 | gray << 8 | gray
        },
    }
}

fn dim_rgb(value: u32) -> u32 {
    let channel = |shift: u32| ((value >> shift & 0xff_u32) * 2_u32 / 3_u32) << shift;
    channel(16) | channel(8) | channel(0)
}

fn paint_color(color: Color, palette: &[Option<Rgb>; COUNT], fg: Hsla, bg: Hsla) -> Hsla {
    let packed = |value: Rgb| rgb((u32::from(value.r) << 16) | (u32::from(value.g) << 8) | u32::from(value.b)).into();
    match color {
        Color::Spec(value) => packed(value),
        Color::Indexed(index) => palette[index as usize].map_or_else(|| rgb(indexed_rgb(index)).into(), packed),
        Color::Named(NamedColor::Foreground) => palette[NamedColor::Foreground as usize].map_or(fg, packed),
        Color::Named(NamedColor::BrightForeground) => palette[NamedColor::BrightForeground as usize]
            .or(palette[NamedColor::Foreground as usize]).map_or(fg, packed),
        Color::Named(NamedColor::Background) => palette[NamedColor::Background as usize].map_or(bg, packed),
        Color::Named(NamedColor::Cursor) => palette[NamedColor::Cursor as usize].map_or(fg, packed),
        Color::Named(NamedColor::DimForeground) => palette[NamedColor::DimForeground as usize].map_or(crate::theme::muted(), packed),
        Color::Named(name) => {
            let index = name as usize;
            palette[index].map_or_else(|| {
                let value = if index < 16 { indexed_rgb(index as u8) } else { dim_rgb(indexed_rgb((index - 259) as u8)) };
                rgb(value).into()
            }, packed)
        },
    }
}

fn cell_colors(cell: &Cell, palette: &[Option<Rgb>; COUNT], fg: Hsla, bg: Hsla) -> (Hsla, Option<Hsla>) {
    let named = match cell.fg {
        Color::Named(name) if cell.flags.contains(Flags::BOLD) => Color::Named(name.to_bright()),
        Color::Named(name) if cell.flags.contains(Flags::DIM) => Color::Named(name.to_dim()),
        value => value,
    };
    let (ink, fill) = if cell.flags.contains(Flags::INVERSE) { (cell.bg, named) } else { (named, cell.bg) };
    let ink = paint_color(ink, palette, fg, bg);
    let fill = (fill != Color::Named(NamedColor::Background) || palette[NamedColor::Background as usize].is_some())
        .then(|| paint_color(fill, palette, fg, bg));
    (ink, fill)
}

struct TerminalGrid { snapshot: Snapshot, foreground: Hsla, background: Hsla }

impl IntoElement for TerminalGrid {
    type Element = Self;
    fn into_element(self) -> Self { self }
}

impl Element for TerminalGrid {
    type RequestLayoutState = ();
    type PrepaintState = (Pixels, Vec<Vec<(usize, ShapedLine)>>);

    fn id(&self) -> Option<ElementId> { None }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> { None }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App)
        -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (),
        window: &mut Window, _: &mut App) -> Self::PrepaintState {
        let font = font(TERM_FONT);
        let cell_width = window.text_system().shape_line("M".into(), px(FONT_SIZE),
            &[TextRun { len: 1, font: font.clone(), color: self.foreground, ..Default::default() }], None).width;
        let cursor_row = self.snapshot.cursor.point.line.0 + self.snapshot.offset as i32;
        let cursor_col = self.snapshot.cursor.point.column.0;
        let lines = self.snapshot.cells.chunks(self.snapshot.cols).enumerate().map(|(row, cells)| {
            let mut text = String::new();
            let mut runs: Vec<TextRun> = Vec::new();
            let mut segments = Vec::new();
            let mut start_col = 0;
            for (col, cell) in cells.iter().enumerate() {
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue; }
                if cell.flags.contains(Flags::WIDE_CHAR) && !text.is_empty() {
                    segments.push((start_col, window.text_system().shape_line(text.into(), px(FONT_SIZE), &runs, None)));
                    text = String::new();
                    runs.clear();
                }
                if text.is_empty() { start_col = col; }
                let start = text.len();
                text.push(if cell.flags.contains(Flags::HIDDEN) { ' ' } else { cell.c });
                if let Some(marks) = cell.zerowidth() { text.extend(marks); }
                let (mut ink, _) = cell_colors(cell, &self.snapshot.colors, self.foreground, self.background);
                if self.snapshot.cursor.shape == CursorShape::Block && row as i32 == cursor_row && col == cursor_col {
                    ink = paint_color(Color::Named(NamedColor::Background), &self.snapshot.colors, self.foreground, self.background);
                }
                let mut glyph_font = font.clone();
                if cell.flags.contains(Flags::BOLD) { glyph_font = glyph_font.bold(); }
                if cell.flags.contains(Flags::ITALIC) { glyph_font = glyph_font.italic(); }
                let underline = cell.flags.intersects(Flags::ALL_UNDERLINES).then(|| UnderlineStyle {
                    thickness: px(1.),
                    color: cell.underline_color().map(|value| paint_color(value, &self.snapshot.colors, ink, self.background)),
                    wavy: cell.flags.contains(Flags::UNDERCURL),
                });
                let strikethrough = cell.flags.contains(Flags::STRIKEOUT).then(|| StrikethroughStyle { thickness: px(1.), color: None });
                let len = text.len() - start;
                if let Some(last) = runs.last_mut().filter(|run| run.color == ink && run.font == glyph_font
                    && run.underline == underline && run.strikethrough == strikethrough) { last.len += len; }
                else { runs.push(TextRun { len, font: glyph_font, color: ink, underline, strikethrough, ..Default::default() }); }
                if cell.flags.contains(Flags::WIDE_CHAR) {
                    segments.push((start_col, window.text_system().shape_line(text.into(), px(FONT_SIZE), &runs, None)));
                    text = String::new();
                    runs.clear();
                }
            }
            if !text.is_empty() {
                segments.push((start_col, window.text_system().shape_line(text.into(), px(FONT_SIZE), &runs, None)));
            }
            segments
        }).collect();
        (cell_width, lines)
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (),
        state: &mut Self::PrepaintState, window: &mut Window, cx: &mut App) {
        let (cell_width, lines) = state;
        let line_height = px(LINE_HEIGHT);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for (row, cells) in self.snapshot.cells.chunks(self.snapshot.cols).enumerate() {
                for (col, cell) in cells.iter().enumerate() {
                    let (_, fill_color) = cell_colors(cell, &self.snapshot.colors, self.foreground, self.background);
                    if let Some(color) = fill_color {
                        let origin = point(bounds.origin.x + *cell_width * col as f32, bounds.origin.y + line_height * row as f32);
                        window.paint_quad(fill(Bounds { origin, size: size(*cell_width, line_height) }, color));
                    }
                }
            }
            let cursor = self.snapshot.cursor;
            if let Ok(row) = usize::try_from(cursor.point.line.0 + self.snapshot.offset as i32) {
                if row < self.snapshot.rows && cursor.point.column.0 < self.snapshot.cols {
                    let col = cursor.point.column.0;
                    let wide = self.snapshot.cells[row * self.snapshot.cols + col].flags.contains(Flags::WIDE_CHAR);
                    let cursor_width = *cell_width * if wide { 2. } else { 1. };
                    let origin = point(bounds.origin.x + *cell_width * col as f32,
                        bounds.origin.y + line_height * row as f32);
                    let color = self.snapshot.colors[NamedColor::Cursor as usize]
                        .map_or(self.foreground, |value| paint_color(Color::Spec(value), &self.snapshot.colors, self.foreground, self.background));
                    let cursor_bounds = Bounds { origin, size: size(cursor_width, line_height) };
                    match cursor.shape {
                        CursorShape::Block => window.paint_quad(fill(cursor_bounds, color)),
                        CursorShape::Beam => window.paint_quad(fill(Bounds { size: size(px(2.), line_height), ..cursor_bounds }, color)),
                        CursorShape::Underline => window.paint_quad(fill(Bounds { origin: point(origin.x, origin.y + line_height - px(2.)), size: size(cursor_width, px(2.)) }, color)),
                        CursorShape::HollowBlock => {
                            window.paint_quad(fill(Bounds { size: size(cursor_width, px(1.)), ..cursor_bounds }, color));
                            window.paint_quad(fill(Bounds { origin: point(origin.x, origin.y + line_height - px(1.)), size: size(cursor_width, px(1.)) }, color));
                            window.paint_quad(fill(Bounds { size: size(px(1.), line_height), ..cursor_bounds }, color));
                            window.paint_quad(fill(Bounds { origin: point(origin.x + cursor_width - px(1.), origin.y), size: size(px(1.), line_height) }, color));
                        },
                        CursorShape::Hidden => {},
                    }
                }
            }
            for (row, segments) in lines.iter().enumerate() {
                for (col, line) in segments {
                    let origin = point(bounds.origin.x + *cell_width * *col as f32, bounds.origin.y + line_height * row as f32);
                    if let Err(error) = line.paint(origin, line_height, TextAlign::Left, None, window, cx) {
                        eprintln!("Falha ao desenhar texto do terminal: {error}");
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_grid_keeps_colors_cursor_clear_wrap_and_wide_cells() {
        let mut view = TermView::new(8, 4);
        assert!(!view.feed(&[]));
        assert!(view.feed(b"\x1b[31mR\x1b[38;5;196mX\x1b[38;2;1;2;3mT"));
        let grid = view.snapshot();
        assert_eq!(grid.cells[0].fg, Color::Named(NamedColor::Red));
        assert_eq!(grid.cells[1].fg, Color::Indexed(196));
        assert_eq!(grid.cells[2].fg, Color::Spec(Rgb { r: 1, g: 2, b: 3 }));
        assert_eq!(indexed_rgb(196), 0xff0000);
        assert_ne!(dim_rgb(ANSI16[1]), ANSI16[1]);
        assert!(!view.feed(b"\x1b[4G")); // O cursor já está na quarta coluna após T.
        assert!(view.feed("界🙂abcdef".as_bytes()));
        let grid = view.snapshot();
        assert!(grid.cells.iter().any(|cell| cell.c == '界' && cell.flags.contains(Flags::WIDE_CHAR)));
        assert!(grid.cells.iter().any(|cell| cell.c == '🙂' && cell.flags.contains(Flags::WIDE_CHAR)));
        assert_eq!(grid.cells[8].c, 'b');
        assert!(view.feed(b"\x1b[1;5H"));
        let grid = view.snapshot();
        assert_eq!(grid.cursor.point.column.0, 3);
        assert!(grid.cells[3].flags.contains(Flags::WIDE_CHAR));
        assert!(view.feed(b"\x1b[2J"));
        assert!(view.snapshot().cells.iter().all(|cell| cell.c == ' '));
        assert!(view.feed(b"\x1b[?25l"));
        assert!(!view.feed(b"\x1b[2;2H"));
    }
}
