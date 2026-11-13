import { App, Modal, Setting } from "obsidian";
import type { ExportPlan } from "./reverse";
export class ExportModal extends Modal {
  constructor(
    app: App,
    private plan: ExportPlan,
    private sourceWarnings: string[],
    private commit: () => Promise<string>,
    private report: (e: unknown) => void,
  ) {
    super(app);
  }
  onOpen() {
    const el = this.contentEl;
    this.setTitle("Export drawing back to SDOCX");
    el.createEl("p", {
      text: `Replace ${this.plan.source} with the current drawing. The original SDOCX will be backed up under the drawings folder in _backups.`,
    });
    el.createEl("p", {
      text: "This rebuilds the note from visible drawing content. Samsung-specific content absent from the drawing is not preserved. Keep the backup if you need to restore the original.",
    });
    const list = el.createEl("ul");
    for (const warning of [
      ...new Set([...this.plan.warnings, ...this.sourceWarnings]),
    ])
      list.createEl("li", { text: warning });
    new Setting(el)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Back up and replace SDOCX")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.commit();
              this.close();
            } catch (e) {
              this.report(e);
              this.close();
            }
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}
