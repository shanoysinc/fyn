// Dev Tools: small offline text transforms (JSON, Base64, URL, UUID, time, SHA-256).

export type ToolId =
  | "json-format"
  | "json-minify"
  | "base64-encode"
  | "base64-decode"
  | "url-encode"
  | "url-decode"
  | "uuid"
  | "ts-to-date"
  | "date-to-ts"
  | "sha256";

export interface Tool {
  id: ToolId;
  title: string;
  group: "JSON" | "Encode" | "Time" | "Generate";
  /** Shown above an empty input. */
  placeholder: string;
}

export const TOOLS: Tool[] = [
  { id: "json-format", title: "Format JSON", group: "JSON", placeholder: '{"paste":"some JSON"}' },
  { id: "json-minify", title: "Minify JSON", group: "JSON", placeholder: "Pretty JSON to squeeze onto one line" },
  { id: "base64-encode", title: "Base64 Encode", group: "Encode", placeholder: "Text to encode" },
  { id: "base64-decode", title: "Base64 Decode", group: "Encode", placeholder: "SGVsbG8gd29ybGQ=" },
  { id: "url-encode", title: "URL Encode", group: "Encode", placeholder: "a value & more" },
  { id: "url-decode", title: "URL Decode", group: "Encode", placeholder: "a%20value%20%26%20more" },
  { id: "sha256", title: "SHA-256 Hash", group: "Encode", placeholder: "Text to hash" },
  { id: "ts-to-date", title: "Timestamp → Date", group: "Time", placeholder: "1730851200 (seconds or milliseconds)" },
  { id: "date-to-ts", title: "Date → Timestamp", group: "Time", placeholder: "2026-11-06 14:30, or empty for now" },
  { id: "uuid", title: "Generate UUIDs", group: "Generate", placeholder: "How many? (1–50, default 5)" },
];

export interface Result {
  output: string;
  error?: string;
}

const ok = (output: string): Result => ({ output });
const fail = (error: string): Result => ({ output: "", error });

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToUtf8(input: string): string {
  // Accept URL-safe Base64, whitespace, and missing padding.
  let s = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("That isn't Base64");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function describeJsonError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `Not valid JSON: ${msg.replace(/^JSON\.parse: /, "")}`;
}

/** Seconds or milliseconds -> Date. */
function parseTimestamp(input: string): Date | null {
  const t = input.trim();
  if (!/^-?\d{1,16}(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  const ms = Math.abs(n) >= 1e11 ? n : n * 1000; // 1e11 s is the year 5138; ms otherwise
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relative(d: Date, now = Date.now()): string {
  const s = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(s);
  const [n, unit] =
    abs < 60 ? [abs, "second"] : abs < 3600 ? [Math.round(abs / 60), "minute"] : abs < 86_400 ? [Math.round(abs / 3600), "hour"] : abs < 86_400 * 365 ? [Math.round(abs / 86_400), "day"] : [Math.round(abs / (86_400 * 365)), "year"];
  const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return abs < 5 ? "now" : s < 0 ? `${label} ago` : `in ${label}`;
}

function describeDate(d: Date): string {
  return [
    `Local     ${d.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })}`,
    `ISO 8601  ${d.toISOString()}`,
    `Unix      ${Math.floor(d.getTime() / 1000)}`,
    `Unix ms   ${d.getTime()}`,
    `Relative  ${relative(d)}`,
  ].join("\n");
}

export async function run(tool: ToolId, input: string): Promise<Result> {
  try {
    switch (tool) {
      case "json-format":
      case "json-minify": {
        if (!input.trim()) return ok("");
        let value: unknown;
        try {
          value = JSON.parse(input);
        } catch (e) {
          return fail(describeJsonError(e));
        }
        return ok(tool === "json-format" ? JSON.stringify(value, null, 2) : JSON.stringify(value));
      }
      case "base64-encode":
        return ok(utf8ToBase64(input));
      case "base64-decode":
        try {
          return ok(base64ToUtf8(input));
        } catch {
          return fail("That isn't Base64 text");
        }
      case "url-encode":
        return ok(encodeURIComponent(input));
      case "url-decode":
        try {
          return ok(decodeURIComponent(input.replace(/\+/g, " ")));
        } catch {
          return fail("That isn't URL-encoded text");
        }
      case "sha256": {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
        return ok([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
      }
      case "uuid": {
        const n = input.trim() ? Number(input.trim()) : 5;
        if (!Number.isInteger(n) || n < 1 || n > 50) return fail("Enter a number from 1 to 50");
        return ok(Array.from({ length: n }, () => crypto.randomUUID()).join("\n"));
      }
      case "ts-to-date": {
        if (!input.trim()) return ok("");
        const d = parseTimestamp(input);
        return d ? ok(describeDate(d)) : fail("Enter a Unix timestamp in seconds or milliseconds");
      }
      case "date-to-ts": {
        const d = input.trim() ? new Date(input.trim()) : new Date();
        return Number.isNaN(d.getTime()) ? fail("Couldn't read that date") : ok(describeDate(d));
      }
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Something went wrong");
  }
}

/** Guess the most useful tool for what's on the clipboard. */
export function suggest(input: string): ToolId {
  const t = input.trim();
  if (!t) return "uuid";
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return /\n\s/.test(t) ? "json-minify" : "json-format";
    } catch {
      /* not JSON */
    }
  }
  if (/^\d{10}(\d{3})?$/.test(t)) return "ts-to-date";
  if (/%[0-9A-Fa-f]{2}/.test(t)) return "url-decode";
  if (t.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t) && /[0-9+/=]|[a-z][A-Z]/.test(t)) {
    try {
      const decoded = base64ToUtf8(t);
      if (/^[\p{L}\p{N}\p{P}\p{S}\s]+$/u.test(decoded)) return "base64-decode";
    } catch {
      /* not Base64 */
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(t) && !Number.isNaN(Date.parse(t))) return "date-to-ts";
  return "base64-encode";
}
