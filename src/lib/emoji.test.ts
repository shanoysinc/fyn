import { describe, expect, it } from "vitest";
import { EMOJI, GROUPS, emojiByChar, searchEmoji } from "./emoji";

describe("emoji catalogue", () => {
  it("loads the full set with names, groups and keywords", () => {
    expect(EMOJI.length).toBeGreaterThan(1500);
    expect(GROUPS).toContain("Smileys & Emotion");
    const grin = emojiByChar("😀")!;
    expect(grin.name).toBe("grinning face");
    expect(grin.keywords).toContain("smile");
  });

  it("normalises keywords to lower-case words", () => {
    for (const e of EMOJI.slice(0, 200)) {
      for (const k of e.keywords) expect(k).toBe(k.toLowerCase());
      for (const k of e.keywords) expect(k).not.toContain("_");
    }
  });
});

describe("searchEmoji", () => {
  it("returns everything for an empty query", () => {
    expect(searchEmoji("  ")).toBe(EMOJI);
  });

  it("ranks exact and prefix name matches first", () => {
    expect(searchEmoji("grinning face")[0].char).toBe("😀");
    expect(searchEmoji("thumbs")[0].name.startsWith("thumbs")).toBe(true);
  });

  it("finds emoji by keyword", () => {
    expect(searchEmoji("happy").map((e) => e.char)).toContain("😀");
  });

  it("is case-insensitive", () => {
    expect(searchEmoji("HEART").length).toBeGreaterThan(0);
  });

  it("returns nothing for gibberish", () => {
    expect(searchEmoji("qqzzxx")).toEqual([]);
  });
});
