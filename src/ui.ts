import {
  App,
  Modal,
  PluginSettingTab,
  Setting,
  type SettingDefinitionRender,
} from "obsidian";
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
    this.setTitle("SDOCX imports");
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
      new Setting(row).setName(record.source).setHeading();
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
    for (const definition of this.getSettingDefinitions()) {
      const row = new Setting(el)
        .setName(definition.name)
        .setDesc(definition.desc ?? "");
      definition.render(row);
    }
  }

  getSettingDefinitions(): (Omit<SettingDefinitionRender, "render"> & {
    render(row: Setting): void;
  })[] {
    const draft = { ...this.importer.state.settings };
    return [
      {
        name: "SDOCX Importer",
        desc: "Requires Excalidraw 2.29.1 or newer. Conversion runs on your device.",
        render: (row) => {
          row.setHeading();
        },
      },
      {
        name: "Source folder",
        desc: "Watch this vault folder and its subfolders for SDOCX files.",
        render: (row) => {
          row.addText((text) =>
            text.setValue(draft.sourceFolder).onChange((value) => {
              draft.sourceFolder = value;
            }),
          );
        },
      },
      {
        name: "Output folder",
        desc: "Drawings mirror source subfolders. Embedded images go in _assets.",
        render: (row) => {
          row.addText((text) =>
            text.setValue(draft.outputFolder).onChange((value) => {
              draft.outputFolder = value;
            }),
          );
        },
      },
      {
        name: "Automatically replace changed imports",
        desc: "Off: queue changed sources for review. On: future source changes replace the linked drawing, including your edits. Existing review items remain queued.",
        render: (row) => {
          row.addToggle((toggle) =>
            toggle.setValue(draft.autoReplace).onChange((value) => {
              draft.autoReplace = value;
            }),
          );
        },
      },
      {
        name: "Export drawing edits automatically",
        desc: "After a linked drawing is saved, back up and update its SDOCX. Export stops if the Samsung Notes file changed independently. Enable on the device where you edit drawings.",
        render: (row) => {
          row.addToggle((toggle) =>
            toggle.setValue(draft.autoExport).onChange((value) => {
              draft.autoExport = value;
            }),
          );
        },
      },
      {
        name: "Stroke scale",
        desc: "Positive pen-width multiplier. Default: 1.",
        render: (row) => {
          row.addText((text) =>
            text.setValue(String(draft.strokeScale)).onChange((value) => {
              draft.strokeScale = Number(value);
            }),
          );
        },
      },
      {
        name: "Body text line height",
        desc: "Positive line advance in em. Default: 1.9.",
        render: (row) => {
          row.addText((text) =>
            text.setValue(String(draft.textLineHeight)).onChange((value) => {
              draft.textLineHeight = Number(value);
            }),
          );
        },
      },
      {
        name: "Page frames",
        desc: "Include named frames around source pages.",
        render: (row) => {
          row.addToggle((toggle) =>
            toggle.setValue(draft.pageFrames).onChange((value) => {
              draft.pageFrames = value;
            }),
          );
        },
      },
      {
        name: "Save settings",
        render: (row) => {
          row.addButton((button) =>
            button
              .setButtonText("Save settings")
              .setCta()
              .onClick(() => {
                button.setDisabled(true);
                void this.importer
                  .updateSettings(draft)
                  .then(() => row.setDesc("Settings saved."))
                  .catch((error: unknown) => {
                    row.setDesc(
                      error instanceof Error ? error.message : String(error),
                    );
                  })
                  .finally(() => button.setDisabled(false));
              }),
          );
        },
      },
    ];
  }
}
