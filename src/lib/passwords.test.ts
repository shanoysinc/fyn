import { describe, expect, it } from "vitest";
import wordlistMap from "diceware-wordlist-en-eff";
import {
  DEFAULT_PASSPHRASE,
  DEFAULT_PASSWORD,
  generatePassphrase,
  generatePassword,
  passphraseBits,
  passwordBits,
  randomInt,
  strength,
} from "./passwords";

const WORDS = Object.values(wordlistMap);

describe("randomInt", () => {
  it("stays in range and rejects the biased top bucket", () => {
    // max 3: limit = floor(2^32/3)*3 = 4294967295, so 0xFFFFFFFF must be rejected.
    const values = [0xffffffff, 7];
    const fake = (b: Uint32Array) => {
      b[0] = values.shift()!;
      return b;
    };
    expect(randomInt(3, fake)).toBe(7 % 3);
    for (let i = 0; i < 500; i++) {
      const n = randomInt(10);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(10);
    }
  });

  it("is roughly uniform", () => {
    const counts = new Array(4).fill(0);
    for (let i = 0; i < 8000; i++) counts[randomInt(4)]++;
    for (const c of counts) expect(c).toBeGreaterThan(1700); // expected 2000
  });
});

describe("generatePassword", () => {
  it("has the requested length and a character from every chosen set", () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ ...DEFAULT_PASSWORD, length: 12 });
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("leaves out look-alike characters when asked", () => {
    const p = Array.from({ length: 50 }, () => generatePassword({ ...DEFAULT_PASSWORD, length: 64 })).join("");
    expect(p).not.toMatch(/[Il1O0o]/);
  });

  it("only uses the chosen sets", () => {
    const p = generatePassword({ length: 40, upper: false, lower: false, digits: true, symbols: false, avoidAmbiguous: false });
    expect(p).toMatch(/^[0-9]{40}$/);
    expect(generatePassword({ ...DEFAULT_PASSWORD, upper: false, lower: false, digits: false, symbols: false })).toBe("");
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword(DEFAULT_PASSWORD)));
    expect(seen.size).toBe(200);
  });
});

describe("generatePassphrase", () => {
  it("uses real words, the separator, capitals and one number", () => {
    const p = generatePassphrase(DEFAULT_PASSPHRASE, WORDS);
    const parts = p.split("-");
    expect(parts).toHaveLength(5);
    for (const part of parts) expect(part[0]).toMatch(/[A-Z]/);
    expect(p.match(/[0-9]/g)).toHaveLength(1);
    for (const part of parts) expect(WORDS).toContain(part.replace(/[0-9]$/, "").toLowerCase());
  });

  it("respects separator and plain words", () => {
    const p = generatePassphrase({ words: 4, separator: " ", capitalize: false, number: false }, WORDS);
    expect(p.split(" ")).toHaveLength(4);
    expect(p).toBe(p.toLowerCase());
    expect(p).not.toMatch(/[0-9]/);
  });

  it("the EFF list has 7,776 words", () => {
    expect(WORDS).toHaveLength(7776);
  });
});

describe("strength", () => {
  it("measures entropy from the method, not the result", () => {
    expect(passwordBits({ ...DEFAULT_PASSWORD, length: 20 })).toBeCloseTo(20 * Math.log2(81), 5);
    expect(passphraseBits({ ...DEFAULT_PASSPHRASE, number: false }, 7776)).toBeCloseTo(5 * Math.log2(7776), 5);
  });

  it("labels and crack times", () => {
    expect(strength(30).label).toBe("Weak");
    expect(strength(30).crackTime).toBe("Instantly");
    expect(strength(50).label).toBe("Fair");
    expect(strength(70).level).toBe(2);
    expect(strength(128).label).toBe("Very strong");
    expect(strength(128).crackTime).toBe("Millennia");
    expect(strength(45).crackTime).toBe("29 minutes");
  });
});
