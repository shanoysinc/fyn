// Safe calculator for the search box: a tiny recursive-descent parser (no eval).
//
// Supports + - * / ^ (and ** × ÷), parentheses, implicit multiplication (2pi, 3(4+1)),
// percentages ("15% of 80", "200 + 10%"), factorial, constants and common functions.

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
};

const CONSTS: Record<string, number> = { pi: Math.PI, "π": Math.PI, e: Math.E, tau: Math.PI * 2 };

function tokenize(src: string): Token[] | null {
  const s = src
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/\*\*/g, "^")
    .replace(/(\d),(?=\d{3}\b)/g, "$1"); // 1,000 -> 1000
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[\d.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) return null;
      out.push({ t: "num", v: parseFloat(m[0]) });
      i += m[0].length;
    } else if (/[a-zπ]/i.test(ch)) {
      const m = /^([a-z]+|π)/i.exec(s.slice(i))!;
      out.push({ t: "id", v: m[0].toLowerCase() });
      i += m[0].length;
    } else if ("+-*/^%()!".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
    } else {
      return null;
    }
  }
  return out;
}

class Parser {
  private i = 0;
  /** Set once the input does something beyond a bare (possibly negated) number. */
  interesting = false;
  /** Whether the last parsed term was a bare percentage like "10%". */
  private lastPercent = false;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const v = this.expr();
    if (this.i < this.tokens.length) throw new Error("trailing input");
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }

  private expr(): number {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.tokens[this.i++] as { v: string }).v;
      const right = this.term();
      this.interesting = true;
      // "200 + 10%" means 200 plus 10% of 200.
      const r = this.lastPercent ? left * right : right;
      left = op === "+" ? left + r : left - r;
      this.lastPercent = false;
    }
    return left;
  }

  private term(): number {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        this.i++;
        const right = this.unary();
        left = t.v === "*" ? left * right : left / right;
      } else if (t?.t === "id" && t.v === "of") {
        this.i++;
        left = left * this.unary();
      } else if (t && ((t.t === "op" && t.v === "(") || (t.t === "id" && t.v !== "of"))) {
        // Implicit multiplication: 2pi, 3(4+1), (1+1)(2+2)
        left = left * this.unary();
      } else {
        return left;
      }
      this.interesting = true;
      this.lastPercent = false;
    }
  }

  private unary(): number {
    if (this.isOp("-")) {
      this.i++;
      return -this.unary();
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.i++;
      this.interesting = true;
      this.lastPercent = false;
      return Math.pow(base, this.unary()); // right-associative
    }
    return base;
  }

  private postfix(): number {
    let v = this.primary();
    this.lastPercent = false;
    for (;;) {
      if (this.isOp("%")) {
        this.i++;
        v = v / 100;
        this.lastPercent = true;
      } else if (this.isOp("!")) {
        this.i++;
        v = factorial(v);
        this.lastPercent = false;
      } else {
        return v;
      }
      this.interesting = true;
    }
  }

  private primary(): number {
    const t = this.tokens[this.i++];
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = this.expr();
      if (!this.isOp(")")) throw new Error("missing )");
      this.i++;
      return v;
    }
    if (t.t === "id") {
      this.interesting = true;
      if (t.v in CONSTS) return CONSTS[t.v];
      const fn = FUNCS[t.v];
      if (fn) {
        if (this.isOp("(")) return fn(this.primary());
        return fn(this.unary());
      }
    }
    throw new Error("unexpected token");
  }
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

export interface CalcResult {
  expression: string;
  value: number;
  /** For display, with digit grouping. */
  display: string;
  /** For the clipboard, without grouping. */
  copy: string;
}

/** Evaluate `query` if it looks like a calculation; otherwise null. */
export function calculate(query: string): CalcResult | null {
  let src = query.trim();
  const forced = src.startsWith("=");
  if (forced) src = src.slice(1).trim();
  // Need a digit unless forced with "=": typing "pi" is far more likely the start of an
  // app name (Pinta, Pinterest) than a request for π.
  if (!src || src.length > 200 || (!forced && !/\d/.test(src))) return null;

  const tokens = tokenize(src);
  if (!tokens || tokens.length === 0) return null;
  try {
    const parser = new Parser(tokens);
    const value = parser.parse();
    if (!Number.isFinite(value) || (!parser.interesting && !forced)) return null;
    const clean = Number(value.toPrecision(12));
    return { expression: src, value: clean, display: formatNumber(clean), copy: plain(clean) };
  } catch {
    return null;
  }
}

function plain(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e21 || abs < 1e-7)) return n.toExponential().replace("e+", "e");
  return String(n);
}

export function formatNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-7)) return plain(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: 10 });
}
