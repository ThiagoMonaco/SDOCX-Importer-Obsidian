/** Read source names directly from the vault adapter, including unregistered extensions. */
export interface InboxAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
export async function discoverSources(
  adapter: InboxAdapter,
  folder: string,
): Promise<string[]> {
  if (!(await adapter.exists(folder))) return [];
  const pending = [folder],
    seen = new Set<string>(),
    files = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const entries = await adapter.list(current);
    for (const path of entries.files)
      if (path.startsWith(folder + "/") && /\.sdocx$/i.test(path))
        files.add(path);
    for (const path of entries.folders)
      if (
        path.startsWith(folder + "/") &&
        !path
          .slice(folder.length + 1)
          .split("/")
          .some((part) => part.startsWith("."))
      )
        pending.push(path);
  }
  return [...files].sort();
}
