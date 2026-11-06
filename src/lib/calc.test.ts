import { describe, expect, it } from "vitest";
import { calculate, formatNumber } from "./calc";

const value = (q: string) => calculate(q)?.value;

describe("calculate: arithmetic", () => {
  it.each([
    ["24*1.15", 27.6],
    ["2+3*4", 14],
    ["(2+3)*4", 20],
    ["10 / 4", 2.5],
    ["7 - 10", -3],
    ["0.1+0.2", 0.3], // no floating-point noise
    ["2^10", 1024],
    ["2 ** 10", 1024],
    ["3 × 4", 12],
    ["12 ÷ 4", 3],
  ])("%s = %s", (q, v) => expect(value(q)).toBe(v));

  it("power is right-associative and binds tighter than unary minus", () => {
    expect(value("2^3^2")).toBe(512);
    expect(value("-2^2")).toBe(-4);
    expect(value("(-2)^2")).toBe(4);
  });

  it("supports implicit multiplication", () => {
    expect(value("(1+2)(3+4)")).toBe(21);
    expect(value("3(4+1)")).toBe(15);
    expect(value("2pi")).toBeCloseTo(2 * Math.PI, 9);
  });

  it("supports thousands separators and scientific notation", () => {
    expect(value("1,000*2")).toBe(2000);
    expect(value("1,234,567+1")).toBe(1234568);
    expect(value("1e3*2")).toBe(2000);
  });
});

describe("calculate: percentages", () => {
  it.each([
    ["15% of 80", 12],
    ["200 + 10%", 220],
    ["50 - 10%", 45],
    ["10% + 5", 5.1],
    ["100%", 1],
    ["50% * 4", 2],
  ])("%s = %s", (q, v) => expect(value(q)).toBeCloseTo(v, 10));
});

describe("calculate: functions and constants", () => {
  it.each([
    ["sqrt(16)+1", 5],
    ["sqrt 16 + 1", 5],
    ["abs(-3)*2", 6],
    ["round(2.6)+0", 3],
    ["floor(2.9)*1", 2],
    ["ceil(2.1)*1", 3],
    ["sin(pi/2)", 1],
    ["log(1000)", 3],
    ["ln(e)*1", 1],
    ["5!", 120],
    ["3!+1", 7],
  ])("%s = %s", (q, v) => expect(value(q)).toBeCloseTo(v, 10));
});

describe("calculate: only triggers for real calculations", () => {
  it.each(["42", "-5", "chrome", "e", "pi", "vsc", "word 2", "5 km", "2 3", "", "   ", "1+", "(1+2", "sqrt("])(
    "%j is not a calculation",
    (q) => expect(calculate(q)).toBeNull(),
  );

  it("rejects results that aren't finite numbers", () => {
    expect(calculate("1/0")).toBeNull();
    expect(calculate("10^400")).toBeNull();
    expect(calculate("(-1)!")).toBeNull();
    expect(calculate("2.5!")).toBeNull();
  });

  it("a leading = forces evaluation of a plain number", () => {
    expect(calculate("= 42")?.value).toBe(42);
    expect(calculate("=-5")?.value).toBe(-5);
  });

  it("constants alone need = (so typing 'pi' can still find apps like Pinta)", () => {
    expect(calculate("pi")).toBeNull();
    expect(calculate("tau")).toBeNull();
    expect(calculate("=pi")?.value).toBeCloseTo(Math.PI, 10);
    expect(calculate("pi*2")?.value).toBeCloseTo(2 * Math.PI, 10);
  });

  it("rejects very long input", () => {
    expect(calculate("1+".repeat(150) + "1")).toBeNull();
  });
});

describe("calculate: output", () => {
  it("gives a grouped display value and a plain clipboard value", () => {
    const r = calculate("1000*1234")!;
    expect(r.display).toBe("1,234,000");
    expect(r.copy).toBe("1234000");
    expect(r.expression).toBe("1000*1234");
  });

  it("strips the = prefix from the expression", () => {
    expect(calculate("= 2+2")!.expression).toBe("2+2");
  });

  it("uses exponent notation for huge and tiny numbers", () => {
    expect(calculate("10^25")!.copy).toBe("1e25");
    expect(formatNumber(1e-9)).toBe("1e-9");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-1234.5)).toBe("-1,234.5");
  });
});
