import { describe, expect, it, vi } from "vitest";
import { discoverSources } from "../src/inbox";
describe("physical inbox discovery", () => {
  it("finds unregistered SDOCX files recursively without the Obsidian index", async () => {
    const list = vi.fn(async (path: string) =>
      path === "SDOCX/Inbox"
        ? {
            files: ["SDOCX/Inbox/note.sdocx", "SDOCX/Inbox/readme.md"],
            folders: ["SDOCX/Inbox/sub", "SDOCX/Inbox/.hidden"],
          }
        : { files: ["SDOCX/Inbox/sub/NOTE.SDOCX"], folders: [] },
    );
    expect(
      await discoverSources({ exists: async () => true, list }, "SDOCX/Inbox"),
    ).toEqual(["SDOCX/Inbox/note.sdocx", "SDOCX/Inbox/sub/NOTE.SDOCX"]);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("handles an inbox that has not been created", async () => {
    const list = vi.fn();
    expect(
      await discoverSources({ exists: async () => false, list }, "SDOCX/Inbox"),
    ).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });
  it("ignores folders outside the inbox and duplicate folder entries", async () => {
    const list = vi.fn(async () => ({
      files: ["elsewhere/note.sdocx"],
      folders: ["elsewhere", "SDOCX/Inbox/sub", "SDOCX/Inbox/sub"],
    }));
    expect(
      await discoverSources({ exists: async () => true, list }, "SDOCX/Inbox"),
    ).toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
