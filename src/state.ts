import type { ConversionResult } from "@sdocx-importer/converter";
export interface Settings {
  sourceFolder: string;
  outputFolder: string;
  autoReplace: boolean;
  autoExport: boolean;
  strokeScale: number;
  textLineHeight: number;
  pageFrames: boolean;
}
export const defaults: Settings = {
  sourceFolder: "SDOCX/Inbox",
  outputFolder: "SDOCX/Drawings",
  autoReplace: false,
  autoExport: false,
  strokeScale: 1,
  textLineHeight: 1.9,
  pageFrames: false,
};
export interface ImportRecord {
  source: string;
  linkKey?: string;
  acceptedHash?: string;
  skippedHash?: string;
  pendingHash?: string;
  destination?: string;
  sourceTitle?: string;
  sourceContentHash?: string;
  pendingTitle?: string;
  drawingHash?: string;
  lastAttemptHash?: string;
  status: "pending" | "working" | "imported" | "skipped" | "failed";
  error?: string;
  warnings?: string[];
  statistics?: ConversionResult["statistics"];
  updatedAt: number;
  exporting?: {
    previousHash: string;
    contentHash: string;
    backup: string;
    drawingHash?: string;
    title?: string;
    sourceContentHash?: string;
    keepPendingContent?: boolean;
  };
  publishing?: {
    sourceHash: string;
    destination: string;
    contentHash: string;
    warnings: string[];
    statistics: ConversionResult["statistics"];
  };
}
export interface State {
  version: 1;
  settings: Settings;
  paused: boolean;
  records: Record<string, ImportRecord>;
  staging: string[];
}
export const initialState = (): State => ({
  version: 1,
  settings: { ...defaults },
  paused: false,
  records: {},
  staging: [],
});
export function folderPath(value: string) {
  const path = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !path ||
    path.split("/").some((p) => p === "." || p === ".." || p.startsWith(".")) ||
    /[:*?"<>|]/.test(path) ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error(
      "Use a nonempty vault folder without hidden or relative path segments.",
    );
  return path;
}
export function validateSettings(settings: Settings): Settings {
  if (
    typeof settings.autoReplace !== "boolean" ||
    typeof settings.autoExport !== "boolean" ||
    typeof settings.pageFrames !== "boolean"
  )
    throw new Error("Automatic sync and page-frame settings must be booleans.");
  const sourceFolder = folderPath(settings.sourceFolder),
    outputFolder = folderPath(settings.outputFolder);
  if (
    sourceFolder === outputFolder ||
    sourceFolder.startsWith(outputFolder + "/") ||
    outputFolder.startsWith(sourceFolder + "/")
  )
    throw new Error(
      "Source and output folders must be separate and must not contain one another.",
    );
  for (const n of [settings.strokeScale, settings.textLineHeight])
    if (!Number.isFinite(n) || n <= 0)
      throw new Error("Scale and line height must be positive finite numbers.");
  return { ...settings, sourceFolder, outputFolder };
}
export function loadState(raw: unknown): State {
  const state = initialState();
  if (!raw || typeof raw !== "object") return state;
  const data = raw as Partial<State>;
  if (data.version !== 1)
    throw new Error(
      "Unsupported importer state version. Your saved data has been left unchanged.",
    );
  state.settings = validateSettings({ ...defaults, ...data.settings });
  state.paused = data.paused === true;
  if (data.records && typeof data.records === "object")
    for (const [path, record] of Object.entries(data.records)) {
      if (
        !record ||
        record.source !== path ||
        typeof record.status !== "string"
      )
        continue;
      state.records[path] = {
        ...record,
        status: record.status === "working" ? "failed" : record.status,
        error:
          record.status === "working"
            ? "Import interrupted; retry is available."
            : record.error,
        lastAttemptHash:
          record.status === "working" ? undefined : record.lastAttemptHash,
      };
    }
  state.staging = Array.isArray(data.staging)
    ? data.staging.filter((p) => typeof p === "string")
    : [];
  return state;
}
