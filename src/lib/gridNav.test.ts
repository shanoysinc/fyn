import { describe, expect, it } from "vitest";
import { gridMove } from "./gridNav";

// Favorites: a b c d | Suggestions: e f | Applications: x, y, z
const rows = [["a", "b", "c", "d"], ["e", "f"], ["x"], ["y"], ["z"]];
const move = (sel: string, key: Parameters<typeof gridMove>[2], col = 0) => gridMove(rows, sel, key, col);

describe("gridMove", () => {
  it("moves left and right within an icon row, stopping at the ends", () => {
    expect(move("b", "ArrowRight")).toEqual({ value: "c", column: 2 });
    expect(move("b", "ArrowLeft")).toEqual({ value: "a", column: 0 });
    expect(move("d", "ArrowRight")).toEqual({ value: "d", column: 3 });
    expect(move("a", "ArrowLeft")).toEqual({ value: "a", column: 0 });
  });

  it("leaves left/right to the default in a list", () => {
    expect(move("x", "ArrowLeft")).toBeNull();
    expect(move("x", "ArrowRight")).toBeNull();
  });

  it("moves down between icon rows keeping the column (clamped)", () => {
    expect(move("b", "ArrowDown")).toEqual({ value: "f", column: 1 });
    expect(move("d", "ArrowDown")).toEqual({ value: "f", column: 3 });
  });

  it("goes from the last icon row into the list", () => {
    expect(move("f", "ArrowDown")).toEqual({ value: "x", column: 1 });
  });

  it("comes back up from the list to the remembered column", () => {
    expect(move("x", "ArrowUp", 1)).toEqual({ value: "f", column: 1 });
    // Remembered column 3 is clamped to the 2-item Suggestions row…
    expect(move("x", "ArrowUp", 3)).toEqual({ value: "f", column: 3 });
    // …and restored on the 4-item Favorites row above it.
    expect(move("f", "ArrowUp", 3)).toEqual({ value: "b", column: 1 });
  });

  it("moves through list rows normally", () => {
    expect(move("x", "ArrowDown")).toEqual({ value: "y", column: 0 });
    expect(move("y", "ArrowUp")).toEqual({ value: "x", column: 0 });
  });

  it("leaves wrapping at the top and bottom to the default", () => {
    expect(move("a", "ArrowUp")).toBeNull();
    expect(move("z", "ArrowDown")).toBeNull();
  });

  it("ignores an unknown selection", () => {
    expect(move("nope", "ArrowDown")).toBeNull();
  });
});
