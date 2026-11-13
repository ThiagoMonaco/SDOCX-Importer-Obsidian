export type Point = [number, number];
export interface Stroke {
  points: Point[];
  pressures: number[];
  color: string;
  width: number;
  opacity: number;
  highlighter: boolean;
  order: number;
}
export interface TextRun {
  order: number;
  value: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  background: string;
  opacity: number;
  backgroundOpacity: number;
}
export interface ImageObject {
  assetID: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  order: number;
}
export interface Asset {
  mimeType: string;
  data: Uint8Array;
}
export interface Page {
  id: string;
  width: number;
  height: number;
  strokes: Stroke[];
  texts: TextRun[];
  images: ImageObject[];
}
export interface Document {
  pages: Page[];
  assets: Map<string, Asset>;
  warnings: string[];
}
export type Element = { id: string; type: string; [key: string]: unknown };
export interface Scene {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: Element[];
  appState: Record<string, unknown>;
  files: Record<
    string,
    {
      id: string;
      mimeType: string;
      dataURL: string;
      created: number;
      lastRetrieved: number;
    }
  >;
}
export interface ConversionOptions {
  strokeScale?: number;
  textLineHeight?: number;
  pageFrames?: boolean;
  sourcePageSize?: Pick<Page, "width" | "height">;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}
export interface Progress {
  phase: "archive" | "pages" | "export";
  completed: number;
  total: number;
}
export interface ConversionResult {
  scene: Scene;
  warnings: string[];
  statistics: {
    pages: number;
    strokes: number;
    points: number;
    texts: number;
    highlights: number;
    images: number;
  };
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
export class Context {
  private lastYield = 0;
  constructor(readonly options: ConversionOptions) {}
  check() {
    checkAbort(this.options.signal);
  }
  async checkpoint(force = false) {
    this.check();
    if (force || Date.now() - this.lastYield >= 12) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.lastYield = Date.now();
      this.check();
    }
  }
  progress(phase: Progress["phase"], completed: number, total: number) {
    this.check();
    this.options.onProgress?.({ phase, completed, total });
  }
}
export const limits = {
  member: 64 * 1024 ** 2,
  archive: 256 * 1024 ** 2,
  pages: 4096,
  objects: 100000,
  points: 4000000,
};
