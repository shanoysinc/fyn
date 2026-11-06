import { describe, expect, it } from "vitest";
import { formatsOf, isDark, parseColor, toHex, toHsl, toHslString, toRgbString } from "./color";

describe("parseColor", () => {
  it("parses hex in every length", () => {
    expect(parseColor("#7c3aed")).toEqual({ r: 124, g: 58, b: 237, a: 1 });
    expect(parseColor("#7C3AED")).toEqual({ r: 124, g: 58, b: 237, a: 1 });
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#f008")).toEqual({ r: 255, g: 0, b: 0, a: 0.533 });
    expect(parseColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 0.502 });
    expect(parseColor("  #fff  ")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("parses rgb()/rgba() with commas, spaces, slashes and percentages", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgb(10 20 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(100%, 0%, 50%)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
  });

  it("clamps out-of-range channels", () => {
    expect(parseColor("rgb(300, -5, 20)")).toEqual({ r: 255, g: 0, b: 20, a: 1 });
    expect(parseColor("rgba(0,0,0,2)")?.a).toBe(1);
  });

  it("parses hsl()/hsla()", () => {
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hsl(120deg 100% 25%)")).toEqual({ r: 0, g: 128, b: 0, a: 1 });
    expect(parseColor("hsla(240, 100%, 50%, 0.25)")).toEqual({ r: 0, g: 0, b: 255, a: 0.25 });
    expect(parseColor("hsl(-120, 100%, 50%)")).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  it.each(["", "#", "#12", "#12345", "#ggg", "red", "rgb(1,2)", "rgb(a,b,c)", "hsl(1,2,3,4,5)", "rgb(1,2,3"])(
    "rejects %j",
    (s) => expect(parseColor(s)).toBeNull(),
  );
});

describe("formatting", () => {
  const purple = { r: 124, g: 58, b: 237, a: 1 };

  it("formats HEX, RGB and HSL", () => {
    expect(toHex(purple)).toBe("#7C3AED");
    expect(toRgbString(purple)).toBe("rgb(124, 58, 237)");
    expect(toHsl(purple)).toEqual({ h: 262, s: 83, l: 58 });
    expect(toHslString(purple)).toBe("hsl(262, 83%, 58%)");
  });

  it("includes alpha only when the colour is translucent", () => {
    const half = { ...purple, a: 0.5 };
    expect(toHex(half)).toBe("#7C3AED80");
    expect(toRgbString(half)).toBe("rgba(124, 58, 237, 0.5)");
    expect(toHslString(half)).toBe("hsla(262, 83%, 58%, 0.5)");
  });

  it("round-trips through hex", () => {
    for (const hex of ["#000000", "#FFFFFF", "#7C3AED", "#12AB34"]) {
      expect(toHex(parseColor(hex)!)).toBe(hex);
    }
  });

  it("round-trips through hsl within rounding", () => {
    const c = parseColor(toHslString(purple))!;
    expect(Math.abs(c.r - purple.r)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.g - purple.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(c.b - purple.b)).toBeLessThanOrEqual(2);
  });

  it("greys have zero hue and saturation", () => {
    expect(toHsl({ r: 128, g: 128, b: 128, a: 1 })).toEqual({ h: 0, s: 0, l: 50 });
  });

  it("lists the three formats in order", () => {
    expect(formatsOf(purple).map((f) => f.id)).toEqual(["hex", "rgb", "hsl"]);
  });

  it("picks readable text colour", () => {
    expect(isDark({ r: 0, g: 0, b: 0, a: 1 })).toBe(true);
    expect(isDark({ r: 255, g: 255, b: 255, a: 1 })).toBe(false);
    expect(isDark(purple)).toBe(true);
  });
});
