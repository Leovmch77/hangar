// ponytail: stub até o motor WPE entrar; mesma superfície do wry_engine.
use gpui_kit::*;

use super::{Event, Pointer};

pub struct Engine;

impl Engine {
    pub fn available() -> Result<(), String> { Err("WPE ainda não implementado".into()) }
    pub fn new(_window: &mut Window, _events: async_channel::Sender<Event>) -> Result<Self, String> { Self::available().map(|_| Self) }
    pub fn load(&self, _url: &str) {}
    pub fn back(&self) {}
    pub fn forward(&self) {}
    pub fn reload(&self) {}
    pub fn place(&self, _bounds: Bounds<Pixels>, _window: &mut Window) {}
    pub fn hide(&self) {}
    pub fn pointer(&self, _kind: Pointer, _at: Point<Pixels>, _clicks: usize) {}
    pub fn wheel(&self, _at: Point<Pixels>, _delta: Point<Pixels>) {}
    pub fn key(&self, _down: bool, _keystroke: &Keystroke) {}
    pub fn focus(&self, _focused: bool) {}
}
