import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type SDOCXImporter from "./main";
export class StatusModal extends Modal {
  private progressEl?: HTMLElement;
  updateProgress() {
    this.progressEl?.setText(
      this.plugin.engine.progress ||
        this.plugin.engine.scanMessage ||
        (this.plugin.state.paused
          ? "Watching is paused."
          : "Watching your SDOCX inbox."),
    );
  }
  constructor(
    app: App,
    private plugin: SDOCXImporter,
    private closed: () => void,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("sdocx-importer-modal");
    this.render();
  }
  onClose() {
    this.contentEl.empty();
    this.closed();
  }
  render() {
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: "SDOCX imports" });
    this.progressEl = el.createEl("p");
    this.updateProgress();
    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText(this.plugin.state.paused ? "Resume" : "Pause")
          .onClick(() => {
            void this.plugin.engine
              .setPaused(!this.plugin.state.paused)
              .catch((e) => this.plugin.report(e));
          }),
      )
      .addButton((b) =>
        b.setButtonText("Scan now").onClick(() => {
          void this.plugin.engine.scan(true);
        }),
      );
    const records = Object.values(this.plugin.state.records).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    if (!records.length)
      el.createEl("p", {
        text: `Place SDOCX files in ${this.plugin.state.settings.sourceFolder}. Subfolders are included.`,
      });
    for (const record of records) {
      const row = el.createDiv({ cls: "sdocx-importer-record" });
      row.createEl("h3", { text: record.source });
      row.createEl("p", {
        text:
          record.status +
          (record.destination ? " → " + record.destination : ""),
      });
      if (record.error)
        row.createEl("p", {
          text: record.error,
          cls: "sdocx-importer-error",
        });
      if (record.statistics) {
        const s = record.statistics;
        row.createEl("p", {
          text: `${s.pages} pages · ${s.strokes} strokes · ${s.texts} text runs · ${s.images} images`,
        });
      }
      if (record.warnings?.length) {
        const details = row.createEl("details");
        details.createEl("summary", {
          text: `${record.warnings.length} conversion warnings`,
        });
        const list = details.createEl("ul");
        for (const warning of record.warnings)
          list.createEl("li", { text: warning });
      }
      if (record.pendingHash) {
        const controls = new Setting(row).setName("Changed source");
        for (const [action, label] of [
          ["replace", "Replace"],
          ["version", "Create new version"],
          ["skip", "Skip this revision"],
        ] as const)
          controls.addButton((b) =>
            b
              .setButtonText(label)
              .setDisabled(
                record.status === "working" || this.plugin.state.paused,
              )
              .onClick(() => {
                b.setDisabled(true);
                void this.plugin.engine
                  .decide(record.source, action)
                  .catch((e) => this.plugin.report(e));
              }),
          );
      }
      if (record.status === "failed")
        new Setting(row).addButton((b) =>
          b.setButtonText("Retry failed imports").onClick(() => {
            void this.plugin.engine.retry().catch((e) => this.plugin.report(e));
          }),
        );
    }
  }
}
export class ImporterSettings extends PluginSettingTab {
  constructor(
    app: App,
    private importer: SDOCXImporter,
  ) {
    super(app, importer);
  }
  display() {
    const el = this.containerEl;
    el.empty();
    el.createEl("h2", { text: "SDOCX Importer" });
    el.createEl("p", {
      text: "Requires Excalidraw 2.29.1 or newer. All conversion runs on your device. Source files are retained.",
    });
    const draft = { ...this.importer.state.settings };
    new Setting(el)
      .setName("Source folder")
      .setDesc("Watch this vault folder and its subfolders for SDOCX files.")
      .addText((t) =>
        t
          .setValue(draft.sourceFolder)
          .onChange((v) => (draft.sourceFolder = v)),
      );
    new Setting(el)
      .setName("Output folder")
      .setDesc(
        "Drawings mirror source subfolders. Embedded images go in _assets.",
      )
      .addText((t) =>
        t
          .setValue(draft.outputFolder)
          .onChange((v) => (draft.outputFolder = v)),
      );
    new Setting(el)
      .setName("Automatically replace changed imports")
      .setDesc(
        "Off: queue changed sources for review. On: future source changes replace the linked drawing, including your edits. Existing review items remain queued.",
      )
      .addToggle((t) =>
        t.setValue(draft.autoReplace).onChange((v) => (draft.autoReplace = v)),
      );
    new Setting(el)
      .setName("Export drawing edits automatically")
      .setDesc(
        "After a linked drawing is saved, back up and update its SDOCX. Export stops if the Samsung Notes file changed independently. Enable on the device where you edit drawings.",
      )
      .addToggle((t) =>
        t.setValue(draft.autoExport).onChange((v) => (draft.autoExport = v)),
      );
    new Setting(el)
      .setName("Stroke scale")
      .setDesc("Positive pen-width multiplier. Default: 1.")
      .addText((t) =>
        t
          .setValue(String(draft.strokeScale))
          .onChange((v) => (draft.strokeScale = Number(v))),
      );
    new Setting(el)
      .setName("Body text line height")
      .setDesc("Positive line advance in em. Default: 1.9.")
      .addText((t) =>
        t
          .setValue(String(draft.textLineHeight))
          .onChange((v) => (draft.textLineHeight = Number(v))),
      );
    new Setting(el)
      .setName("Page frames")
      .setDesc("Include named frames around source pages.")
      .addToggle((t) =>
        t.setValue(draft.pageFrames).onChange((v) => (draft.pageFrames = v)),
      );
    const message = el.createEl("p");
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Save settings")
        .setCta()
        .onClick(async () => {
          b.setDisabled(true);
          try {
            await this.importer.updateSettings(draft);
            message.setText("Settings saved.");
          } catch (error) {
            message.setText(
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            b.setDisabled(false);
          }
        }),
    );
  }
}
