import { App, TFile, WorkspaceLeaf } from "obsidian";
import {
  type ConversionResult,
  type Scene,
  hash,
} from "@sdocx-importer/converter";
import type { State } from "./state";
import { sourceKey } from "./engine";
interface EA {
  elementsDict: Record<string, unknown>;
  imagesDict: Record<string, unknown>;
  canvas: { viewBackgroundColor: string; theme: string; gridSize: number };
  create(options: { exactPath: string; silent: boolean }): Promise<string>;
  destroy(): void;
}
interface ExcalidrawAPI {
  getAPI(): EA;
  getSceneFromFile?(file: TFile): Promise<{
    elements: Scene["elements"];
    appState: Scene["appState"];
  } | null>;
}
type DrawingView = WorkspaceLeaf["view"] & {
  file?: TFile;
  forceSave?: (silent: boolean, wait: boolean) => Promise<void>;
  save?: () => Promise<void>;
  isDirty?: () => boolean;
  isSaveInProgress?: () => boolean;
  excalidrawAPI?: {
    getSceneElements(): Scene["elements"];
    getFiles(): Scene["files"];
    getAppState(): Record<string, unknown>;
  };
};
type PluginApp = App & {
  plugins: {
    plugins: Record<
      string,
      { manifest?: { version?: string }; ea?: ExcalidrawAPI }
    >;
  };
};
export function versionAtLeast(actual: string, minimum: string) {
  const a = actual.split(".").map(Number),
    b = minimum.split(".").map(Number);
  if (a.length !== 3 || a.some((n) => !Number.isInteger(n) || n < 0))
    return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
export class DrawingWriter {
  constructor(
    private app: App,
    private state: State,
    private save: () => Promise<void>,
  ) {}
  async captureActive() {
    const error = this.dependencyError();
    if (error) throw new Error(error);
    const view = this.app.workspace.activeLeaf?.view as DrawingView | undefined;
    const file = view?.file,
      api = view?.excalidrawAPI;
    if (!file || !api)
      throw new Error(
        "Open the linked drawing in Excalidraw before exporting.",
      );
    const snapshot = (): Scene => {
      if (view.file?.path !== file.path || view.excalidrawAPI !== api)
        throw new Error("Drawing view changed. Reopen it and retry export.");
      const state = api.getAppState();
      if (state.editingTextElement || state.newElement)
        throw new Error(
          "Finish editing text or drawing the current stroke before exporting.",
        );
      return JSON.parse(
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "obsidian",
          elements: api.getSceneElements(),
          files: api.getFiles(),
          appState: {},
        }),
      ) as Scene;
    };
    const revision = await this.revision(file.path),
      scene = snapshot();
    const sceneHash = hash(new TextEncoder().encode(JSON.stringify(scene)));
    return {
      path: file.path,
      scene,
      revision: revision ?? undefined,
      verify: async () => {
        if (
          (await this.revision(file.path)) !== revision ||
          hash(new TextEncoder().encode(JSON.stringify(snapshot()))) !==
            sceneHash
        )
          throw new Error(
            "Drawing changed during export. Retry with the latest edits.",
          );
      },
    };
  }
  async captureSaved(path: string, previousHash?: string) {
    const error = this.dependencyError();
    if (error) throw new Error(error);
    const file = this.file(path),
      api = this.api();
    if (!file || !api?.getSceneFromFile)
      throw new Error("Excalidraw could not read the saved drawing.");
    const readRevision = async () =>
      hash(new TextEncoder().encode(await this.app.vault.read(file)));
    const revision = await readRevision();
    if (revision === previousHash) return null;
    const saved = await api.getSceneFromFile(file);
    if (!saved) throw new Error("Excalidraw could not read the saved drawing.");
    const files: Scene["files"] = {};
    for (const leaf of this.openLeaves(path)) {
      Object.assign(
        files,
        (leaf.view as DrawingView).excalidrawAPI?.getFiles(),
      );
    }
    const scene: Scene = {
      type: "excalidraw",
      version: 2,
      source: "obsidian",
      elements: saved.elements,
      files,
      appState: saved.appState,
    };
    return {
      scene,
      revision,
      verify: async () => {
        if (this.file(path) !== file || (await readRevision()) !== revision)
          throw new Error(
            "Drawing changed during export. Retry with the latest edits.",
          );
      },
    };
  }
  private api() {
    const plugin = (this.app as PluginApp).plugins.plugins[
      "obsidian-excalidraw-plugin"
    ];
    return (
      plugin?.ea ??
      (window as unknown as { ExcalidrawAutomate?: ExcalidrawAPI })
        .ExcalidrawAutomate
    );
  }
  dependencyError() {
    const plugin = (this.app as PluginApp).plugins.plugins[
      "obsidian-excalidraw-plugin"
    ];
    if (!plugin)
      return "Imports blocked: Excalidraw is not loaded. Enable Excalidraw, then scan again.";
    const version = plugin.manifest?.version ?? "unknown";
    if (!versionAtLeast(version, "2.29.1"))
      return `Imports blocked: the loaded Excalidraw version is ${version}; 2.29.1 or newer is required. Restart Obsidian to load the installed update, then scan again.`;
    if (!this.api()?.getAPI)
      return "Imports blocked: Excalidraw's automation API is not ready. Restart Obsidian or reload Excalidraw, then scan again.";
    return null;
  }
  private file(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }
  async drawingSource(path: string) {
    const file = this.file(path);
    if (!file) return null;
    const markdown = await this.app.vault.read(file);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
      markdown,
    )?.[1];
    const marker = frontmatter?.match(
      /^sdocx-import-source:[ \t]*(["']?)([a-f0-9]{64}):([a-f0-9]{64})\1[ \t]*\r?$/m,
    );
    return marker
      ? {
          key: marker[2],
          revision: marker[3],
          drawingHash: hash(new TextEncoder().encode(markdown)),
        }
      : null;
  }
  private openLeaves(path: string) {
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if ((leaf.view as DrawingView).file?.path === path) leaves.push(leaf);
    });
    return leaves;
  }
  async revision(path: string) {
    for (const leaf of this.openLeaves(path)) {
      const view = leaf.view as DrawingView;
      if (view.forceSave) await view.forceSave(true, true);
      else if (view.save) await view.save();
      if (view.isDirty?.() || view.isSaveInProgress?.())
        throw new Error("Drawing has unsaved edits. Save it before replacing.");
    }
    const file = this.file(path);
    return file
      ? hash(new TextEncoder().encode(await this.app.vault.read(file)))
      : null;
  }
  async ensureFolder(path: string) {
    let current = "";
    for (const segment of path.split("/").filter(Boolean)) {
      current = current ? current + "/" + segment : segment;
      const entry = this.app.vault.getAbstractFileByPath(current);
      if (entry instanceof TFile)
        throw new Error(`A file blocks output folder ${current}`);
      if (!entry) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!this.app.vault.getAbstractFileByPath(current)) throw error;
        }
      }
    }
  }
  private async matches(path: string, expected: string | null) {
    const file = this.file(path),
      actual = file
        ? hash(new TextEncoder().encode(await this.app.vault.read(file)))
        : null;
    if (actual !== expected)
      throw new Error(
        "Drawing changed during import. Review and retry before replacing it.",
      );
  }
  async publish(
    result: ConversionResult,
    target: string,
    replace: boolean,
    expected: string | null,
    checkSource: () => Promise<void>,
    publication: { source: string; hash: string; key?: string },
  ) {
    const error = this.dependencyError();
    if (error) throw new Error(error);
    const folder = target.slice(0, target.lastIndexOf("/"));
    await this.ensureFolder(folder);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    const stage = `${folder}/samsung-import-stage-${token}.excalidraw.md`;
    const ea = this.api()!.getAPI(),
      closed: {
        leaf: WorkspaceLeaf;
        state: ReturnType<WorkspaceLeaf["getViewState"]>;
      }[] = [];
    let committed = false;
    try {
      ea.elementsDict = Object.fromEntries(
        result.scene.elements.map((el) => [el.id, el]),
      );
      ea.imagesDict = {};
      ea.canvas.viewBackgroundColor = "#ffffff";
      ea.canvas.theme = "light";
      ea.canvas.gridSize = 0;
      const assetsFolder = this.state.settings.outputFolder + "/_assets";
      if (Object.keys(result.scene.files).length)
        await this.ensureFolder(assetsFolder);
      for (const [id, image] of Object.entries(result.scene.files)) {
        await checkSource();
        const ext = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/gif": "gif",
        }[image.mimeType];
        if (!ext) throw new Error("Unsupported embedded image type");
        const binary = Uint8Array.from(
          atob(image.dataURL.slice(image.dataURL.indexOf(",") + 1)),
          (c) => c.charCodeAt(0),
        );
        if (hash(binary) !== id) throw new Error("Image hash mismatch");
        const assetPath = `${assetsFolder}/${id}.${ext}`;
        let file = this.file(assetPath);
        if (!file) {
          try {
            file = await this.app.vault.createBinary(assetPath, binary.buffer);
          } catch (err) {
            file = this.file(assetPath);
            if (!file) throw err;
          }
        }
        if (hash(new Uint8Array(await this.app.vault.readBinary(file))) !== id)
          throw new Error(
            `Existing attachment does not match its hash: ${assetPath}`,
          );
        ea.imagesDict[id] = { ...image, file };
      }
      this.state.staging.push(stage);
      await this.save();
      const created = await ea.create({ exactPath: stage, silent: true });
      if (created !== stage)
        throw new Error("Excalidraw returned an unexpected staging path");
      const staged = this.file(stage);
      if (!staged) throw new Error("Excalidraw did not create a drawing");
      const stagedMarkdown = await this.app.vault.read(staged);
      if (
        !/^---\r?\n/.test(stagedMarkdown) ||
        !/excalidraw-plugin:\s*(parsed|raw)/.test(stagedMarkdown) ||
        !stagedMarkdown.includes("# Drawing")
      )
        throw new Error("Excalidraw produced an invalid drawing note");
      const key = publication.key ?? sourceKey(publication.source);
      const markdown = stagedMarkdown.replace(
        /^---\r?\n/,
        `---\nsdocx-import-source: "${key}:${publication.hash}"\n`,
      );
      await checkSource();
      const record = this.state.records[publication.source];
      if (!record) throw new Error("Missing import record");
      record.publishing = {
        sourceHash: publication.hash,
        destination: target,
        contentHash: hash(new TextEncoder().encode(markdown)),
        warnings: result.warnings,
        statistics: result.statistics,
      };
      await this.save();
      if (replace) {
        await this.matches(target, expected);
        // Unload views before modifying so an autosave cannot overwrite the replacement.
        for (const leaf of this.openLeaves(target)) {
          const view = leaf.view as DrawingView;
          if (view.isDirty?.() || view.isSaveInProgress?.())
            throw new Error(
              "Drawing is being edited. Save it and retry replacement.",
            );
          const state = leaf.getViewState();
          closed.push({ leaf, state });
          await leaf.setViewState({ type: "empty", active: false });
        }
        await this.matches(target, expected);
        await checkSource();
        const file = this.file(target);
        if (!file) throw new Error("Replacement target is missing");
        await this.app.vault.process(file, (current) => {
          if (hash(new TextEncoder().encode(current)) !== expected)
            throw new Error("Drawing changed before replacement");
          return markdown;
        });
        committed = true;
      } else {
        await checkSource();
        const peer = async () => {
          const link = await this.drawingSource(target);
          if (link?.key !== key || link.revision !== publication.hash)
            return false;
          record.publishing!.contentHash = link.drawingHash;
          return true;
        };
        if (await peer()) {
          committed = true;
          return;
        }
        if (this.app.vault.getAbstractFileByPath(target))
          throw new Error(
            "Destination appeared during import. Retry after the vault finishes syncing.",
          );
        try {
          // Create at the final path so an existing file cannot be overwritten.
          await this.app.vault.create(target, markdown);
        } catch (error) {
          if (!(await peer())) throw error;
        }
        committed = true;
      }
    } finally {
      try {
        const staged = this.file(stage);
        if (staged) await this.app.vault.delete(staged);
        this.state.staging = this.state.staging.filter((p) => p !== stage);
        await this.save();
      } catch (error) {
        console.error("SDOCX staging cleanup failed", error);
        if (!committed) throw error;
      } finally {
        try {
          ea.destroy();
        } finally {
          for (const item of closed) {
            try {
              await item.leaf.setViewState({ ...item.state, active: false });
            } catch (error) {
              console.error("Could not reopen drawing after import", error);
            }
          }
        }
      }
    }
  }
  async cleanupStaging() {
    for (const record of Object.values(this.state.records)) {
      const publication = record.publishing;
      if (!publication) continue;
      const file = this.file(publication.destination);
      if (
        file &&
        hash(new TextEncoder().encode(await this.app.vault.read(file))) ===
          publication.contentHash
      ) {
        record.acceptedHash = publication.sourceHash;
        record.destination = publication.destination;
        record.drawingHash = publication.contentHash;
        record.pendingHash = undefined;
        record.skippedHash = undefined;
        record.status = "imported";
        record.error = undefined;
        record.warnings = publication.warnings;
        record.statistics = publication.statistics;
      } else if (file) {
        record.destination = publication.destination;
        record.pendingHash = publication.sourceHash;
        record.status = "pending";
        record.error =
          "An interrupted import needs review because the destination changed.";
      } else {
        record.lastAttemptHash = undefined;
        record.status = "failed";
      }
      record.publishing = undefined;
    }
    for (const path of [...this.state.staging]) {
      if (!/\/samsung-import-stage-[0-9a-f-]+\.excalidraw\.md$/.test(path))
        continue;
      const file = this.file(path);
      if (file) await this.app.vault.delete(file);
      this.state.staging = this.state.staging.filter((p) => p !== path);
    }
    await this.save();
  }
}
