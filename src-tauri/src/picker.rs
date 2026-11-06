//! Screen colour picker ("eyedropper") using plain Win32, so it doesn't depend on the
//! WebView supporting the browser EyeDropper API.
//!
//! Fyn steps out of the way, the next left-click anywhere on screen picks the pixel under
//! the pointer, then Fyn comes back. Low-level hooks capture that click (and Esc /
//! right-click to cancel) so it never reaches the app underneath.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, GetDC, GetPixel, ReleaseDC, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CopyIcon, CreateIconIndirect, DestroyCursor, GetMessageW, GetSystemMetrics,
    KillTimer, LoadCursorW, PostQuitMessage, ICONINFO, SM_CXCURSOR,
    SetSystemCursor, SetTimer, SetWindowsHookExW, SystemParametersInfoW, UnhookWindowsHookEx,
    HCURSOR, HC_ACTION, HICON, IDC_CROSS, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, OCR_APPSTARTING,
    OCR_HAND, OCR_IBEAM, OCR_NORMAL, OCR_SIZEALL, OCR_SIZENESW, OCR_SIZENS, OCR_SIZENWSE,
    OCR_SIZEWE, SPI_SETCURSORS, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    WM_TIMER,
};

use crate::window;

/// Give up if nothing is clicked within this long.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Let the window finish hiding before the user starts clicking.
const HIDE_DELAY: Duration = Duration::from_millis(120);
const VK_ESCAPE: u32 = 0x1B;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    Picked(i32, i32),
    Cancelled,
}

/// Where the press happened; the pick completes on the matching button-up so that the
/// up event is swallowed too (otherwise it would land on the app underneath).
static PRESSED: Mutex<Option<Outcome>> = Mutex::new(None);
static OUTCOME: Mutex<Option<Outcome>> = Mutex::new(None);
static PICKING: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        match wparam.0 as u32 {
            WM_LBUTTONDOWN => {
                *PRESSED.lock().unwrap() = Some(Outcome::Picked(info.pt.x, info.pt.y));
                return LRESULT(1);
            }
            WM_RBUTTONDOWN => {
                *PRESSED.lock().unwrap() = Some(Outcome::Cancelled);
                return LRESULT(1);
            }
            WM_LBUTTONUP | WM_RBUTTONUP => {
                if let Some(outcome) = PRESSED.lock().unwrap().take() {
                    *OUTCOME.lock().unwrap() = Some(outcome);
                    PostQuitMessage(0);
                    return LRESULT(1);
                }
            }
            _ => {}
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        if down && info.vkCode == VK_ESCAPE {
            *OUTCOME.lock().unwrap() = Some(Outcome::Cancelled);
            PostQuitMessage(0);
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Install the hooks on this thread and pump messages until a pick, a cancel or the timeout.
fn wait_for_click() -> Result<Outcome, String> {
    *PRESSED.lock().unwrap() = None;
    *OUTCOME.lock().unwrap() = None;
    unsafe {
        let module = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), Some(module.into()), 0)
            .map_err(|e| format!("Couldn't start the color picker: {e}"))?;
        let keyboard = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), Some(module.into()), 0) {
            Ok(h) => h,
            Err(e) => {
                let _ = UnhookWindowsHookEx(mouse);
                return Err(format!("Couldn't start the color picker: {e}"));
            }
        };
        let timer = SetTimer(None, 0, TIMEOUT.as_millis() as u32, None);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER {
                break;
            }
        }

        let _ = KillTimer(None, timer);
        let _ = UnhookWindowsHookEx(keyboard);
        let _ = UnhookWindowsHookEx(mouse);
    }
    Ok(OUTCOME.lock().unwrap().take().unwrap_or(Outcome::Cancelled))
}

/// Shows a crosshair everywhere on screen while it's alive, then puts the user's own
/// cursors back. (A hidden window can't set the cursor over other apps, so this swaps
/// the system cursors themselves; covering the common shapes — arrow, text, link,
/// resize — means the pointer stays a crosshair wherever it goes.)
struct CrosshairCursor;

impl CrosshairCursor {
    fn show() -> Self {
        unsafe {
            // Our own high-contrast crosshair; fall back to Windows' (white, so hard to see
            // on light backgrounds) only if creating it fails.
            let own = make_crosshair().ok();
            let source = match own {
                Some(c) => Some(HICON(c.0)),
                None => LoadCursorW(None, IDC_CROSS).ok().map(|c| HICON(c.0)),
            };
            if let Some(source) = source {
                for id in [
                    OCR_NORMAL, OCR_IBEAM, OCR_HAND, OCR_APPSTARTING, OCR_SIZEALL,
                    OCR_SIZENS, OCR_SIZEWE, OCR_SIZENWSE, OCR_SIZENESW,
                ] {
                    // SetSystemCursor takes ownership of the handle, so each gets its own copy.
                    if let Ok(copy) = CopyIcon(source) {
                        let _ = SetSystemCursor(HCURSOR(copy.0), id);
                    }
                }
            }
            if let Some(c) = own {
                let _ = DestroyCursor(c);
            }
        }
        Self
    }
}

/// Gap (in pixels) around the centre of the crosshair, so the target pixel stays visible.
const CROSSHAIR_GAP: i32 = 3;

/// Pixels (0xAARRGGBB, top-down) of a `size`×`size` crosshair: 1px black lines with a 1px
/// white outline, so it reads on any background, and a small gap at the centre.
fn crosshair_pixels(size: i32) -> Vec<u32> {
    const BLACK: u32 = 0xFF00_0000;
    const WHITE: u32 = 0xFFFF_FFFF;
    let c = size / 2;
    // Black core: the horizontal and vertical arms, minus the centre gap and a 1px margin
    // at the edges (room for the outline).
    let core = |x: i32, y: i32| -> bool {
        let on_arm = (y == c && (x - c).abs() > CROSSHAIR_GAP) || (x == c && (y - c).abs() > CROSSHAIR_GAP);
        on_arm && (1..size - 1).contains(&x) && (1..size - 1).contains(&y)
    };
    let mut out = vec![0u32; (size * size) as usize];
    for y in 0..size {
        for x in 0..size {
            out[(y * size + x) as usize] = if core(x, y) {
                BLACK
            } else if (-1..=1).any(|dy| (-1..=1).any(|dx| core(x + dx, y + dy))) {
                WHITE
            } else {
                0
            };
        }
    }
    out
}

/// Build the crosshair as a real Windows cursor (32-bit with alpha), hotspot at the centre.
unsafe fn make_crosshair() -> windows::core::Result<HCURSOR> {
    let size = GetSystemMetrics(SM_CXCURSOR).clamp(32, 128);
    let pixels = crosshair_pixels(size);

    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: size,
        biHeight: -size, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let info = BITMAPINFO { bmiHeader: header, ..Default::default() };
    let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
    let color = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
    std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u32, pixels.len());
    // With a 32-bit colour bitmap the alpha channel decides transparency; the mask is unused.
    let mask = CreateBitmap(size, size, 1, 1, None);

    let icon = ICONINFO {
        fIcon: false.into(),
        xHotspot: (size / 2) as u32,
        yHotspot: (size / 2) as u32,
        hbmMask: mask,
        hbmColor: color,
    };
    let cursor = CreateIconIndirect(&icon);
    let _ = DeleteObject(color.into());
    let _ = DeleteObject(mask.into());
    cursor.map(|c| HCURSOR(c.0))
}

impl Drop for CrosshairCursor {
    fn drop(&mut self) {
        restore_cursors();
    }
}

/// Reload the user's configured cursors (also called at startup, in case Fyn was ever
/// killed mid-pick and left the crosshair behind).
pub fn restore_cursors() {
    unsafe {
        let _ = SystemParametersInfoW(SPI_SETCURSORS, 0, None, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
}

/// Colour of the screen pixel at physical coordinates (x, y) as `#RRGGBB`.
fn pixel_hex(x: i32, y: i32) -> Option<String> {
    unsafe {
        let dc = GetDC(None);
        if dc.is_invalid() {
            return None;
        }
        let color = GetPixel(dc, x, y);
        ReleaseDC(None, dc);
        if color.0 == 0xFFFF_FFFF {
            return None; // CLR_INVALID: off-screen or not readable
        }
        Some(colorref_to_hex(color.0))
    }
}

/// COLORREF is 0x00BBGGRR.
fn colorref_to_hex(c: u32) -> String {
    format!("#{:02X}{:02X}{:02X}", c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF)
}

/// Hide Fyn, wait for a click anywhere, and return that pixel's colour (None if cancelled).
/// Hides and re-shows the window directly (not via window::hide/show) so the UI isn't
/// reset to the home screen and the colour picker stays open.
pub fn pick(app: &AppHandle) -> Result<Option<String>, String> {
    if PICKING.swap(true, Ordering::SeqCst) {
        return Err("Already picking a color".into());
    }
    let win = app.get_webview_window("main");
    // Losing focus would normally hide the launcher and reset it.
    window::suspend_auto_hide(true);
    if let Some(w) = &win {
        let _ = w.hide();
    }
    std::thread::sleep(HIDE_DELAY);

    let result = {
        let _crosshair = CrosshairCursor::show(); // normal cursors return when this drops
        wait_for_click()
    }
    .map(|outcome| match outcome {
        Outcome::Picked(x, y) => pixel_hex(x, y),
        Outcome::Cancelled => None,
    });

    if let Some(w) = &win {
        let _ = w.show();
        let _ = w.set_focus();
    }
    window::suspend_auto_hide(false);
    PICKING.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLACK: u32 = 0xFF00_0000;
    const WHITE: u32 = 0xFFFF_FFFF;

    #[test]
    fn crosshair_is_black_outlined_in_white_with_a_clear_centre() {
        let size = 32;
        let px = crosshair_pixels(size);
        let at = |x: i32, y: i32| px[(y * size + x) as usize];
        let c = size / 2;

        // Centre gap: the target pixel itself stays visible (the white outline caps the
        // end of each arm, so the clear area reaches CROSSHAIR_GAP - 1 from the centre).
        assert_eq!(at(c, c), 0);
        assert_eq!(at(c + CROSSHAIR_GAP - 1, c), 0);
        assert_eq!(at(c, c - CROSSHAIR_GAP + 1), 0);
        assert_eq!(at(c + CROSSHAIR_GAP, c), WHITE);
        // Arms are black…
        assert_eq!(at(c + 8, c), BLACK);
        assert_eq!(at(c, c - 8), BLACK);
        // …with white on both sides, so they show on light and dark backgrounds.
        assert_eq!(at(c + 8, c - 1), WHITE);
        assert_eq!(at(c + 8, c + 1), WHITE);
        assert_eq!(at(c - 1, c - 8), WHITE);
        // Away from the lines it's fully transparent.
        assert_eq!(at(2, 2), 0);
        assert_eq!(at(c + 5, c + 5), 0);
        // Nothing but transparent, black and white.
        assert!(px.iter().all(|&p| p == 0 || p == BLACK || p == WHITE));
    }

    #[test]
    fn crosshair_scales_with_cursor_size() {
        for size in [32, 48, 64] {
            let px = crosshair_pixels(size);
            assert_eq!(px.len(), (size * size) as usize);
            let c = size / 2;
            assert_eq!(px[(c * size + c + CROSSHAIR_GAP + 1) as usize], BLACK);
        }
    }

    /// Writes a preview PNG of the crosshair over white, black and a gradient.
    /// Run with: cargo test crosshair_preview -- --ignored (path in FYN_PREVIEW_DIR).
    #[test]
    #[ignore]
    fn crosshair_preview() {
        let dir = std::env::var("FYN_PREVIEW_DIR").unwrap_or_else(|_| ".".into());
        let (size, zoom) = (32i32, 6i32);
        let cursor = crosshair_pixels(size);
        let (w, h) = ((size * 3 * zoom) as u32, (size * zoom) as u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let panel = x / (size * zoom);
                let bg: [u8; 3] = match panel {
                    0 => [255, 255, 255],
                    1 => [0, 0, 0],
                    _ => [(x % 256) as u8, 120, (y % 256) as u8],
                };
                let p = cursor[((y / zoom) * size + (x % (size * zoom)) / zoom) as usize];
                let px = if p >> 24 == 0 { bg } else { [(p >> 16) as u8, (p >> 8) as u8, p as u8] };
                rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        let file = std::fs::File::create(format!("{dir}/crosshair-preview.png")).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&rgba).unwrap();
    }

    #[test]
    fn colorref_is_converted_from_bgr() {
        assert_eq!(colorref_to_hex(0x00ED3A7C), "#7C3AED");
        assert_eq!(colorref_to_hex(0x000000FF), "#FF0000");
        assert_eq!(colorref_to_hex(0x00FF0000), "#0000FF");
        assert_eq!(colorref_to_hex(0x00000000), "#000000");
        assert_eq!(colorref_to_hex(0x00FFFFFF), "#FFFFFF");
    }
}
