import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { actionFromKey, actionsFor } from "./actions";
import { makeItem } from "../test/fixtures";

const ev = (key: string, mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}) =>
  ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, metaKey: !!mods.meta }) as KeyboardEvent;

describe("actionsFor", () => {
  it("offers run-as-admin only for desktop apps", () => {
    expect(actionsFor(makeItem({ canRunAsAdmin: true })).map((a) => a.id)).toContain("admin");
    expect(actionsFor(makeItem({ kind: "store", canRunAsAdmin: false })).map((a) => a.id)).not.toContain("admin");
  });

  it("toggles the favorite label and adds reordering for pinned apps", () => {
    const unpinned = actionsFor(makeItem({ pinned: false }));
    expect(unpinned.find((a) => a.id === "pin")?.title).toBe("Add to Favorites");
    expect(unpinned.map((a) => a.id)).not.toContain("pin-up");

    const pinned = actionsFor(makeItem({ pinned: true }));
    expect(pinned.find((a) => a.id === "pin")?.title).toBe("Remove from Favorites");
    expect(pinned.map((a) => a.id)).toEqual(expect.arrayContaining(["pin-up", "pin-down"]));
  });

  it("always starts with Open and ends with Copy Path", () => {
    const ids = actionsFor(makeItem()).map((a) => a.id);
    expect(ids[0]).toBe("open");
    expect(ids[ids.length - 1]).toBe("copy");
  });
});

describe("actionFromKey", () => {
  it.each([
    [ev("Enter", { ctrl: true }), "reveal"],
    [ev("Enter", { ctrl: true, shift: true }), "admin"],
    [ev("p", { ctrl: true, shift: true }), "pin"],
    [ev("P", { ctrl: true, shift: true }), "pin"],
    [ev("c", { ctrl: true, shift: true }), "copy"],
    [ev("ArrowUp", { ctrl: true, shift: true }), "pin-up"],
    [ev("ArrowDown", { ctrl: true, shift: true }), "pin-down"],
    [ev("Enter", { meta: true }), "reveal"],
  ])("%o -> %s", (e, id) => expect(actionFromKey(e)).toBe(id));

  it.each([ev("Enter"), ev("p", { ctrl: true }), ev("c", { shift: true }), ev("x", { ctrl: true, shift: true })])(
    "%o -> null",
    (e) => expect(actionFromKey(e)).toBeNull(),
  );
});
