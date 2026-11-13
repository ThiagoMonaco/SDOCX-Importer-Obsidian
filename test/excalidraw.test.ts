import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, App, WorkspaceLeaf } from "obsidian";
import { DrawingWriter, versionAtLeast } from "../src/excalidraw";
import { initialState } from "../src/state";
import { hash, type ConversionResult } from "@sdocx-importer/converter";
const result: ConversionResult = {
  scene: {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [{ id: "id", type: "freedraw" }],
    files: {},
    appState: {},
  },
  warnings: [],
  statistics: {
    pages: 1,
    strokes: 1,
    points: 1,
    texts: 0,
    highlights: 0,
    images: 0,
  },
};
const markdown = "---\nexcalidraw-plugin: parsed\n---\n# Drawing\nnew scene";
function setup() {
  const state = initialState(),
    source = "SDOCX/Inbox/Note.sdocx",
    target = "SDOCX/Drawings/Note.excalidraw.md";
  state.records[source] = { source, status: "working", updatedAt: 0 };
  const contents = new Map<string, string | Uint8Array>(),
    entries = new Map<string, unknown>(),
    leaves: WorkspaceLeaf[] = [];
  const file = (path: string, content: string | Uint8Array) => {
    const f = new TFile();
    f.path = path;
    entries.set(path, f);
    contents.set(path, content);
    return f;
  };
  const vault = {
    getAbstractFileByPath: (p: string) => entries.get(p),
    read: async (f: TFile) => contents.get(f.path) as string,
    readBinary: async (f: TFile) =>
      (contents.get(f.path) as Uint8Array).slice().buffer,
    createFolder: async (p: string) => {
      entries.set(p, {});
    },
    createBinary: async (p: string, b: ArrayBuffer) =>
      file(p, new Uint8Array(b)),
    create: async (p: string, s: string) => file(p, s),
    delete: async (f: TFile) => {
      entries.delete(f.path);
      contents.delete(f.path);
    },
    rename: async (f: TFile, p: string) => {
      const c = contents.get(f.path)!;
      entries.delete(f.path);
      contents.delete(f.path);
      f.path = p;
      entries.set(p, f);
      contents.set(p, c);
    },
    process: vi.fn(async (f: TFile, fn: (s: string) => string) => {
      contents.set(f.path, fn(contents.get(f.path) as string));
    }),
  };
  const app = {
    vault,
    fileManager: { trashFile: vault.delete },
    workspace: {
      getActiveViewOfType: () => null,
      iterateAllLeaves: (fn: (l: WorkspaceLeaf) => void) => leaves.forEach(fn),
    },
    plugins: {
      plugins: {
        "obsidian-excalidraw-plugin": { manifest: { version: "2.29.1" } },
      },
    },
  } as unknown as App;
  const ea = {
    elementsDict: {},
    imagesDict: {},
    canvas: {},
    create: vi.fn(async ({ exactPath }: { exactPath: string }) => {
      file(exactPath, markdown);
      return exactPath;
    }),
    destroy: vi.fn(),
  };
  vi.stubGlobal("window", { ExcalidrawAutomate: { getAPI: () => ea } });
  const save = vi.fn(async () => {}),
    writer = new DrawingWriter(app, state, save);
  return {
    state,
    source,
    target,
    contents,
    entries,
    leaves,
    file,
    vault,
    app,
    ea,
    writer,
    save,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("Excalidraw publication", () => {
  it("skips a known saved revision and verifies a new revision without saving the view", async () => {
    const f = setup();
    const file = f.file(f.target, markdown);
    const getSceneFromFile = vi.fn(async () => ({
      elements: [{ id: "new", type: "freedraw" }],
      appState: {},
    }));
    vi.stubGlobal("window", {
      ExcalidrawAutomate: { getAPI: () => f.ea, getSceneFromFile },
    });
    const known = hash(new TextEncoder().encode(markdown));
    expect(await f.writer.captureSaved(f.target, known)).toBeNull();
    expect(getSceneFromFile).not.toHaveBeenCalled();
    f.contents.set(f.target, markdown + "\nnew revision");
    const capture = (await f.writer.captureSaved(f.target, known))!;
    expect(getSceneFromFile).toHaveBeenCalledWith(file);
    await capture.verify();
    f.contents.set(f.target, markdown + "\na concurrent edit");
    await expect(capture.verify()).rejects.toThrow("Drawing changed");
  });
  it("captures saved live canvas elements and images without parsing compressed Markdown", async () => {
    const f = setup(),
      file = f.file(f.target, "saved markdown");
    const elements = [{ id: "text", type: "text", text: "Latest edit" }];
    const view = {
      file,
      forceSave: vi.fn(async () => {}),
      excalidrawAPI: {
        getSceneElements: () => elements,
        getFiles: () => ({}),
        getAppState: () => ({}),
      },
    };
    const leaf = { view } as unknown as WorkspaceLeaf;
    f.leaves.push(leaf);
    Object.assign(f.app.workspace, { getActiveViewOfType: () => leaf.view });
    const capture = await f.writer.captureActive();
    expect(view.forceSave).toHaveBeenCalled();
    expect(capture.scene.elements[0].text).toBe("Latest edit");
    await capture.verify();
    elements[0].text = "Changed again";
    expect(capture.scene.elements[0].text).toBe("Latest edit");
    await expect(capture.verify()).rejects.toThrow("Drawing changed");
  });
  it("rejects capture outside Excalidraw and during unfinished text editing", async () => {
    const f = setup();
    await expect(f.writer.captureActive()).rejects.toThrow(
      "Open the linked drawing",
    );
    const leaf = {
      view: {
        file: f.file(f.target, "saved"),
        excalidrawAPI: {
          getSceneElements: () => [],
          getFiles: () => ({}),
          getAppState: () => ({ editingTextElement: {} }),
        },
      },
    } as unknown as WorkspaceLeaf;
    Object.assign(f.app.workspace, { getActiveViewOfType: () => leaf.view });
    await expect(f.writer.captureActive()).rejects.toThrow("Finish editing");
  });
  it("checks the tested API version", () => {
    expect(versionAtLeast("2.29.1", "2.29.1")).toBe(true);
    expect(versionAtLeast("2.30.0", "2.29.1")).toBe(true);
    expect(versionAtLeast("2.9.1", "2.29.1")).toBe(false);
    expect(versionAtLeast("bad", "2.29.1")).toBe(false);
  });
  it("uses the installed plugin API even when the window global is unavailable", () => {
    const f = setup();
    (
      f.app as unknown as { plugins: { plugins: Record<string, unknown> } }
    ).plugins.plugins["obsidian-excalidraw-plugin"] = {
      manifest: { version: "2.29.1" },
      ea: { getAPI: () => f.ea },
    };
    vi.stubGlobal("window", {});
    expect(f.writer.dependencyError()).toBeNull();
  });
  it("reports the loaded dependency version and requires a restart after updating", () => {
    const f = setup();
    (
      f.app as unknown as { plugins: { plugins: Record<string, unknown> } }
    ).plugins.plugins["obsidian-excalidraw-plugin"] = {
      manifest: { version: "2.20.6" },
    };
    expect(f.writer.dependencyError()).toContain("2.20.6");
    expect(f.writer.dependencyError()).toContain("Restart Obsidian");
  });
  it("creates through exactPath and cleans up the isolated API", async () => {
    const f = setup();
    await f.writer.publish(result, f.target, false, null, async () => {}, {
      source: f.source,
      hash: "revision",
    });
    expect(f.contents.get(f.target)).toContain("sdocx-import-source:");
    expect(f.contents.get(f.target)).toContain("# Drawing\nnew scene");
    expect(f.ea.create).toHaveBeenCalledWith({
      exactPath: expect.stringContaining("samsung-import-stage-"),
      silent: true,
    });
    expect(f.ea.destroy).toHaveBeenCalledOnce();
    expect(f.state.staging).toEqual([]);
    expect(f.state.records[f.source].publishing?.destination).toBe(f.target);
  });
  it("keeps the destination on staging failure", async () => {
    const f = setup();
    f.file(f.target, "old scene");
    f.ea.create.mockRejectedValueOnce(new Error("Creation failed"));
    await expect(
      f.writer.publish(
        result,
        f.target,
        true,
        hash(new TextEncoder().encode("old scene")),
        async () => {},
        { source: f.source, hash: "revision" },
      ),
    ).rejects.toThrow("Creation failed");
    expect(f.contents.get(f.target)).toBe("old scene");
    expect(f.ea.destroy).toHaveBeenCalledOnce();
  });
  it("refuses replacement after a concurrent destination edit", async () => {
    const f = setup();
    f.file(f.target, "user edited");
    await expect(
      f.writer.publish(
        result,
        f.target,
        true,
        hash(new TextEncoder().encode("old scene")),
        async () => {},
        { source: f.source, hash: "revision" },
      ),
    ).rejects.toThrow("Drawing changed");
    expect(f.contents.get(f.target)).toBe("user edited");
    expect(f.vault.process).not.toHaveBeenCalled();
  });
  it("unloads and restores open drawing leaves around replacement", async () => {
    const f = setup(),
      file = f.file(f.target, "old scene"),
      view = { file, isDirty: () => false, isSaveInProgress: () => false },
      events: string[] = [];
    const leaf = {
      view,
      getViewState: () => ({ type: "excalidraw", state: { file: f.target } }),
      setViewState: vi.fn(async (s: { type: string }) => {
        events.push(s.type);
      }),
    } as unknown as WorkspaceLeaf;
    f.leaves.push(leaf);
    await f.writer.publish(
      result,
      f.target,
      true,
      hash(new TextEncoder().encode("old scene")),
      async () => {},
      { source: f.source, hash: "revision" },
    );
    expect(events).toEqual(["empty", "excalidraw"]);
    expect(f.contents.get(f.target)).toContain("sdocx-import-source:");
    expect(f.contents.get(f.target)).toContain("# Drawing\nnew scene");
    expect(f.entries.get(f.target)).toBe(file);
  });
  it("rejects dirty open drawings without discarding edits", async () => {
    const f = setup(),
      file = f.file(f.target, "old");
    f.leaves.push({
      view: { file, isDirty: () => true },
      getViewState: () => ({}),
      setViewState: vi.fn(),
    } as unknown as WorkspaceLeaf);
    await expect(
      f.writer.publish(
        result,
        f.target,
        true,
        hash(new TextEncoder().encode("old")),
        async () => {},
        { source: f.source, hash: "revision" },
      ),
    ).rejects.toThrow("being edited");
    expect(f.contents.get(f.target)).toBe("old");
  });
  it("recovers a committed publication interrupted before engine state save", async () => {
    const f = setup();
    await f.writer.publish(result, f.target, false, null, async () => {}, {
      source: f.source,
      hash: "revision",
    });
    await f.writer.cleanupStaging();
    expect(f.state.records[f.source]).toMatchObject({
      acceptedHash: "revision",
      destination: f.target,
      status: "imported",
    });
    expect(f.state.records[f.source].publishing).toBeUndefined();
  });
  it("requires review when an interrupted publication was subsequently edited", async () => {
    const f = setup();
    await f.writer.publish(result, f.target, false, null, async () => {}, {
      source: f.source,
      hash: "revision",
    });
    f.contents.set(f.target, "user edits");
    await f.writer.cleanupStaging();
    expect(f.state.records[f.source]).toMatchObject({
      pendingHash: "revision",
      status: "pending",
    });
    expect(f.contents.get(f.target)).toBe("user edits");
  });
  it("saves images as hash-addressed attachments and retains their scene IDs", async () => {
    const f = setup(),
      bytes = new Uint8Array([1, 2, 3]),
      id = hash(bytes),
      r = structuredClone(result);
    r.scene.files[id] = {
      id,
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AQID",
      created: 0,
      lastRetrieved: 0,
    };
    await f.writer.publish(r, f.target, false, null, async () => {}, {
      source: f.source,
      hash: "revision",
    });
    expect(f.contents.get(`SDOCX/Drawings/_assets/${id}.png`)).toEqual(bytes);
    expect(f.ea.imagesDict).toMatchObject({
      [id]: { id, file: expect.any(TFile) },
    });
  });
});
