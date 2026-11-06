// Password and passphrase generation. Uses the browser's cryptographic random generator
// (crypto.getRandomValues) with rejection sampling, so every character / word is
// equally likely: no modulo bias.

export interface PasswordOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** Leave out characters that are easy to confuse: I l 1 O 0 o */
  avoidAmbiguous: boolean;
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  /** Add one digit to a random word. */
  number: boolean;
}

export const DEFAULT_PASSWORD: PasswordOptions = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
};

export const DEFAULT_PASSPHRASE: PassphraseOptions = { words: 5, separator: "-", capitalize: true, number: true };

const SETS = {
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/~",
} as const;
const AMBIGUOUS = new Set("Il1O0o");

/** Uniform random integer in [0, max). */
export function randomInt(
  max: number,
  random: (buf: Uint32Array) => Uint32Array = (b) => {
    const bytes = new Uint32Array(new ArrayBuffer(b.byteLength));
    crypto.getRandomValues(bytes);
    b.set(bytes);
    return b;
  },
): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new Error("bad range");
  // Reject values from the incomplete top bucket so every result is equally likely.
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    const x = random(buf)[0];
    if (x < limit) return x % max;
  }
}

function charSets(o: PasswordOptions): string[] {
  return (["upper", "lower", "digits", "symbols"] as const)
    .filter((k) => o[k])
    .map((k) => [...SETS[k]].filter((c) => !(o.avoidAmbiguous && AMBIGUOUS.has(c))).join(""));
}

export function generatePassword(o: PasswordOptions): string {
  const sets = charSets(o);
  if (sets.length === 0) return "";
  const pool = sets.join("");
  const length = Math.max(o.length, sets.length);
  // At least one from each chosen set, the rest from all of them, then shuffle.
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(pool[randomInt(pool.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function generatePassphrase(o: PassphraseOptions, wordlist: readonly string[]): string {
  if (wordlist.length === 0) return "";
  const words = Array.from({ length: o.words }, () => {
    const w = wordlist[randomInt(wordlist.length)];
    return o.capitalize ? w[0].toUpperCase() + w.slice(1) : w;
  });
  if (o.number && words.length) {
    const i = randomInt(words.length);
    words[i] += String(randomInt(10));
  }
  return words.join(o.separator);
}

/** Bits of entropy: how many guesses (2^bits) an attacker who knows the method needs. */
export function passwordBits(o: PasswordOptions): number {
  const pool = charSets(o).join("").length;
  return pool ? Math.max(o.length, 1) * Math.log2(pool) : 0;
}

export function passphraseBits(o: PassphraseOptions, wordCount: number): number {
  if (!wordCount) return 0;
  const words = o.words * Math.log2(wordCount);
  return o.number ? words + Math.log2(10 * o.words) : words;
}

export interface Strength {
  /** 0–3, for a 4-segment meter. */
  level: 0 | 1 | 2 | 3;
  label: "Weak" | "Fair" | "Strong" | "Very strong";
  /** How long an offline attack at 10 billion guesses a second would take, on average. */
  crackTime: string;
}

export function strength(bits: number): Strength {
  const level = bits < 45 ? 0 : bits < 64 ? 1 : bits < 90 ? 2 : 3;
  const label = (["Weak", "Fair", "Strong", "Very strong"] as const)[level];
  return { level, label, crackTime: crackTime(bits) };
}

function crackTime(bits: number): string {
  const seconds = 2 ** bits / 2 / 1e10;
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [365, "day"],
    [100, "year"],
    [10, "century"],
  ];
  if (seconds < 1) return "Instantly";
  let value = seconds;
  for (const [size, unit] of units) {
    if (value < size) {
      const n = Math.round(value);
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
    value /= size;
  }
  return "Millennia";
}

/** For colouring a password: letters, digits and symbols look different. */
export function charKind(c: string): "letter" | "digit" | "symbol" {
  return /[0-9]/.test(c) ? "digit" : /[A-Za-z]/.test(c) ? "letter" : "symbol";
}
