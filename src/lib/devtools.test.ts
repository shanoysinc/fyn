import { describe, expect, it } from "vitest";
import { relative, run, suggest } from "./devtools";

describe("Dev Tools transforms", () => {
  it("formats and minifies JSON, with a clear error for bad JSON", async () => {
    expect((await run("json-format", '{"a":1,"b":[1,2]}')).output).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect((await run("json-minify", '{\n  "a": 1\n}')).output).toBe('{"a":1}');
    const bad = await run("json-format", "{oops}");
    expect(bad.error).toMatch(/^Not valid JSON/);
  });

  it("Base64 round-trips Unicode, accepts URL-safe and unpadded input", async () => {
    const enc = (await run("base64-encode", "héllo 👋")).output;
    expect(enc).toBe("aMOpbGxvIPCfkYs=");
    expect((await run("base64-decode", enc)).output).toBe("héllo 👋");
    expect((await run("base64-decode", "aMOpbGxvIPCfkYs")).output).toBe("héllo 👋");
    expect((await run("base64-decode", "aMOpbGxvIPCfkYs")).error).toBeUndefined();
    expect((await run("base64-decode", "not base64!!")).error).toBeTruthy();
  });

  it("URL encodes and decodes (+ as space)", async () => {
    expect((await run("url-encode", "a b&c=d/é")).output).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect((await run("url-decode", "a+b%26c")).output).toBe("a b&c");
    expect((await run("url-decode", "%E0%A4%A")).error).toBeTruthy();
  });

  it("hashes with SHA-256", async () => {
    expect((await run("sha256", "abc")).output).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("generates UUIDs", async () => {
    const out = (await run("uuid", "3")).output.split("\n");
    expect(out).toHaveLength(3);
    for (const u of out) expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await run("uuid", "")).output.split("\n")).toHaveLength(5);
    expect((await run("uuid", "500")).error).toBeTruthy();
  });

  it("converts timestamps in seconds or milliseconds", async () => {
    const s = (await run("ts-to-date", "1730851200")).output;
    expect(s).toContain("ISO 8601  2024-11-06T00:00:00.000Z");
    expect(s).toContain("Unix ms   1730851200000");
    const ms = (await run("ts-to-date", "1730851200000")).output;
    expect(ms).toContain("2024-11-06T00:00:00.000Z");
    expect((await run("ts-to-date", "yesterday")).error).toBeTruthy();
  });

  it("converts dates to timestamps (empty means now)", async () => {
    expect((await run("date-to-ts", "2024-11-06T00:00:00Z")).output).toContain("Unix      1730851200");
    expect((await run("date-to-ts", "")).output).toContain("Relative  now");
    expect((await run("date-to-ts", "not a date")).error).toBeTruthy();
  });

  it("describes relative times", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(relative(new Date(now - 3 * 86_400_000), now)).toBe("3 days ago");
    expect(relative(new Date(now + 2 * 3600_000), now)).toBe("in 2 hours");
    expect(relative(new Date(now), now)).toBe("now");
  });
});

describe("suggest", () => {
  it.each([
    ['{"a":1}', "json-format"],
    ['{\n  "a": 1\n}', "json-minify"],
    ["1730851200", "ts-to-date"],
    ["1730851200000", "ts-to-date"],
    ["hello%20world", "url-decode"],
    ["SGVsbG8gd29ybGQ=", "base64-decode"],
    ["2026-11-06 14:30", "date-to-ts"],
    ["", "uuid"],
    ["just some text", "base64-encode"],
    ["password", "base64-encode"],
  ])("%j -> %s", (input, tool) => expect(suggest(input)).toBe(tool));
});
