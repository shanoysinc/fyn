//! Icon extraction + on-disk PNG cache.
//!
//! Icons are rendered once through the shell (`IShellItemImageFactory`, which handles
//! .lnk, .url and packaged apps uniformly) and saved as PNG files under
//! `%LOCALAPPDATA%\dev.fyn.launcher\icons`. The UI loads them through the asset protocol.

use std::ffi::c_void;
use std::path::{Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
};

use crate::indexer::App;
use crate::win::{fnv1a, wide, ComGuard};

const ICON_SIZE: i32 = 64;
const WORKERS: usize = 4;

pub fn icon_path(dir: &Path, app: &App) -> PathBuf {
    let key = fnv1a(&[app.id.as_bytes(), &app.stamp.to_le_bytes()]);
    dir.join(format!("{key:016x}.png"))
}

/// Point every app at its cached icon if one already exists on disk.
pub fn attach_cached(dir: &Path, apps: &mut [App]) {
    for app in apps.iter_mut() {
        let path = icon_path(dir, app);
        app.icon = path.is_file().then(|| path.to_string_lossy().into_owned());
    }
}

/// Extract icons for apps that don't have one yet, in parallel. Returns how many were added.
pub fn extract_missing(dir: &Path, apps: &mut [App]) -> usize {
    let missing: Vec<usize> = (0..apps.len()).filter(|&i| apps[i].icon.is_none()).collect();
    if missing.is_empty() {
        return 0;
    }

    let jobs: Vec<(usize, String, PathBuf)> = missing
        .iter()
        .map(|&i| (i, apps[i].launch.clone(), icon_path(dir, &apps[i])))
        .collect();
    let chunk = jobs.len().div_ceil(WORKERS);

    let done: Vec<(usize, String)> = std::thread::scope(|s| {
        let handles: Vec<_> = jobs
            .chunks(chunk)
            .map(|batch| {
                s.spawn(move || {
                    let _com = ComGuard::new();
                    batch
                        .iter()
                        .filter_map(|(i, src, out)| {
                            extract(src, out).ok()?;
                            Some((*i, out.to_string_lossy().into_owned()))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });

    let added = done.len();
    for (i, path) in done {
        apps[i].icon = Some(path);
    }
    added
}

/// Render `parsing_name` (file path or `shell:AppsFolder\…`) to a PNG at `out`.
fn extract(parsing_name: &str, out: &Path) -> Result<(), String> {
    unsafe {
        let name = wide(parsing_name);
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None).map_err(|e| e.to_string())?;
        let hbm = factory
            .GetImage(
                SIZE { cx: ICON_SIZE, cy: ICON_SIZE },
                SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
            )
            .map_err(|e| e.to_string())?;
        let result = write_png(hbm, out);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        result
    }
}

unsafe fn write_png(hbm: HBITMAP, out: &Path) -> Result<(), String> {
    let mut bm = BITMAP::default();
    if GetObjectW(
        HGDIOBJ(hbm.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut c_void),
    ) == 0
    {
        return Err("GetObject failed".into());
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    if w <= 0 || h <= 0 {
        return Err("empty bitmap".into());
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut px = vec![0u8; (w * h * 4) as usize];
    let hdc = CreateCompatibleDC(None);
    let lines = GetDIBits(
        hdc,
        hbm,
        0,
        h as u32,
        Some(px.as_mut_ptr() as *mut c_void),
        &mut info,
        DIB_RGB_COLORS,
    );
    let _ = DeleteDC(hdc);
    if lines == 0 {
        return Err("GetDIBits failed".into());
    }

    // BGRA (premultiplied) -> straight RGBA. Bitmaps without any alpha are fully opaque.
    let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        if !has_alpha {
            p[3] = 255;
        } else if p[3] != 0 && p[3] != 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }

    let tmp = out.with_extension("tmp");
    {
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&px).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())
}
