import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportEngine, ImportHost, sourceKey } from "../src/engine";
import {
  hash,
  type ConversionResult,
  type ConversionOptions,
  convertExcalidraw,
  renameSdocx,
} from "@sdocx-importer/converter";
import { initialState, loadState, State, validateSettings } from "../src/state";
import { rememberSource, writeSourceLink } from "../src/source-link";
const enc = (s: string) => new TextEncoder().encode(s);
const result: ConversionResult = {
  scene: {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [],
    files: {},
    appState: {},
  },
  warnings: ["approximate"],
  statistics: {
    pages: 2,
    strokes: 1,
    points: 2,
    texts: 0,
    highlights: 0,
    images: 0,
  },
};
function fixture(saved?: State) {
  const state = saved ?? initialState(),
    source = state.settings.sourceFolder + "/sub/Note.sdocx",
    files = new Map<string, Uint8Array>([[source, enc("one")]]),
    published: string[] = [],
    notices: string[] = [];
  let persisted = structuredClone(state),
    dependency: string | null = null;
  const host: ImportHost = {
    listSources: () => [...files.keys()],
    readSource: async (p) => files.get(p) ?? null,
    targetRevision: async (p) => (files.has(p) ? hash(files.get(p)!) : null),
    exists: (p) => files.has(p),
    save: async (s) => {
      persisted = structuredClone(s);
    },
    notice: (m) => {
      notices.push(m);
    },
    changed: () => {},
    dependencyError: () => dependency,
    publish: async (_r, p, replace, revision, check) => {
      await check();
      if (replace && hash(files.get(p)!) !== revision)
        throw new Error("Target changed");
      if (!replace && files.has(p)) throw new Error("Collision");
      files.set(p, enc("drawing"));
      published.push(p);
    },
  };
  const convert = vi.fn(
    async (_bytes: Uint8Array | ArrayBuffer, _options?: ConversionOptions) =>
      structuredClone(result),
  );
  const engine = new ImportEngine(state, host, convert);
  return {
    state,
    source,
    files,
    published,
    notices,
    host,
    convert,
    engine,
    persisted: () => persisted,
    dependency: (s: string | null) => (dependency = s),
  };
}
afterEach(() => vi.useRealTimers());
describe("watched imports", () => {
  it("waits for the old source path to disappear before adopting a renamed peer file", async () => {
    const f = fixture();
    const bytes = f.files.get(f.source)!;
    f.host.sourceExists = async (path) => f.files.has(path);
    await f.engine.scan();
    await f.engine.idle();
    const existing = f.state.records[f.source];
    const target = f.source.replace("Note.sdocx", "Renamed.sdocx");
    const { bytes: packed } = await convertExcalidraw(
      {
        ...result.scene,
        elements: [
          {
            id: "pen",
            type: "freedraw",
            points: [
              [0, 0],
              [20, 20],
            ],
          },
        ],
      },
      "Renamed",
    );
    const key = sourceKey(f.source);
    f.files.set(
      target,
      writeSourceLink(packed, rememberSource(bytes, key, f.source)),
    );
    await f.engine.scan();
    await f.engine.idle();
    expect(f.state.records[target]).toBeUndefined();
    f.files.delete(f.source);
    await f.engine.scan();
    await f.engine.idle();
    expect(f.state.records[f.source]).toBeUndefined();
    expect(f.state.records[target]).toBe(existing);
    expect(existing.linkKey).toBe(key);
    expect(f.convert).toHaveBeenCalledTimes(1);
  });
  it("renames the linked drawing in place and keeps an occupied name safe", async () => {
    const f = fixture();
    const { bytes } = await convertExcalidraw(
      {
        ...result.scene,
        elements: [
          {
            id: "pen",
            type: "freedraw",
            points: [
              [0, 0],
              [20, 20],
            ],
          },
        ],
      },
      "Before",
    );
    f.files.set(f.source, bytes);
    f.host.renameDrawing = async (from, to) => {
      expect(f.files.has(to)).toBe(false);
      f.files.set(to, f.files.get(from)!);
      f.files.delete(from);
    };
    await f.engine.scan();
    await f.engine.idle();
    const original = f.state.records[f.source].destination!;
    const occupied = original.replace("Before", "After");
    f.files.set(occupied, enc("existing"));
    const changed = await renameSdocx(bytes, "After");
    f.files.set(f.source, changed);
    await f.engine.scan();
    await f.engine.idle();
    expect(f.state.records[f.source]).toMatchObject({
      destination: original.replace("Before", "After (2)"),
      acceptedHash: hash(changed),
      sourceTitle: "After",
      status: "imported",
    });
    expect(f.files.has(original)).toBe(false);
    expect(f.files.get(occupied)).toEqual(enc("existing"));
    expect(f.convert).toHaveBeenCalledTimes(1);
  });
  it("does not reimport a source with an unresolved reverse-publication journal", async () => {
    const f = fixture();
    f.state.records[f.source] = {
      source: f.source,
      status: "imported",
      updatedAt: 0,
      acceptedHash: "before",
      exporting: {
        previousHash: "before",
        contentHash: "after",
        backup: "backup",
      },
    };
    await f.engine.scan();
    await f.engine.idle();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.state.records[f.source].exporting).toBeDefined();
  });
  it("mirrors subfolders and imports once across startup scans and duplicate events", async () => {
    const f = fixture();
    f.engine.scan();
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toEqual(["SDOCX/Drawings/sub/Note.excalidraw.md"]);
    f.engine.scan();
    await f.engine.idle();
    expect(f.convert).toHaveBeenCalledTimes(1);
    const restarted = fixture(loadState(f.persisted()));
    restarted.engine.scan();
    await restarted.engine.idle();
    expect(restarted.published).toEqual([]);
  });
  it("debounces incomplete source writes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.engine.schedule(f.source);
    await vi.advanceTimersByTimeAsync(350);
    f.files.set(f.source, enc("complete"));
    f.engine.schedule(f.source);
    await vi.advanceTimersByTimeAsync(499);
    expect(f.convert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.engine.idle();
    expect(f.convert).toHaveBeenCalledTimes(1);
  });
  it("links the drawing imported by another device without making a numbered copy", async () => {
    const f = fixture();
    const target = "SDOCX/Drawings/sub/Note.excalidraw.md";
    f.files.set(target, enc("drawing from another device"));
    f.host.drawingSource = async (path) =>
      path === target
        ? {
            key: sourceKey(f.source),
            revision: hash(enc("one")),
            drawingHash: hash(f.files.get(target)!),
          }
        : null;
    await f.engine.scan();
    await f.engine.idle();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.state.records[f.source]).toMatchObject({
      destination: target,
      status: "imported",
    });
    expect(f.published).toEqual([]);
  });
  it("does not overwrite an unrelated output", async () => {
    const f = fixture();
    f.files.set("SDOCX/Drawings/sub/Note.excalidraw.md", enc("user"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.published[0]).toBe("SDOCX/Drawings/sub/Note (2).excalidraw.md");
    expect(f.files.get("SDOCX/Drawings/sub/Note.excalidraw.md")).toEqual(
      enc("user"),
    );
  });
  it("persists review decisions and skips only the selected revision", async () => {
    const f = fixture();
    f.engine.scan();
    await f.engine.idle();
    f.files.set(f.source, enc("two"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.state.records[f.source].pendingHash).toBe(hash(enc("two")));
    expect(loadState(f.persisted()).records[f.source].status).toBe("pending");
    await f.engine.decide(f.source, "skip");
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
    f.files.set(f.source, enc("three"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.state.records[f.source].status).toBe("pending");
  });
  it.each(["replace", "version"] as const)(
    "supports %s from review",
    async (action) => {
      const f = fixture();
      f.engine.scan();
      await f.engine.idle();
      f.files.set(f.source, enc("two"));
      f.engine.scan();
      await f.engine.idle();
      await f.engine.decide(f.source, action);
      expect(f.published).toHaveLength(2);
      expect(f.published[1] === f.published[0]).toBe(action === "replace");
      expect(f.state.records[f.source].pendingHash).toBeUndefined();
    },
  );
  it("auto-replaces future changes but leaves already queued reviews pending", async () => {
    const f = fixture();
    f.engine.scan();
    await f.engine.idle();
    f.files.set(f.source, enc("two"));
    f.engine.scan();
    await f.engine.idle();
    f.state.settings.autoReplace = true;
    f.files.set(f.source, enc("three"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
    await f.engine.decide(f.source, "replace");
    f.files.set(f.source, enc("four"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(3);
    expect(new Set(f.published).size).toBe(1);
  });
  it("does not apply a review decision to a newer source revision", async () => {
    const f = fixture();
    f.engine.scan();
    await f.engine.idle();
    f.files.set(f.source, enc("two"));
    f.engine.scan();
    await f.engine.idle();
    f.files.set(f.source, enc("three"));
    await f.engine.decide(f.source, "replace");
    expect(f.published).toHaveLength(1);
    expect(f.state.records[f.source].pendingHash).toBe(hash(enc("three")));
  });
  it("keeps drawings on source removal and treats moves as new paths", async () => {
    const f = fixture();
    f.engine.scan();
    await f.engine.idle();
    f.files.delete(f.source);
    f.files.set(f.source.replace("/Note", "/Moved"), enc("one"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(2);
    expect(f.files.has(f.published[0])).toBe(true);
  });
  it("does not publish if the source changes during conversion", async () => {
    const f = fixture();
    f.convert.mockImplementationOnce(async () => {
      f.files.set(f.source, enc("changed"));
      return result;
    });
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(0);
    expect(f.state.records[f.source].status).toBe("failed");
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
  });
  it("preserves the previous drawing after replacement failure and allows retry", async () => {
    const f = fixture();
    f.engine.scan();
    await f.engine.idle();
    f.files.set(f.source, enc("two"));
    f.state.settings.autoReplace = true;
    f.convert.mockRejectedValueOnce(new Error("Malformed source"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.files.get(f.published[0])).toEqual(enc("drawing"));
    expect(f.state.records[f.source].status).toBe("failed");
    f.engine.scan();
    await f.engine.idle();
    expect(f.convert).toHaveBeenCalledTimes(2);
    await f.engine.retry();
    expect(f.state.records[f.source].status).toBe("imported");
  });
  it("continues other files after malformed input", async () => {
    const f = fixture();
    f.files.set(f.source.replace("/Note", "/Other"), enc("other"));
    f.convert.mockRejectedValueOnce(new Error("Malformed"));
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
    expect(f.state.records[f.source].status).toBe("failed");
  });
  it("waits for Excalidraw and resumes on a later scan", async () => {
    const f = fixture();
    f.dependency("Install Excalidraw");
    f.engine.scan();
    await f.engine.idle();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.notices).toEqual(["Install Excalidraw"]);
    f.dependency(null);
    f.engine.scan();
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
  });
  it("aborts active work on pause and resumes without losing pending sources", async () => {
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    f.convert.mockImplementationOnce(async (_b, o) => {
      started();
      await new Promise<void>((_, reject) =>
        o!.signal!.addEventListener(
          "abort",
          () => reject(new Error("Aborted")),
          { once: true },
        ),
      );
      return result;
    });
    f.engine.scan();
    await ready;
    await f.engine.setPaused(true);
    await f.engine.idle();
    expect(f.published).toHaveLength(0);
    await f.engine.setPaused(false);
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
  });
  it("clears scheduled work on unload", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.engine.schedule(f.source);
    f.engine.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.convert).not.toHaveBeenCalled();
  });
  it("does not execute the same review action twice while it is active", async () => {
    const f = fixture();
    f.engine.scan();
    await f.engine.idle();
    f.files.set(f.source, enc("two"));
    f.engine.scan();
    await f.engine.idle();
    await Promise.all([
      f.engine.decide(f.source, "version"),
      f.engine.decide(f.source, "version"),
    ]);
    expect(f.published).toHaveLength(2);
  });
  it("recovers unfinished conversion work on restart", async () => {
    const f = fixture();
    f.state.records[f.source] = {
      source: f.source,
      status: "working",
      lastAttemptHash: hash(enc("one")),
      updatedAt: 0,
    };
    const restarted = fixture(loadState(f.state));
    restarted.engine.scan();
    await restarted.engine.idle();
    expect(restarted.published).toHaveLength(1);
  });
  it("reports a missing dependency persistently when Scan is clicked", async () => {
    const f = fixture();
    f.dependency("Loaded Excalidraw is too old");
    await f.engine.scan(true);
    expect(f.engine.scanMessage).toBe("Loaded Excalidraw is too old");
    expect(f.notices).toContain("Loaded Excalidraw is too old");
    expect(f.convert).not.toHaveBeenCalled();
  });
  it("reports empty inbox and paused watcher instead of silently doing nothing", async () => {
    const f = fixture();
    f.files.clear();
    await f.engine.scan(true);
    expect(f.engine.scanMessage).toContain("No SDOCX files found");
    f.state.paused = true;
    await f.engine.scan(true);
    expect(f.engine.scanMessage).toContain("Resume before scanning");
  });
  it("reports asynchronous discovery errors and can scan again", async () => {
    const f = fixture();
    f.host.listSources = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cannot read inbox"))
      .mockResolvedValue([f.source]);
    await f.engine.scan(true);
    expect(f.engine.scanMessage).toContain("Cannot read inbox");
    await f.engine.scan(true);
    await f.engine.idle();
    expect(f.published).toHaveLength(1);
    expect(f.engine.scanMessage).toContain("Found 1 SDOCX file");
  });
  it("rejects nested/unsafe folders and non-finite settings", () => {
    const s = initialState().settings;
    expect(() =>
      validateSettings({ ...s, outputFolder: s.sourceFolder + "/out" }),
    ).toThrow("separate");
    expect(() =>
      validateSettings({ ...s, sourceFolder: "../private" }),
    ).toThrow("folder");
    expect(() => validateSettings({ ...s, strokeScale: Infinity })).toThrow(
      "finite",
    );
  });
});
