import { describe, expect, it } from "vitest";
import { fromEvent, toKeys } from "./hotkey";

const key = (code: string, mods: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { code, ...mods });

describe("fromEvent", () => {
  it("builds an accelerator from modifiers + physical key", () => {
    expect(fromEvent(key("Space", { ctrlKey: true }))).toBe("Ctrl+Space");
    expect(fromEvent(key("KeyK", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+KeyK");
    expect(fromEvent(key("KeyK", { altKey: true, metaKey: true }))).toBe("Alt+Super+KeyK");
  });

  it("orders modifiers consistently", () => {
    expect(fromEvent(key("KeyA", { shiftKey: true, metaKey: true, altKey: true, ctrlKey: true }))).toBe(
      "Ctrl+Alt+Shift+Super+KeyA",
    );
  });

  it("waits while only modifiers are held", () => {
    expect(fromEvent(key("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(fromEvent(key("ShiftRight", { shiftKey: true }))).toBeNull();
    expect(fromEvent(key("MetaLeft", { metaKey: true }))).toBeNull();
  });

  it("ignores events without a key code", () => {
    expect(fromEvent(key(""))).toBeNull();
  });
});

describe("toKeys", () => {
  it.each([
    ["Ctrl+Space", ["Ctrl", "Space"]],
    ["Ctrl+Shift+KeyK", ["Ctrl", "Shift", "K"]],
    ["Super+Digit1", ["Win", "1"]],
    ["Alt+Numpad5", ["Alt", "Num 5"]],
    ["Ctrl+Backquote", ["Ctrl", "`"]],
    ["Ctrl+ArrowUp", ["Ctrl", "↑"]],
    ["F13", ["F13"]],
  ])("%s -> %j", (accel, keys) => expect(toKeys(accel)).toEqual(keys));
});
