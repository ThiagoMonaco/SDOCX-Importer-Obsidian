import { Plugin, Notice, TFile, TAbstractFile, View } from "obsidian";
import { drawingTitle, ImportEngine, sourceKey } from "./engine";
import { discoverSources } from "./inbox";
import { findLinkedDrawing } from "./drawing-discovery";
import { DrawingWriter } from "./excalidraw";
import { runConversion } from "./runner";
import { State, validateSettings } from "./state";
import { readDeviceState, saveDeviceState } from "./storage";
import { ImporterSettings, StatusModal } from "./ui";
import { ReverseExporter } from "./reverse";
import { ExportModal } from "./export-modal";
import { DarkPreview, samsungDarkScene } from "./dark-preview";
import type { Scene } from "@sdocx-importer/converter";
export default class SDOCXImporter extends Plugin {
  state!: State;
  engine!: ImportEngine;
  private writer!: DrawingWriter;
  private status!: HTMLElement;
  private modals = new Set<StatusModal>();
  private unloaded = false;
  private exporter!: ReverseExporter;
  private exportBusy = false;
  private ready = false;
  private exportTimers = new Map<string, number>();
  private exportModals = new Set<ExportModal>();
  private darkPreview?: DarkPreview;
  private incomingRenames = new Set<TFile>();
  private flushingTitles = false;
  async onload() {
    try {
      this.state = readDeviceState(this.app, await this.loadData());
    } catch (error) {
      new Notice(`SDOCX Importer could not load: ${String(error)}`, 0);
      throw error;
    }
    this.writer = new DrawingWriter(this.app, this.state, () =>
      this.engine.persist(),
    );
    this.engine = new ImportEngine(
      this.state,
      {
        listSources: () =>
          discoverSources(
            this.app.vault.adapter,
            this.state.settings.sourceFolder,
          ),
        readSource: async (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          return file instanceof TFile
            ? new Uint8Array(await this.app.vault.readBinary(file))
            : (await this.app.vault.adapter.exists(path))
              ? new Uint8Array(await this.app.vault.adapter.readBinary(path))
              : null;
        },
        targetRevision: (path) => this.writer.revision(path),
        drawingSource: (path) => this.writer.drawingSource(path),
        publish: (...args) => this.writer.publish(...args),
        exists: (path) => !!this.app.vault.getAbstractFileByPath(path),
        renameDrawing: async (from, to) => {
          const file = this.app.vault.getAbstractFileByPath(from);
          if (
            !(file instanceof TFile) ||
            this.app.vault.getAbstractFileByPath(to)
          )
            throw new Error(
              "Drawing path changed during rename. The source will be checked again.",
            );
          this.incomingRenames.add(file);
          try {
            await this.app.fileManager.renameFile(file, to);
          } finally {
            this.incomingRenames.delete(file);
          }
        },
        sourceExists: (path) => this.app.vault.adapter.exists(path),
        findDrawing: async (source, key) =>
          findLinkedDrawing(
            this.app.vault.getFolderByPath(this.state.settings.outputFolder),
            key ?? sourceKey(source),
            (file) =>
              this.app.metadataCache.getFileCache(file)?.frontmatter?.[
                "sdocx-import-source"
              ],
          ),
        save: (state) =>
          saveDeviceState(this.app, state, (s) => this.saveData(s)),
        notice: (message) => {
          new Notice(message, 8000);
        },
        changed: (progressOnly) => this.refresh(progressOnly),
        dependencyError: () => this.writer.dependencyError(),
      },
      runConversion,
    );
    this.exporter = new ReverseExporter(this.state, {
      read: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile)
          return new Uint8Array(await this.app.vault.readBinary(file));
        return (await this.app.vault.adapter.exists(path))
          ? new Uint8Array(await this.app.vault.adapter.readBinary(path))
          : null;
      },
      backup: async (path, bytes) => {
        await this.writer.ensureFolder(path.slice(0, path.lastIndexOf("/")));
        if (await this.app.vault.adapter.exists(path))
          throw new Error("Backup path already exists");
        await this.app.vault.createBinary(path, bytes.slice().buffer);
      },
      write: async (path, bytes) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile)
          await this.app.vault.modifyBinary(file, bytes.slice().buffer);
        else
          await this.app.vault.adapter.writeBinary(path, bytes.slice().buffer);
      },
      save: () => this.engine.persist(),
      rename: async (from, to) => {
        const file = this.app.vault.getAbstractFileByPath(from);
        const target = this.app.vault.getAbstractFileByPath(to);
        if (
          (target && target !== file) ||
          (from.toLowerCase() !== to.toLowerCase() &&
            (await this.app.vault.adapter.exists(to)))
        )
          throw new Error("SDOCX filename is already in use.");
        if (file instanceof TFile)
          await this.app.fileManager.renameFile(file, to);
        else await this.app.vault.adapter.rename(from, to);
      },
    });
    this.status = this.addStatusBarItem();
    this.status.addClass("sdocx-importer-status");
    this.status.addEventListener("click", () => this.openStatus());
    this.addSettingTab(new ImporterSettings(this.app, this));
    this.addCommand({
      id: "export-linked-sdocx",
      name: "Export active drawing back to linked SDOCX",
      callback: () => {
        void this.exportActive().catch((error) => this.report(error));
      },
    });
    this.addCommand({
      id: "preview-samsung-dark-colors",
      name: "Preview drawing with Samsung dark-mode colors",
      checkCallback: (checking) => {
        const view:
          | (View & {
              getScene?: () => Scene | null;
              svg?: (
                scene: Scene,
                theme: "light",
                embedScene: false,
              ) => Promise<SVGSVGElement>;
            })
          | null = this.app.workspace.getActiveViewOfType(View);
        if (view?.getViewType() !== "excalidraw" || !view.getScene || !view.svg)
          return false;
        if (!checking) {
          const scene = view.getScene();
          if (!scene?.elements.length) return false;
          const svg = view.svg.bind(view);
          this.darkPreview?.close();
          this.darkPreview = new DarkPreview(this.app, () =>
            svg(samsungDarkScene(scene), "light", false),
          );
          this.darkPreview.open();
        }
        return true;
      },
    });
    this.addCommand({
      id: "scan-inbox",
      name: "Scan SDOCX inbox",
      callback: () => {
        void this.engine.scan(true);
        this.openStatus();
      },
    });
    this.addCommand({
      id: "review-pending",
      name: "Review pending SDOCX imports",
      callback: () => this.openStatus(),
    });
    this.addCommand({
      id: "retry-failed",
      name: "Retry failed SDOCX imports",
      callback: () => {
        void this.engine.retry().catch((error) => this.report(error));
        this.openStatus();
      },
    });
    this.addCommand({
      id: "toggle-watching",
      name: "Pause/resume SDOCX watching",
      callback: () => {
        void this.engine
          .setPaused(!this.state.paused)
          .catch((error) => this.report(error));
      },
    });
    this.addRibbonIcon("file-input", "SDOCX imports", () => this.openStatus());
    const schedule = (file: TAbstractFile) => {
      if (file instanceof TFile) this.engine.schedule(file.path);
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        schedule(file);
        if (file instanceof TFile) this.scheduleExport(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        schedule(file);
        if (
          !(file instanceof TFile) ||
          this.incomingRenames.has(file) ||
          !/\.excalidraw(?:\.md)?$/i.test(file.path)
        )
          return;
        const record = Object.values(this.state.records).find(
          (item) => item.destination === oldPath,
        );
        if (!record) return;
        record.destination = file.path;
        const title = drawingTitle(file.path);
        if (title && title !== drawingTitle(oldPath))
          record.pendingTitle = Array.from(title).slice(0, 120).join("");
        void this.engine
          .persist()
          .then(() => this.flushTitles())
          .catch((error) => this.report(error));
      }),
    );
    // Listener registration precedes the startup scan; the engine deduplicates both paths.
    this.app.workspace.onLayoutReady(() => {
      if (!this.unloaded) void this.start();
    });
    this.registerInterval(
      window.setInterval(() => {
        if (!this.unloaded)
          void this.engine.scan().then(() => this.flushTitles());
      }, 5000),
    );
    this.refresh();
  }
  private async start() {
    try {
      await this.writer.cleanupStaging();
      await this.exporter.recover();
      this.ready = true;
      if (!this.unloaded)
        void this.engine.scan().then(() => this.flushTitles());
    } catch (error) {
      this.report(error);
    }
  }
  private async flushTitles() {
    if (
      !this.ready ||
      this.unloaded ||
      this.state.paused ||
      this.flushingTitles
    )
      return;
    this.flushingTitles = true;
    try {
      await this.engine.withImportsSuspended(async () => {
        for (const record of Object.values(this.state.records)) {
          if (this.unloaded || this.state.paused) return;
          if (!this.engine.accepts(record.source)) continue;
          try {
            const requested = record.pendingTitle !== undefined;
            if (requested) await this.exporter.rename(record);
            await this.exporter.syncFilename(record);
            if (
              requested &&
              record.pendingTitle === undefined &&
              record.destination
            )
              this.scheduleExport(record.destination);
          } catch (error) {
            this.report(error);
          }
        }
      });
    } finally {
      this.flushingTitles = false;
    }
  }
  private scheduleExport(path: string) {
    if (
      !this.ready ||
      this.unloaded ||
      this.state.paused ||
      !this.state.settings.autoExport
    )
      return;
    const linked = Object.values(this.state.records).some(
      (record) =>
        record.destination === path && this.engine.accepts(record.source),
    );
    if (!linked) return;
    window.clearTimeout(this.exportTimers.get(path));
    this.exportTimers.set(
      path,
      window.setTimeout(() => {
        this.exportTimers.delete(path);
        void this.exportSaved(path).catch((error) =>
          this.report(
            new Error(
              `Backsync stopped for ${path}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }, 450),
    );
  }
  private async exportSaved(path: string) {
    const enabled = () =>
      !this.unloaded && !this.state.paused && this.state.settings.autoExport;
    if (!enabled()) return;
    if (this.exportBusy) {
      this.scheduleExport(path);
      return;
    }
    this.exportBusy = true;
    try {
      await this.engine.withImportsSuspended(async () => {
        if (!enabled()) return;
        const record = Object.values(this.state.records).find(
          (entry) =>
            entry.destination === path && this.engine.accepts(entry.source),
        );
        if (!record?.acceptedHash) return;
        const capture = await this.writer.captureSaved(
          path,
          record.drawingHash,
        );
        if (!capture) return;
        const verify = async () => {
          if (!enabled()) throw new Error("Automatic export was paused.");
          await capture.verify();
        };
        const plan = await this.exporter.prepare(
          path,
          capture.scene,
          verify,
          capture.revision,
        );
        await this.exporter.commit(plan);
        new Notice(`Updated linked Samsung Notes file: ${plan.source}`, 5000);
      });
    } finally {
      this.exportBusy = false;
    }
  }
  private async exportActive() {
    if (this.exportBusy) throw new Error("An SDOCX export is already running.");
    this.exportBusy = true;
    try {
      await this.engine.idle();
      const capture = await this.writer.captureActive();
      const plan = await this.exporter.prepare(
        capture.path,
        capture.scene,
        capture.verify,
        capture.revision,
      );
      const modal = new ExportModal(
        this.app,
        plan,
        this.state.records[plan.source]?.warnings ?? [],
        async () => {
          if (this.unloaded)
            throw new Error("Plugin was unloaded. Reload and retry export.");
          if (this.exportBusy)
            throw new Error("An SDOCX export is already running.");
          this.exportBusy = true;
          try {
            const backup = await this.engine.withImportsSuspended(() =>
              this.exporter.commit(plan),
            );
            new Notice(`SDOCX exported. Original backup: ${backup}`, 10000);
            return backup;
          } finally {
            this.exportBusy = false;
          }
        },
        (error) => this.report(error),
      );
      this.exportModals.add(modal);
      const close = modal.onClose.bind(modal);
      modal.onClose = () => {
        close();
        this.exportModals.delete(modal);
      };
      modal.open();
    } finally {
      this.exportBusy = false;
    }
  }
  report(error: unknown) {
    console.error("SDOCX Importer", error);
    new Notice(String(error), 8000);
  }
  refresh(progressOnly = false) {
    if (!this.status) return;
    const pending = Object.values(this.state.records).filter(
      (r) => r.pendingHash,
    ).length;
    this.status.setText(
      this.state.paused
        ? "SDOCX imports paused"
        : `SDOCX imports${pending ? `: ${pending} pending` : ""}`,
    );
    for (const modal of this.modals) {
      if (progressOnly) modal.updateProgress();
      else modal.render();
    }
  }
  openStatus() {
    const modal = new StatusModal(this.app, this, () =>
      this.modals.delete(modal),
    );
    this.modals.add(modal);
    modal.open();
  }
  async updateSettings(next: State["settings"]) {
    if (this.exportBusy)
      throw new Error("Wait for the current export before changing settings.");
    const validated = validateSettings(next),
      wasPaused = this.state.paused;
    await this.engine.setPaused(true);
    await this.engine.idle();
    Object.assign(this.state.settings, validated);
    await this.engine.persist();
    await this.engine.setPaused(wasPaused);
  }
  onunload() {
    this.unloaded = true;
    for (const timer of this.exportTimers.values()) window.clearTimeout(timer);
    this.exportTimers.clear();
    this.engine?.stop();
    this.darkPreview?.close();
    for (const modal of this.modals) modal.close();
    for (const modal of this.exportModals) modal.close();
    this.modals.clear();
  }
}
