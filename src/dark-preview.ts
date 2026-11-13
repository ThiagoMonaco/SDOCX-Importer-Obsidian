import { App, Modal, Notice } from "obsidian";
import type { Scene } from "@sdocx-importer/converter";

export function samsungDarkColor(color: unknown): unknown {
  if (
    typeof color !== "string" ||
    !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)
  )
    return color;
  const hex =
    color.length < 6
      ? Array.from(color.slice(1), (digit) => digit.repeat(2)).join("")
      : color.slice(1);
  const rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const extremes = Math.min(...rgb) + Math.max(...rgb);
  // Samsung reverses HSL lightness outside 40–60%, keeping hue and saturation.
  if (extremes >= 204 && extremes <= 306) return color;
  const shift = 255 - extremes;
  return (
    "#" +
    rgb
      .map((channel) => (channel + shift).toString(16).padStart(2, "0"))
      .join("") +
    hex.slice(6)
  );
}

export class DarkPreview extends Modal {
  private closed = false;
  private imageUrl?: string;

  constructor(
    app: App,
    private render: () => Promise<SVGSVGElement>,
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("sdocx-importer-modal");
    this.titleEl.setText("Samsung dark preview");
    const status = this.contentEl.createEl("p", { text: "Rendering preview…" });
    void this.render()
      .then((svg) => {
        if (this.closed) return;
        this.imageUrl = URL.createObjectURL(
          new Blob([new XMLSerializer().serializeToString(svg)], {
            type: "image/svg+xml",
          }),
        );
        status.remove();
        this.contentEl.createEl("img", {
          cls: "sdocx-dark-preview-image",
          attr: {
            src: this.imageUrl,
            alt: "Drawing with Samsung dark-mode ink colors",
          },
        });
      })
      .catch((error) => {
        if (this.closed) return;
        new Notice(`Could not preview drawing: ${String(error)}`);
        this.close();
      });
  }

  onClose() {
    this.closed = true;
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.contentEl.empty();
  }
}

export function samsungDarkScene(scene: Scene): Scene {
  return {
    ...scene,
    elements: scene.elements.map((element) => ({
      ...element,
      strokeColor: samsungDarkColor(element.strokeColor),
      backgroundColor: samsungDarkColor(element.backgroundColor),
    })),
    appState: {
      ...scene.appState,
      theme: "light",
      viewBackgroundColor: "#030303",
    },
  };
}
