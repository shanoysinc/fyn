import { describe, expect, it, vi } from "vitest";
import { loadRecents, pushRecent } from "./recents";

describe("recents", () => {
  it("starts empty", () => {
    expect(loadRecents("emoji")).toEqual([]);
  });

  it("puts the newest first and removes duplicates", () => {
    pushRecent("emoji", "a");
    pushRecent("emoji", "b");
    expect(pushRecent("emoji", "a")).toEqual(["a", "b"]);
    expect(loadRecents("emoji")).toEqual(["a", "b"]);
  });

  it("caps the list length", () => {
    for (let i = 0; i < 10; i++) pushRecent("color", `c${i}`, 3);
    expect(loadRecents("color")).toEqual(["c9", "c8", "c7"]);
  });

  it("keeps lists separate by key", () => {
    pushRecent("emoji", "x");
    expect(loadRecents("color")).toEqual([]);
  });

  it("ignores corrupt or foreign data", () => {
    localStorage.setItem("fyn:recent:emoji", "{not json");
    expect(loadRecents("emoji")).toEqual([]);
    localStorage.setItem("fyn:recent:emoji", JSON.stringify({ a: 1 }));
    expect(loadRecents("emoji")).toEqual([]);
    localStorage.setItem("fyn:recent:emoji", JSON.stringify(["ok", 3, null]));
    expect(loadRecents("emoji")).toEqual(["ok"]);
  });

  it("still works when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadRecents("emoji")).toEqual([]);
    expect(pushRecent("emoji", "a")).toEqual(["a"]);
  });
});
