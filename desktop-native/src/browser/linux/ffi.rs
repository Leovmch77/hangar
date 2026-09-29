//! WPE WebKit e GLib resolvidos em tempo de execução: sem WPE instalado o app abre, só sem navegador.
//! Cada tipo repete o protótipo do header C (wpe-webkit-2.0, wpe-platform, glib).
use std::{
    ffi::{c_char, c_int, c_uint, c_ulong, c_void},
    sync::OnceLock,
};

use libloading::Library;

pub type P = *mut c_void;
pub type GType = usize;

#[repr(C)]
pub struct GError {
    pub domain: u32,
    pub code: c_int,
    pub message: *const c_char,
}

// A WebKit exporta webkit_* e wpe_*; as g_* saem das dependências dela pelo mesmo handle.
const LIB: &str = "libWPEWebKit-2.0.so.1";

pub const G_PRIORITY_DEFAULT: c_int = 0;
pub const WEBKIT_LOAD_STARTED: c_int = 0;
pub const WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION: c_int = 0;
pub const WEBKIT_NETWORK_ERROR_CANCELLED: c_int = 302;
pub const WPE_EVENT_POINTER_DOWN: c_int = 1;
pub const WPE_EVENT_POINTER_UP: c_int = 2;
pub const WPE_EVENT_POINTER_MOVE: c_int = 3;
pub const WPE_EVENT_KEYBOARD_KEY_DOWN: c_int = 7;
pub const WPE_EVENT_KEYBOARD_KEY_UP: c_int = 8;
pub const WPE_INPUT_SOURCE_MOUSE: c_int = 0;
pub const WPE_INPUT_SOURCE_KEYBOARD: c_int = 2;
pub const WPE_MODIFIER_KEYBOARD_CONTROL: c_uint = 1 << 0;
pub const WPE_MODIFIER_KEYBOARD_SHIFT: c_uint = 1 << 1;
pub const WPE_MODIFIER_KEYBOARD_ALT: c_uint = 1 << 2;
pub const WPE_MODIFIER_POINTER_BUTTON1: c_uint = 1 << 8;
pub const WPE_BUTTON_PRIMARY: c_uint = 1;

macro_rules! api {
    ($($name:ident: $ty:ty;)*) => {
        pub struct Api {
            _lib: Library,
            $(pub $name: $ty,)*
        }

        impl Api {
            pub fn open(lib_name: &str) -> Result<Self, String> {
                // SAFETY: carregar roda os construtores da lib; é a WebKit do sistema.
                let lib = unsafe { Library::new(lib_name) }.map_err(|e| e.to_string())?;
                $(
                    // SAFETY: o tipo é o protótipo C do símbolo; o ponteiro vale enquanto `lib` viver (no struct).
                    let $name: $ty = *unsafe { lib.get::<$ty>(concat!(stringify!($name), "\0").as_bytes()) }
                        .map_err(|e| e.to_string())?;
                )*
                Ok(Self { _lib: lib, $($name,)* })
            }
        }
    };
}

api! {
    g_main_loop_new: unsafe extern "C" fn(P, c_int) -> P;
    g_main_loop_run: unsafe extern "C" fn(P);
    g_idle_source_new: unsafe extern "C" fn() -> P;
    g_source_set_priority: unsafe extern "C" fn(P, c_int);
    g_source_set_callback: unsafe extern "C" fn(P, *const c_void, P, *const c_void);
    g_source_attach: unsafe extern "C" fn(P, P) -> c_uint;
    g_source_unref: unsafe extern "C" fn(P);
    g_get_monotonic_time: unsafe extern "C" fn() -> i64;
    g_error_free: unsafe extern "C" fn(*mut GError);
    g_object_new: unsafe extern "C" fn(GType, *const c_char, ...) -> P;
    g_signal_connect_data: unsafe extern "C" fn(P, *const c_char, *const c_void, P, *const c_void, c_int) -> c_ulong;
    g_type_check_instance_is_a: unsafe extern "C" fn(P, GType) -> c_int;

    wpe_display_headless_new: unsafe extern "C" fn() -> P;
    wpe_display_connect: unsafe extern "C" fn(P, *mut *mut GError) -> c_int;
    wpe_display_set_primary: unsafe extern "C" fn(P);
    wpe_view_get_toplevel: unsafe extern "C" fn(P) -> P;
    wpe_view_focus_in: unsafe extern "C" fn(P);
    wpe_view_focus_out: unsafe extern "C" fn(P);
    wpe_view_set_visible: unsafe extern "C" fn(P, c_int);
    wpe_view_event: unsafe extern "C" fn(P, P);
    wpe_toplevel_resize: unsafe extern "C" fn(P, c_int, c_int) -> c_int;
    wpe_toplevel_get_scale: unsafe extern "C" fn(P) -> f64;
    wpe_toplevel_scale_changed: unsafe extern "C" fn(P, f64);
    wpe_event_pointer_button_new: unsafe extern "C" fn(c_int, P, c_int, u32, c_uint, c_uint, f64, f64, c_uint) -> P;
    wpe_event_pointer_move_new: unsafe extern "C" fn(c_int, P, c_int, u32, c_uint, f64, f64, f64, f64) -> P;
    wpe_event_scroll_new: unsafe extern "C" fn(P, c_int, u32, c_uint, f64, f64, c_int, c_int, f64, f64) -> P;
    wpe_event_keyboard_new: unsafe extern "C" fn(c_int, P, c_int, u32, c_uint, c_uint, c_uint) -> P;
    wpe_event_unref: unsafe extern "C" fn(P);
    wpe_unicode_to_keyval: unsafe extern "C" fn(u32) -> c_uint;
    wpe_buffer_get_width: unsafe extern "C" fn(P) -> c_int;
    wpe_buffer_get_height: unsafe extern "C" fn(P) -> c_int;
    wpe_buffer_dma_buf_get_type: unsafe extern "C" fn() -> GType;
    wpe_buffer_dma_buf_get_format: unsafe extern "C" fn(P) -> u32;
    wpe_buffer_dma_buf_get_n_planes: unsafe extern "C" fn(P) -> u32;
    wpe_buffer_dma_buf_get_fd: unsafe extern "C" fn(P, u32) -> c_int;
    wpe_buffer_dma_buf_get_offset: unsafe extern "C" fn(P, u32) -> u32;
    wpe_buffer_dma_buf_get_stride: unsafe extern "C" fn(P, u32) -> u32;
    wpe_buffer_dma_buf_get_modifier: unsafe extern "C" fn(P) -> u64;

    webkit_web_view_get_type: unsafe extern "C" fn() -> GType;
    webkit_web_view_get_wpe_view: unsafe extern "C" fn(P) -> P;
    webkit_web_view_get_back_forward_list: unsafe extern "C" fn(P) -> P;
    webkit_web_view_load_uri: unsafe extern "C" fn(P, *const c_char);
    webkit_web_view_go_back: unsafe extern "C" fn(P);
    webkit_web_view_go_forward: unsafe extern "C" fn(P);
    webkit_web_view_reload: unsafe extern "C" fn(P);
    webkit_web_view_get_uri: unsafe extern "C" fn(P) -> *const c_char;
    webkit_web_view_get_title: unsafe extern "C" fn(P) -> *const c_char;
    webkit_web_view_is_loading: unsafe extern "C" fn(P) -> c_int;
    webkit_web_view_can_go_back: unsafe extern "C" fn(P) -> c_int;
    webkit_web_view_can_go_forward: unsafe extern "C" fn(P) -> c_int;
    webkit_network_session_new: unsafe extern "C" fn(*const c_char, *const c_char) -> P;
    webkit_network_session_new_ephemeral: unsafe extern "C" fn() -> P;
    webkit_network_error_quark: unsafe extern "C" fn() -> u32;
    webkit_navigation_policy_decision_get_navigation_action: unsafe extern "C" fn(P) -> P;
    webkit_navigation_action_get_request: unsafe extern "C" fn(P) -> P;
    webkit_uri_request_get_uri: unsafe extern "C" fn(P) -> *const c_char;
    webkit_policy_decision_ignore: unsafe extern "C" fn(P);
}

/// Resolvida uma vez; o erro é o motivo legível (lib ausente, símbolo ausente).
pub fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| Api::open(LIB)).as_ref().map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_library_is_an_error_not_a_panic() {
        let err = Api::open("libdoes-not-exist-hangar.so.1").err().unwrap_or_default();
        assert!(err.contains("libdoes-not-exist-hangar"), "{err}");
    }

    #[test]
    #[ignore = "precisa do WPE WebKit instalado"]
    fn resolves_every_symbol_on_this_machine() {
        api().map(|_| ()).unwrap();
    }
}
