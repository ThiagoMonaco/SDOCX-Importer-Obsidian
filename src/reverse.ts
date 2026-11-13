import {
  convertExcalidraw,
  type Scene,
  hash,
  readSdocxIdentity,
  readSdocxPageSize,
  readSdocxTitle,
  renameSdocx,
} from "@sdocx-importer/converter";
import { ImportRecord, State } from "./state";
import { fileTitle, sourceKey } from "./engine";
import {
  readSourceLink,
  rememberSource,
  sourceRevision,
  writeSourceLink,
} from "./source-link";

export interface ExportHost {
  read(path: string): Promise<Uint8Array | null>;
  backup(path: string, bytes: Uint8Array): Promise<void>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  save(): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}
export interface ExportPlan {
  source: string;
  destination: string;
  expectedHash: string;
  drawingHash?: string;
  bytes: Uint8Array;
  warnings: string[];
  title?: string;
  sourceContentHash?: string;
  keepPendingContent?: boolean;
  verifyDrawing(): Promise<void>;
}
function finishPublication(
  record: ImportRecord,
  revision: string,
  drawingHash?: string,
  title?: string,
  sourceContentHash?: string,
  keepPendingContent?: boolean,
) {
  if (!keepPendingContent) {
    record.acceptedHash = revision;
    record.drawingHash = drawingHash;
    record.sourceContentHash = sourceContentHash;
  }
  record.pendingHash = keepPendingContent ? revision : undefined;
  record.skippedHash = undefined;
  record.lastAttemptHash = undefined;
  record.status = keepPendingContent ? "pending" : "imported";
  record.error = undefined;
  record.exporting = undefined;
  if (title !== undefined) {
    record.sourceTitle = title;
    if (record.pendingTitle === title) record.pendingTitle = undefined;
  }
  record.updatedAt = Date.now();
}
/** Source publication is serialized with imports by the caller. Backups are retained. */
export class ReverseExporter {
  constructor(
    private state: State,
    private host: ExportHost,
  ) {}
  async syncFilename(record: ImportRecord) {
    if (
      !this.host.rename ||
      !record.destination ||
      !record.acceptedHash ||
      record.pendingTitle !== undefined ||
      record.exporting ||
      record.publishing
    )
      return;
    const title = fileTitle(record.sourceTitle ?? "");
    if (!title) return;
    const from = record.source;
    const directory = from.slice(0, from.lastIndexOf("/") + 1);
    const stem = directory + title;
    if (
      from === stem + ".sdocx" ||
      (from.startsWith(stem + " (") &&
        /^ \(\d+\)\.sdocx$/.test(from.slice(stem.length)))
    )
      return;
    const bytes = await this.host.read(from);
    if (!bytes) return;
    const revision = sourceRevision(bytes);
    if (
      ![record.acceptedHash, record.pendingHash, record.skippedHash].includes(
        revision,
      )
    )
      return;
    if ((await readSdocxTitle(bytes)) !== record.sourceTitle) return;
    const key = record.linkKey ?? sourceKey(from);
    let to = stem + ".sdocx";
    for (let n = 2; ; n++) {
      const occupant = await this.host.read(to);
      if (!occupant || to.toLowerCase() === from.toLowerCase()) break;
      if (readSourceLink(occupant)?.key === key) return;
      to = `${stem} (${n}).sdocx`;
    }
    const marked = writeSourceLink(bytes, rememberSource(bytes, key, from));
    const before = hash(bytes);
    await this.backupSource(from, bytes);
    const current = await this.host.read(from);
    if (
      !current ||
      hash(current) !== before ||
      record.source !== from ||
      record.pendingTitle !== undefined
    )
      return;
    await this.host.write(from, marked);
    const staged = await this.host.read(from);
    if (!staged || hash(staged) !== hash(marked))
      throw new Error("Could not verify the linked SDOCX before renaming.");
    await this.host.rename(from, to);
    delete this.state.records[from];
    record.source = to;
    record.linkKey = key;
    this.state.records[to] = record;
    await this.host.save();
  }
  async rename(record: ImportRecord) {
    const title = record.pendingTitle;
    const destination = record.destination;
    if (
      title === undefined ||
      !destination ||
      !record.acceptedHash ||
      record.exporting ||
      record.publishing
    )
      return;
    const original = await this.host.read(record.source);
    if (!original) return;
    const expectedHash = sourceRevision(original);
    const keepPendingContent = record.pendingHash === expectedHash;
    if (!keepPendingContent && expectedHash !== record.acceptedHash) return;
    const previous = await readSdocxIdentity(original);
    if (previous.title === title) {
      record.sourceTitle = title;
      if (!keepPendingContent) record.sourceContentHash = previous.contentHash;
      record.pendingTitle = undefined;
      await this.host.save();
      return;
    }
    // A different remote title arrived while this local rename was queued.
    // Existing content review reconciles that source before we try again.
    if (keepPendingContent && previous.title !== record.sourceTitle) return;
    const verifyDrawing = async () => {
      if (record.destination !== destination || record.pendingTitle !== title)
        throw new Error(
          "Drawing was renamed again. The latest name will sync on the next pass.",
        );
    };
    await this.commit({
      source: record.source,
      destination,
      expectedHash,
      drawingHash: record.drawingHash,
      bytes: writeSourceLink(
        await renameSdocx(original, title),
        rememberSource(
          original,
          record.linkKey ?? sourceKey(record.source),
          record.source,
        ),
      ),
      warnings: [],
      title,
      sourceContentHash: previous.contentHash,
      keepPendingContent,
      verifyDrawing,
    });
  }
  async prepare(
    destination: string,
    scene: Scene,
    verifyDrawing: () => Promise<void>,
    drawingHash?: string,
    originalPageSize?: Awaited<ReturnType<typeof readSdocxPageSize>>,
  ): Promise<ExportPlan> {
    const matches = Object.values(this.state.records).filter(
      (r) => r.destination === destination,
    );
    if (matches.length !== 1 || !matches[0].acceptedHash)
      throw new Error(
        "This drawing has no unique linked SDOCX import. Import an SDOCX file first.",
      );
    const record = matches[0];
    if (record.publishing || record.exporting)
      throw new Error(
        "A previous publication needs recovery. Reload the plugin before exporting.",
      );
    const old = await this.host.read(record.source);
    if (!old)
      throw new Error(
        "Linked SDOCX file is missing. Restore it before exporting.",
      );
    const expectedHash = sourceRevision(old);
    if (expectedHash !== record.acceptedHash || record.pendingHash)
      throw new Error(
        "The SDOCX source changed. Review its pending import before exporting this drawing.",
      );
    const fallback = destination
      .split("/")
      .pop()!
      .replace(/\.excalidraw(?:\.md)?$/i, "");
    const title =
      record.pendingTitle ?? (await readSdocxTitle(old).catch(() => fallback));
    const sourcePageSize = originalPageSize ?? (await readSdocxPageSize(old));
    const result = await convertExcalidraw(scene, title, { sourcePageSize });
    if (record.linkKey || readSourceLink(old)) {
      result.bytes = writeSourceLink(
        result.bytes,
        rememberSource(
          old,
          record.linkKey ?? sourceKey(record.source),
          record.source,
        ),
      );
    }
    const written = await readSdocxIdentity(result.bytes);
    await verifyDrawing();
    return {
      source: record.source,
      destination,
      expectedHash,
      drawingHash,
      title: written.title,
      sourceContentHash: written.contentHash,
      ...result,
      verifyDrawing,
    };
  }
  async commit(plan: ExportPlan) {
    const record = this.state.records[plan.source];
    if (
      !record ||
      record.destination !== plan.destination ||
      (plan.keepPendingContent
        ? record.pendingHash !== plan.expectedHash
        : record.acceptedHash !== plan.expectedHash || !!record.pendingHash) ||
      record.exporting ||
      record.publishing
    )
      throw new Error(
        "Import tracking changed. Review the source and retry export.",
      );
    const check = async () => {
      await plan.verifyDrawing();
      const bytes = await this.host.read(plan.source);
      if (!bytes || sourceRevision(bytes) !== plan.expectedHash)
        throw new Error(
          "SDOCX changed during export. No replacement was made; review the incoming source.",
        );
      return bytes;
    };
    const backup = await this.backupSource(plan.source, await check());
    const revision = sourceRevision(plan.bytes);
    record.exporting = {
      previousHash: plan.expectedHash,
      contentHash: revision,
      backup,
      drawingHash: plan.drawingHash,
      title: plan.title,
      sourceContentHash: plan.sourceContentHash,
      keepPendingContent: plan.keepPendingContent,
    };
    await this.host.save();
    try {
      await check();
    } catch (error) {
      // No source write was attempted. Let the next drawing save retry.
      record.exporting = undefined;
      await this.host.save();
      throw error;
    }
    // A rejected write can still reach disk. Keep the journal until verified.
    await this.host.write(plan.source, plan.bytes);
    const current = await this.host.read(plan.source);
    if (!current || hash(current) !== hash(plan.bytes))
      throw new Error(
        `Export could not be verified. Original backup: ${backup}. Reload before retrying.`,
      );
    finishPublication(
      record,
      revision,
      plan.drawingHash,
      plan.title,
      plan.sourceContentHash,
      plan.keepPendingContent,
    );
    await this.host.save();
    return backup;
  }
  private async backupSource(path: string, bytes: Uint8Array) {
    const name = path.split("/").pop()!;
    const backup = `${this.state.settings.outputFolder}/_backups/${Date.now()}-${crypto.randomUUID()}-${name}.bak`;
    await this.host.backup(backup, bytes);
    const saved = await this.host.read(backup);
    if (!saved || hash(saved) !== hash(bytes))
      throw new Error("Backup verification failed. Source was kept.");
    return backup;
  }
  async recover() {
    for (const record of Object.values(this.state.records)) {
      const journal = record.exporting;
      if (!journal) continue;
      const bytes = await this.host.read(record.source),
        revision = bytes ? sourceRevision(bytes) : undefined;
      if (revision === journal.contentHash)
        finishPublication(
          record,
          revision,
          journal.drawingHash,
          journal.title,
          journal.sourceContentHash,
          journal.keepPendingContent,
        );
      else {
        record.exporting = undefined;
        record.lastAttemptHash = undefined;
        record.status = "failed";
        record.error = `Export was interrupted; source was retained. Original backup: ${journal.backup}`;
        if (revision && revision !== journal.previousHash) {
          record.pendingHash = revision;
          record.status = "pending";
        }
      }
    }
    await this.host.save();
  }
}
