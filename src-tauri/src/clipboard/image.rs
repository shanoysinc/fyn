//! Image handling for clipboard history: Windows DIBs <-> RGBA <-> PNG, thumbnails and
//! data URLs for the UI. Pure functions (no Win32 calls), so they're unit-tested.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// Images bigger than this many pixels (≈ 8K × 5K) aren't kept.
pub const MAX_PIXELS: u64 = 40_000_000;
/// Encoded images bigger than this aren't kept.
pub const MAX_PNG_BYTES: usize = 20 * 1024 * 1024;
/// Longest side of the thumbnail shown in the list.
pub const THUMB_SIZE: u32 = 96;

/// Decoded image: 8-bit RGBA, rows top to bottom.
#[derive(Debug, Clone, PartialEq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Rgba {
    fn checked(width: u32, height: u32, pixels: Vec<u8>) -> Option<Self> {
        let ok = width > 0
            && height > 0
            && u64::from(width) * u64::from(height) <= MAX_PIXELS
            && pixels.len() == width as usize * height as usize * 4;
        ok.then_some(Self { width, height, pixels })
    }
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn i32_at(b: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;

/// Parse a packed DIB (CF_DIB / CF_DIBV5 clipboard data). Supports the 24- and 32-bit
/// layouts screenshots and apps actually use; anything else returns None.
pub fn dib_to_rgba(dib: &[u8]) -> Option<Rgba> {
    let header = u32_at(dib, 0)? as usize;
    if header < 40 {
        return None;
    }
    let width = i32_at(dib, 4)?;
    let raw_height = i32_at(dib, 8)?;
    let bits = u16_at(dib, 14)?;
    let compression = u32_at(dib, 16)?;
    let colors_used = u32_at(dib, 32)? as usize;
    if width <= 0 || raw_height == 0 || !(bits == 24 || bits == 32) {
        return None;
    }
    if !(compression == BI_RGB || (compression == BI_BITFIELDS && bits == 32)) {
        return None;
    }
    // With BI_BITFIELDS, 32-bit pixels must use the standard BGRA layout.
    // Colour masks follow a 40-byte header, and sit at the same offset inside V4/V5 headers.
    let masks_at = 40;
    if compression == BI_BITFIELDS {
        let masks = (u32_at(dib, masks_at)?, u32_at(dib, masks_at + 4)?, u32_at(dib, masks_at + 8)?);
        if masks != (0x00FF_0000, 0x0000_FF00, 0x0000_00FF) {
            return None;
        }
    }
    let has_alpha_mask = header >= 56 && u32_at(dib, 52)? == 0xFF00_0000;

    let (width, top_down, height) = (width as u32, raw_height < 0, raw_height.unsigned_abs());
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return None;
    }
    let mask_bytes = if compression == BI_BITFIELDS && header == 40 { 12 } else { 0 };
    let offset = header + mask_bytes + colors_used * 4;
    let stride = (width as usize * bits as usize).div_ceil(32) * 4;
    let data = dib.get(offset..offset + stride * height as usize)?;

    let bpp = bits as usize / 8;
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height as usize {
        let src_row = if top_down { y } else { height as usize - 1 - y };
        let row = &data[src_row * stride..src_row * stride + width as usize * bpp];
        for px in row.chunks_exact(bpp) {
            let alpha = if bpp == 4 { px[3] } else { 255 };
            pixels.extend_from_slice(&[px[2], px[1], px[0], alpha]);
        }
    }
    // 32-bit BI_RGB usually leaves alpha at 0 meaning "unused": treat as opaque.
    if bpp == 4 && !has_alpha_mask && pixels.chunks_exact(4).all(|p| p[3] == 0) {
        pixels.chunks_exact_mut(4).for_each(|p| p[3] = 255);
    }
    Rgba::checked(width, height, pixels)
}

/// A packed 32-bit bottom-up DIB (BITMAPINFOHEADER + BGRA pixels), for CF_DIB.
pub fn rgba_to_dib(img: &Rgba) -> Vec<u8> {
    let (w, h) = (img.width as usize, img.height as usize);
    let mut out = Vec::with_capacity(40 + w * h * 4);
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(img.width as i32).to_le_bytes());
    out.extend_from_slice(&(img.height as i32).to_le_bytes()); // positive = bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bit count
    out.extend_from_slice(&BI_RGB.to_le_bytes());
    out.extend_from_slice(&((w * h * 4) as u32).to_le_bytes()); // image size
    out.extend_from_slice(&[0u8; 16]); // resolution, colours used/important
    for y in (0..h).rev() {
        for px in img.pixels[y * w * 4..(y + 1) * w * 4].chunks_exact(4) {
            out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }
    out
}

pub fn encode_png(img: &Rgba) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width, img.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&img.pixels).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub fn decode_png(bytes: &[u8]) -> Option<Rgba> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    {
        let info = reader.info();
        if u64::from(info.width) * u64::from(info.height) > MAX_PIXELS {
            return None;
        }
    }
    let mut buf = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buf).ok()?;
    let data = &buf[..frame.buffer_size()];
    let pixels: Vec<u8> = match frame.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => data.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return None, // expanded by normalize_to_color8
    };
    Rgba::checked(frame.width, frame.height, pixels)
}

/// Scale down (never up) so the longest side is at most `max`, averaging pixels.
pub fn thumbnail(img: &Rgba, max: u32) -> Rgba {
    let scale = (max as f64 / img.width.max(img.height) as f64).min(1.0);
    let tw = ((img.width as f64 * scale).round() as u32).max(1);
    let th = ((img.height as f64 * scale).round() as u32).max(1);
    let mut pixels = Vec::with_capacity(tw as usize * th as usize * 4);
    for ty in 0..th {
        let (y0, y1) = span(ty, th, img.height);
        for tx in 0..tw {
            let (x0, x1) = span(tx, tw, img.width);
            let mut sum = [0u64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y as usize * img.width as usize + x as usize) * 4;
                    for (s, &v) in sum.iter_mut().zip(&img.pixels[i..i + 4]) {
                        *s += u64::from(v);
                    }
                }
            }
            let n = u64::from((x1 - x0) * (y1 - y0));
            pixels.extend(sum.iter().map(|s| (s / n) as u8));
        }
    }
    Rgba { width: tw, height: th, pixels }
}

/// Source range covered by target pixel `t` of `target` when scaling `source` down.
fn span(t: u32, target: u32, source: u32) -> (u32, u32) {
    let start = (u64::from(t) * u64::from(source) / u64::from(target)) as u32;
    let end = ((u64::from(t + 1) * u64::from(source)).div_ceil(u64::from(target)) as u32).max(start + 1);
    (start, end.min(source))
}

pub fn png_data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×2: red, green / blue, half-transparent white.
    fn sample() -> Rgba {
        Rgba {
            width: 2,
            height: 2,
            pixels: vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128],
        }
    }

    #[test]
    fn png_round_trip() {
        let img = sample();
        let png = encode_png(&img).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(decode_png(&png).unwrap(), img);
    }

    #[test]
    fn dib_round_trip_bottom_up_32_bit() {
        let img = sample();
        let dib = rgba_to_dib(&img);
        assert_eq!(dib.len(), 40 + 2 * 2 * 4);
        assert_eq!(dib_to_rgba(&dib).unwrap(), img);
    }

    #[test]
    fn dib_24_bit_with_row_padding_and_top_down() {
        // 1×2, 24-bit: each row is 3 bytes + 1 padding. Top-down (negative height).
        let mut dib = rgba_to_dib(&Rgba { width: 1, height: 1, pixels: vec![0; 4] })[..40].to_vec();
        dib[8..12].copy_from_slice(&(-2i32).to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 255, 0]); // row 0: red (BGR) + pad
        dib.extend_from_slice(&[255, 0, 0, 0]); // row 1: blue + pad
        let img = dib_to_rgba(&dib).unwrap();
        assert_eq!((img.width, img.height), (1, 2));
        assert_eq!(img.pixels, vec![255, 0, 0, 255, 0, 0, 255, 255]);
    }

    #[test]
    fn dib_with_unused_alpha_is_opaque() {
        let mut dib = rgba_to_dib(&sample());
        for i in (40..dib.len()).step_by(4) {
            dib[i + 3] = 0; // apps often leave alpha at 0 in 32-bit BI_RGB
        }
        assert!(dib_to_rgba(&dib).unwrap().pixels.chunks_exact(4).all(|p| p[3] == 255));
    }

    #[test]
    fn unsupported_or_broken_dibs_are_rejected() {
        let good = rgba_to_dib(&sample());
        assert!(dib_to_rgba(&good[..50]).is_none(), "truncated");
        let mut eight_bit = good.clone();
        eight_bit[14..16].copy_from_slice(&8u16.to_le_bytes());
        assert!(dib_to_rgba(&eight_bit).is_none(), "palette images");
        let mut huge = good.clone();
        huge[4..8].copy_from_slice(&100_000i32.to_le_bytes());
        huge[8..12].copy_from_slice(&100_000i32.to_le_bytes());
        assert!(dib_to_rgba(&huge).is_none(), "too many pixels");
        assert!(dib_to_rgba(&[]).is_none());
    }

    #[test]
    fn thumbnails_keep_aspect_ratio_and_average_colours() {
        let wide = Rgba { width: 400, height: 100, pixels: vec![200; 400 * 100 * 4] };
        let t = thumbnail(&wide, 96);
        assert_eq!((t.width, t.height), (96, 24));
        assert!(t.pixels.iter().all(|&v| v == 200));

        // A 2×2 checkerboard of black and white averages to grey.
        let check = Rgba { width: 2, height: 2, pixels: vec![0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255] };
        assert_eq!(thumbnail(&check, 1).pixels, vec![127, 127, 127, 255]);

        // Small images aren't scaled up.
        let small = sample();
        assert_eq!(thumbnail(&small, 96), small);
    }

    #[test]
    fn data_url() {
        assert_eq!(png_data_url(b"hi"), "data:image/png;base64,aGk=");
    }
}
