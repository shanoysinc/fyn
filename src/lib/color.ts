// Colour parsing and formatting for the colour picker and the inline colour result.

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and hsl()/hsla(). */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255, 3) : 1 };
  }

  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const alpha = parts[3] === undefined ? 1 : parseAlpha(parts[3]);
  if (alpha === null) return null;

  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) =>
      p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p),
    );
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r: clamp(Math.round(r), 0, 255), g: clamp(Math.round(g), 0, 255), b: clamp(Math.round(b), 0, 255), a: alpha };
  }

  const h = parseFloat(parts[0]);
  const sat = parseFloat(parts[1]);
  const light = parseFloat(parts[2]);
  if ([h, sat, light].some((v) => Number.isNaN(v))) return null;
  return { ...hslToRgb(h, clamp(sat, 0, 100), clamp(light, 0, 100)), a: alpha };
}

function parseAlpha(p: string): number | null {
  const v = p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p);
  return Number.isNaN(v) ? null : clamp(v, 0, 1);
}

function round(n: number, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function hslToRgb(h: number, s: number, l: number) {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

export function toHsl({ r, g, b }: Rgb) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();

export function toHex(c: Rgb): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a < 1 ? base + hex2(Math.round(c.a * 255)) : base;
}

export function toRgbString(c: Rgb): string {
  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function toHslString(c: Rgb): string {
  const { h, s, l } = toHsl(c);
  return c.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${c.a})` : `hsl(${h}, ${s}%, ${l}%)`;
}

export interface ColorFormat {
  id: string;
  label: string;
  value: string;
}

export function formatsOf(c: Rgb): ColorFormat[] {
  return [
    { id: "hex", label: "HEX", value: toHex(c) },
    { id: "rgb", label: "RGB", value: toRgbString(c) },
    { id: "hsl", label: "HSL", value: toHslString(c) },
  ];
}

/** Whether light text reads better than dark text on this colour. */
export function isDark(c: Rgb): boolean {
  return (c.r * 299 + c.g * 587 + c.b * 114) / 1000 < 140;
}
