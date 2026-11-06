import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

const score = (q: string, title: string, kw: string[] = []) => fuzzyMatch(q, title, kw)?.score ?? 0;

describe("fuzzyMatch", () => {
  it("returns null for an empty query", () => {
    expect(fuzzyMatch("", "Lock Screen")).toBeNull();
    expect(fuzzyMatch("   ", "Lock Screen")).toBeNull();
  });

  it("highlights a prefix match", () => {
    expect(fuzzyMatch("loc", "Lock Screen")).toEqual({ score: expect.any(Number), matches: [0, 1, 2] });
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("LOCK", "Lock Screen")?.matches).toEqual([0, 1, 2, 3]);
  });

  it("ranks prefix > word prefix > substring > subsequence", () => {
    const prefix = score("dark", "Dark Mode");
    const wordPrefix = score("dark", "Toggle Dark Mode");
    const substring = score("ark", "Toggle Dark Mode");
    const subsequence = score("tdm", "Toggle Dark Mode");
    expect(prefix).toBeGreaterThan(wordPrefix);
    expect(wordPrefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it("keyword matches sit below title word-prefix matches but above subsequences", () => {
    const keyword = score("theme", "Colors Settings", ["theme"]);
    expect(keyword).toBeLessThan(score("dark", "Toggle Dark Mode"));
    expect(keyword).toBeGreaterThan(score("tdm", "Toggle Dark Mode"));
  });

  it("prefers a word-start occurrence over an earlier mid-word one", () => {
    // "set" appears inside "Reset" first, but "Settings" is a word start.
    expect(fuzzyMatch("set", "Reset Settings")?.matches).toEqual([6, 7, 8]);
  });

  it("shorter titles win ties", () => {
    expect(score("sound", "Sound")).toBeGreaterThan(score("sound", "Sound Settings"));
  });

  it("matches keywords without highlighting", () => {
    expect(fuzzyMatch("wifi", "Wi-Fi Settings", ["wifi"])).toEqual({ score: 72, matches: [] });
    expect(fuzzyMatch("wire", "Wi-Fi Settings", ["wireless"])).toEqual({ score: 68, matches: [] });
    expect(fuzzyMatch("less", "Wi-Fi Settings", ["wireless"])).toEqual({ score: 50, matches: [] });
  });

  it("does not promote by keyword on a single letter", () => {
    // Regression: "v" used to match the "volume" keyword strongly enough to beat apps.
    expect(score("v", "Sound Settings", ["volume"])).toBeLessThan(68);
  });

  it("does not match short keyword substrings", () => {
    expect(fuzzyMatch("ol", "Sound Settings", ["volume"])).toBeNull();
  });

  it("matches subsequences across words, highlighting each letter", () => {
    expect(fuzzyMatch("tdm", "Toggle Dark Mode")?.matches).toEqual([0, 7, 12]);
  });

  it("rejects weak scattered subsequences", () => {
    expect(fuzzyMatch("oee", "Toggle Dark Mode")).toBeNull();
    expect(fuzzyMatch("xyz", "Lock Screen")).toBeNull();
  });

  it("ignores spaces in subsequence queries", () => {
    expect(fuzzyMatch("t d m", "Toggle Dark Mode")?.matches).toEqual([0, 7, 12]);
  });
});
