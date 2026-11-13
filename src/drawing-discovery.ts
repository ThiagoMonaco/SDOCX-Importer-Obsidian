import { TFile, TFolder } from "obsidian";

export function findLinkedDrawing(
  folder: TFolder | null,
  key: string,
  sourceLink: (file: TFile) => unknown,
): string | undefined {
  if (!folder) return undefined;
  const pending = [folder];
  const prefix = key + ":";
  let match: string | undefined;
  while (pending.length) {
    for (const entry of pending.pop()!.children) {
      if (entry instanceof TFolder) pending.push(entry);
      else if (
        entry instanceof TFile &&
        entry.extension === "md" &&
        String(sourceLink(entry) ?? "").startsWith(prefix)
      ) {
        if (match !== undefined) return undefined;
        match = entry.path;
      }
    }
  }
  return match;
}
