//! Win32 clipboard access for clipboard history.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
use zeroize::{Zeroize, Zeroizing};

use super::image::{decode_png, dib_to_rgba, rgba_to_dib, Rgba, MAX_PIXELS, MAX_PNG_BYTES};

const UNICODE_TEXT: u32 = CF_UNICODETEXT.0 as u32;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;
/// A DIB of MAX_PIXELS at 32 bits per pixel, plus headers.
const MAX_DIB_BYTES: usize = (MAX_PIXELS as usize) * 4 + 4096;

/// Sequence number after Fyn's own last write, so the monitor doesn't record it again.
static OWN_SEQUENCE: AtomicU32 = AtomicU32::new(0);

pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

pub fn is_own_change(seq: u32) -> bool {
    seq != 0 && OWN_SEQUENCE.load(Ordering::SeqCst) == seq
}

/// Holds the clipboard open; closes it when dropped.
struct Opened;

impl Opened {
    /// Other apps hold the clipboard briefly while writing, so retry a few times.
    fn open(owner: Option<HWND>) -> Result<Self, String> {
        for attempt in 0..10 {
            if unsafe { OpenClipboard(owner) }.is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(10 + attempt * 10));
        }
        Err("The clipboard is busy. Try again".into())
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn format(name: PCWSTR) -> u32 {
    unsafe { RegisterClipboardFormatW(name) }
}

/// What's on the clipboard right now, if clipboard history may look at it.
pub enum Read {
    Text(Zeroizing<String>),
    /// An image (only read when images are wanted). `png` is the copying app's own PNG
    /// when it provided one (better quality, smaller); otherwise Fyn encodes `image`.
    Image { image: Rgba, png: Option<Vec<u8>> },
    /// The copying app asked monitors not to record this (password managers do).
    Excluded,
    /// Nothing usable (files, an unsupported format, an image when images are off, …).
    Nothing,
}

/// Read the clipboard. Text wins when both text and an image are on it (apps like Word
/// put a picture of the text alongside it). Images are only read if `images` is true.
pub fn read(owner: HWND, images: bool) -> Result<Read, String> {
    let _open = Opened::open(Some(owner))?;
    unsafe {
        // Signals set by password managers and other privacy-aware apps; Windows'
        // own clipboard history (Win+V) honours the same ones.
        for name in [w!("ExcludeClipboardContentFromMonitorProcessing"), w!("Clipboard Viewer Ignore")] {
            if IsClipboardFormatAvailable(format(name)).is_ok() {
                return Ok(Read::Excluded);
            }
        }
        let history_flag = format(w!("CanIncludeInClipboardHistory"));
        if IsClipboardFormatAvailable(history_flag).is_ok() {
            if let Ok(h) = GetClipboardData(history_flag) {
                if read_dword(h) == Some(0) {
                    return Ok(Read::Excluded);
                }
            }
        }

        let text = if IsClipboardFormatAvailable(UNICODE_TEXT).is_ok() {
            GetClipboardData(UNICODE_TEXT).ok().and_then(|h| read_wide(h))
        } else {
            None
        };
        // Text wins (Word and Excel put a picture of the text alongside it), except when
        // it's empty or just a link: browsers' "Copy image" can add the image's address.
        let text_is_the_point = text.as_ref().is_some_and(|t| !text_is_incidental(t));
        if !images || text_is_the_point {
            return Ok(text.map(Read::Text).unwrap_or(Read::Nothing));
        }
        if let Some(image) = read_image() {
            return Ok(image);
        }
        Ok(text.map(Read::Text).unwrap_or(Read::Nothing))
    }
}

/// Text that comes along with an image rather than being what was copied: empty, or a
/// single link (an image's web address).
fn text_is_incidental(text: &str) -> bool {
    let t = text.trim();
    t.is_empty() || (!t.contains(char::is_whitespace) && (t.starts_with("http://") || t.starts_with("https://") || t.starts_with("data:image/")))
}

/// The image on the (already open) clipboard: the app's own PNG if it gave one (keeps
/// transparency), otherwise a bitmap format.
unsafe fn read_image() -> Option<Read> {
    let png_format = format(w!("PNG"));
    if IsClipboardFormatAvailable(png_format).is_ok() {
        let png = GetClipboardData(png_format).ok().and_then(|h| read_bytes(h, MAX_PNG_BYTES));
        if let Some(image) = png.as_deref().and_then(decode_png) {
            return Some(Read::Image { image, png });
        }
    }
    for dib_format in [CF_DIBV5, CF_DIB] {
        if IsClipboardFormatAvailable(dib_format).is_ok() {
            let dib = GetClipboardData(dib_format).ok().and_then(|h| read_bytes(h, MAX_DIB_BYTES));
            if let Some(image) = dib.as_deref().and_then(dib_to_rgba) {
                return Some(Read::Image { image, png: None });
            }
        }
    }
    None
}

/// Copy a clipboard memory block, refusing ones larger than `max` bytes.
unsafe fn read_bytes(handle: HANDLE, max: usize) -> Option<Vec<u8>> {
    let mem = HGLOBAL(handle.0);
    let size = GlobalSize(mem);
    if size == 0 || size > max {
        return None;
    }
    let ptr = GlobalLock(mem) as *const u8;
    if ptr.is_null() {
        return None;
    }
    let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
    let _ = GlobalUnlock(mem);
    Some(bytes)
}

unsafe fn read_dword(handle: HANDLE) -> Option<u32> {
    let mem = HGLOBAL(handle.0);
    if GlobalSize(mem) < 4 {
        return None;
    }
    let ptr = GlobalLock(mem) as *const u32;
    if ptr.is_null() {
        return None;
    }
    let value = ptr.read_unaligned();
    let _ = GlobalUnlock(mem);
    Some(value)
}

unsafe fn read_wide(handle: HANDLE) -> Option<Zeroizing<String>> {
    let mem = HGLOBAL(handle.0);
    let max = GlobalSize(mem) / 2;
    let ptr = GlobalLock(mem) as *const u16;
    if ptr.is_null() {
        return None;
    }
    let units = std::slice::from_raw_parts(ptr, max);
    let len = units.iter().position(|&u| u == 0).unwrap_or(max);
    let text = Zeroizing::new(String::from_utf16_lossy(&units[..len]));
    let _ = GlobalUnlock(mem);
    Some(text)
}

/// Put an image on the clipboard as PNG (browsers, chat apps) and as a bitmap (Paint,
/// Office, everything else).
pub fn write_image(png: &[u8], image: &Rgba) -> Result<(), String> {
    let _open = Opened::open(None)?;
    unsafe {
        EmptyClipboard().map_err(|e| e.to_string())?;
        set_bytes(format(w!("PNG")), png)?;
        set_bytes(CF_DIB, &rgba_to_dib(image))?;
    }
    drop(_open);
    OWN_SEQUENCE.store(sequence(), Ordering::SeqCst);
    Ok(())
}

/// Put `text` on the clipboard (pasting a history item back).
pub fn write(text: &str) -> Result<(), String> {
    let _open = Opened::open(None)?;
    unsafe {
        EmptyClipboard().map_err(|e| e.to_string())?;
        let mut wide: Zeroizing<Vec<u16>> = Zeroizing::new(text.encode_utf16().chain(std::iter::once(0)).collect());
        set_bytes(UNICODE_TEXT, std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2))?;
        wide.zeroize();
    }
    drop(_open);
    OWN_SEQUENCE.store(sequence(), Ordering::SeqCst);
    Ok(())
}

unsafe fn set_bytes(format: u32, bytes: &[u8]) -> Result<(), String> {
    let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| e.to_string())?;
    let ptr = GlobalLock(mem) as *mut u8;
    if ptr.is_null() {
        return Err("Out of memory".into());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    let _ = GlobalUnlock(mem);
    // On success the clipboard owns the memory.
    SetClipboardData(format, Some(HANDLE(mem.0))).map(|_| ()).map_err(|e| e.to_string())
}

/// Empty the clipboard, but only if it still holds what was there at `seq` (so we never
/// wipe something the user copied since).
pub fn clear_if_unchanged(seq: u32) {
    if sequence() != seq {
        return;
    }
    if let Ok(_open) = Opened::open(None) {
        if sequence() == seq {
            let _ = unsafe { EmptyClipboard() };
        }
    }
}

/// File name of the app in the foreground (e.g. "keepassxc.exe"), lower-case.
pub fn foreground_app() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(|f| f.to_lowercase())
    }
}

/// Press Ctrl+V in whatever app now has focus.
pub fn send_paste() {
    const VK_V: VIRTUAL_KEY = VIRTUAL_KEY(0x56);
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::DataExchange::{EnumClipboardFormats, GetClipboardFormatNameW};

    #[test]
    fn text_alongside_an_image_only_wins_when_it_is_real_text() {
        for incidental in ["", "   \n", "https://example.com/cat.png", "http://x.y/a?b=c", "data:image/png;base64,AAAA"] {
            assert!(text_is_incidental(incidental), "{incidental:?}");
        }
        for real in ["Quarterly results", "see https://example.com", "A1\tB1", "example.com"] {
            assert!(!text_is_incidental(real), "{real:?}");
        }
    }

    /// Diagnostic: what's on the clipboard right now, and what clipboard history reads.
    /// Run with: cargo test read_current_clipboard -- --ignored --nocapture
    #[test]
    #[ignore]
    fn read_current_clipboard() {
        {
            let _open = Opened::open(None).unwrap();
            let mut fmt = 0;
            loop {
                fmt = unsafe { EnumClipboardFormats(fmt) };
                if fmt == 0 {
                    break;
                }
                let mut name = [0u16; 128];
                let len = unsafe { GetClipboardFormatNameW(fmt, &mut name) };
                println!("format {fmt}: {}", String::from_utf16_lossy(&name[..len.max(0) as usize]));
            }
        }
        match read(HWND::default(), true) {
            Ok(Read::Text(t)) => println!("=> text ({} chars)", t.chars().count()),
            Ok(Read::Image { image, png }) => {
                println!("=> image {}x{} (app PNG: {})", image.width, image.height, png.is_some())
            }
            Ok(Read::Excluded) => println!("=> excluded"),
            Ok(Read::Nothing) => println!("=> nothing"),
            Err(e) => println!("=> error {e}"),
        }
    }
}
