import { TFile, TFolder } from "obsidian";
import { expect, it, vi } from "vitest";
import { findLinkedDrawing } from "../src/drawing-discovery";

function file(path: string) {
  return Object.assign(new TFile(), { path, extension: path.split(".").pop() });
}

function folder(...children: (TFile | TFolder)[]) {
  return Object.assign(new TFolder(), { children });
}

it("checks Markdown only inside the configured folder and its descendants", () => {
  const linked = file("Output/Nested/renamed.md");
  const unrelated = file("Output/unrelated.png");
  const sourceLink = vi.fn(() => "key:revision");
  expect(
    findLinkedDrawing(folder(unrelated, folder(linked)), "key", sourceLink),
  ).toBe(linked.path);
  expect(sourceLink.mock.calls).toEqual([[linked]]);
});

it("rejects ambiguous matches and handles a missing output folder", () => {
  const sourceLink = () => "key:revision";
  expect(findLinkedDrawing(null, "key", sourceLink)).toBeUndefined();
  expect(
    findLinkedDrawing(
      folder(file("Output/a.md"), folder(file("Output/Sub/b.md"))),
      "key",
      sourceLink,
    ),
  ).toBeUndefined();
});
