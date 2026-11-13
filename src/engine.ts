import {
  checkAbort,
  convertSdocx,
  type ConversionOptions,
  type ConversionResult,
  hash,
  readSdocxIdentity,
} from "@sdocx-importer/converter";
import type { State } from "./state";
import { readSourceLink, sourceRevision } from "./source-link";
export type Decision = "replace" | "version" | "skip";
export function sourceKey(path: string) {
  return hash(new TextEncoder().encode(path));
}
export const drawingTitle = (path: string) =>
  path
    .split("/")
    .pop()!
    .replace(/\.excalidraw(?:\.md)?$/i, "")
    .trim();
export function fileTitle(title: string) {
  const safe = Array.from(title, (char) =>
    char.charCodeAt(0) < 32 || '\\/:*?"<>|#^[]'.includes(char) ? "_" : char,
  ).join("");
  return Array.from(safe.replace(/^\.+|[. ]+$/g, "").trim())
    .slice(0, 60)
    .join("");
}
export interface ImportHost {
  listSources(): string[] | Promise<string[]>;
  readSource(path: string): Promise<Uint8Array | null>;
  targetRevision(path: string): Promise<string | null>;
  drawingSource?(path: string): Promise<{
    key: string;
    revision: string;
    drawingHash: string;
  } | null>;
  publish(
    result: ConversionResult,
    path: string,
    replace: boolean,
    expectedRevision: string | null,
    checkSource: () => Promise<void>,
    publication: { source: string; hash: string; key?: string },
  ): Promise<void>;
  exists(path: string): boolean;
  renameDrawing?(from: string, to: string): Promise<void>;
  findDrawing?(source: string, key?: string): Promise<string | undefined>;
  sourceExists?(path: string): Promise<boolean>;
  save(state: State): Promise<void>;
  notice(message: string): void;
  changed(progressOnly?: boolean): void;
  dependencyError(): string | null;
}
interface Job {
  path: string;
  action?: Decision;
  expectedHash?: string;
  retry?: boolean;
}
export class ImportEngine {
  private timers = new Map<string, number>();
  private queue = new Map<string, Job>();
  private running?: Promise<void>;
  private active?: Job;
  private controller?: AbortController;
  private stopped = false;
  private suspended = false;
  private saves: Promise<void> = Promise.resolve();
  private exclusive: Promise<unknown> = Promise.resolve();
  private dependencyNotice?: string;
  progress = "";
  scanMessage = "";
  private scanning?: Promise<void>;
  constructor(
    readonly state: State,
    private host: ImportHost,
    private convert: typeof convertSdocx = convertSdocx,
  ) {}
  accepts(path: string) {
    return (
      path.startsWith(this.state.settings.sourceFolder + "/") &&
      /\.sdocx$/i.test(path)
    );
  }
  schedule(path: string) {
    if (!this.accepts(path) || this.state.paused || this.stopped) return;
    const previous = this.timers.get(path);
    if (previous) window.clearTimeout(previous);
    this.timers.set(
      path,
      window.setTimeout(() => {
        this.timers.delete(path);
        this.enqueue({ path });
      }, 500),
    );
  }
  scan(report = false): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanSources(report).finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }
  private async scanSources(report: boolean) {
    try {
      if (this.state.paused) {
        this.scanMessage = "Watching is paused. Click Resume before scanning.";
      } else {
        const paths = (await this.host.listSources()).filter((path) =>
          this.accepts(path),
        );
        if (this.stopped || this.state.paused) return;
        const dependency = this.host.dependencyError();
        this.scanMessage =
          dependency ??
          (paths.length
            ? `Found ${paths.length} SDOCX file${paths.length === 1 ? "" : "s"} in ${this.state.settings.sourceFolder}. Checking for new or changed imports.`
            : `No SDOCX files found in ${this.state.settings.sourceFolder}. Check the source folder in settings.`);
        if (report && dependency) this.dependencyNotice = dependency;
        for (const path of paths) this.enqueue({ path });
      }
    } catch (error) {
      this.scanMessage = `Inbox scan failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (report) this.host.notice(this.scanMessage);
    this.host.changed();
  }
  async retry() {
    for (const record of Object.values(this.state.records))
      if (record.status === "failed" && this.accepts(record.source))
        this.enqueue({ path: record.source, retry: true });
    await this.idle();
  }
  async decide(path: string, action: Decision) {
    const record = this.state.records[path];
    if (!record?.pendingHash || this.active?.path === path) return;
    this.enqueue({ path, action, expectedHash: record.pendingHash });
    await this.idle();
  }
  private enqueue(job: Job) {
    if (this.stopped || this.state.paused || !this.accepts(job.path)) return;
    const old = this.queue.get(job.path);
    if (!old?.action || job.action) this.queue.set(job.path, job);
    this.kick();
  }
  private kick() {
    if (
      this.running ||
      this.stopped ||
      this.suspended ||
      this.state.paused ||
      !this.queue.size
    )
      return;
    const error = this.host.dependencyError();
    if (error) {
      if (error !== this.dependencyNotice) this.host.notice(error);
      this.dependencyNotice = error;
      return;
    }
    this.dependencyNotice = undefined;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.kick();
    });
  }
  async idle() {
    if (this.scanning) await this.scanning;
    while (this.running) await this.running;
    await this.saves;
  }
  withImportsSuspended<T>(action: () => Promise<T>): Promise<T> {
    const next = this.exclusive
      .catch(() => {})
      .then(async () => {
        this.suspended = true;
        try {
          await this.idle();
          return await action();
        } finally {
          this.suspended = false;
          this.kick();
        }
      });
    this.exclusive = next;
    return next;
  }
  async persist() {
    const snapshot = structuredClone(this.state);
    const next = this.saves
      .catch(() => {})
      .then(() => this.host.save(snapshot));
    this.saves = next;
    await next;
    this.host.changed();
  }
  async setPaused(paused: boolean) {
    this.state.paused = paused;
    if (paused) {
      for (const timer of this.timers.values()) window.clearTimeout(timer);
      this.timers.clear();
      this.queue.clear();
      this.controller?.abort();
    }
    await this.persist();
    if (!paused) await this.scan();
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    this.queue.clear();
  }
  private async drain() {
    while (
      this.queue.size &&
      !this.stopped &&
      !this.suspended &&
      !this.state.paused
    ) {
      if (this.host.dependencyError()) return;
      const job = this.queue.values().next().value!;
      this.queue.delete(job.path);
      this.active = job;
      try {
        await this.process(job);
      } catch (err) {
        this.host.notice(`Importer could not save state: ${String(err)}`);
        this.queue.clear();
        return;
      } finally {
        this.active = undefined;
      }
    }
  }
  private async process(job: Job) {
    try {
      await this.processFile(job);
    } catch (error) {
      const record = this.state.records[job.path] ?? {
        source: job.path,
        status: "failed" as const,
        updatedAt: Date.now(),
      };
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      this.state.records[job.path] = record;
      await this.persist();
      this.host.notice(`Import failed: ${job.path}. ${record.error}`);
    }
  }
  private async processFile(job: Job) {
    // An ambiguous reverse write is recovered before any source is reimported.
    if (this.state.records[job.path]?.exporting) return;
    const bytes = await this.host.readSource(job.path);
    if (!bytes || !this.accepts(job.path)) return;
    const revision = sourceRevision(bytes);
    let record = this.state.records[job.path];
    const link = readSourceLink(bytes);
    if (!record && !link && this.host.sourceExists) {
      const originalKey = sourceKey(job.path);
      const moved = Object.values(this.state.records).find(
        (item) => item.linkKey === originalKey,
      );
      if (moved && (await this.host.sourceExists(moved.source))) return;
    }
    if (!record && link && this.host.sourceExists) {
      const matches = Object.values(this.state.records).filter(
        (item) => (item.linkKey ?? sourceKey(item.source)) === link.key,
      );
      if (matches.length > 1)
        throw new Error("Multiple records share the renamed SDOCX link.");
      const previous = matches[0];
      if (previous) {
        if (
          previous.exporting ||
          previous.publishing ||
          (await this.host.sourceExists(previous.source))
        )
          return;
        delete this.state.records[previous.source];
        previous.source = job.path;
        previous.linkKey = link.key;
        record = this.state.records[job.path] = previous;
        await this.persist();
      } else {
        const folder = job.path.slice(0, job.path.lastIndexOf("/") + 1);
        for (const item of link.previous) {
          const oldPath = folder + item.name;
          if (
            oldPath !== job.path &&
            sourceKey(oldPath) === link.key &&
            (await this.host.sourceExists(oldPath))
          )
            return;
        }
      }
    }
    if (record?.destination && !this.host.exists(record.destination)) {
      const renamed = await this.host.findDrawing?.(job.path, record.linkKey);
      if (renamed) {
        record.destination = renamed;
        await this.persist();
      } else if (!job.action && record.acceptedHash && this.host.findDrawing) {
        // A vault rename may arrive as deletion followed by creation on a peer.
        // Wait for the linked file instead of creating another drawing.
        if (
          revision !== record.acceptedHash &&
          revision !== record.pendingHash
        ) {
          record.pendingHash = revision;
          record.status = "pending";
          await this.persist();
        }
        return;
      }
    }
    const identity =
      record?.acceptedHash === revision &&
      record.sourceContentHash !== undefined
        ? undefined
        : await readSdocxIdentity(bytes).catch(() => undefined);
    if (record && identity) {
      const titleChanged =
        record.sourceTitle !== undefined
          ? identity.title !== record.sourceTitle
          : !!identity.title &&
            !!record.destination &&
            fileTitle(identity.title) !== drawingTitle(record.destination);
      if (
        record.pendingTitle === identity.title &&
        record.sourceContentHash === identity.contentHash
      ) {
        record.sourceTitle = identity.title;
        record.pendingTitle = undefined;
        record.acceptedHash = revision;
        record.pendingHash = undefined;
        record.status = "imported";
        record.error = undefined;
        await this.persist();
      }
      if (
        titleChanged &&
        record.acceptedHash !== revision &&
        record.destination &&
        this.host.exists(record.destination) &&
        record.pendingTitle === undefined &&
        this.host.renameDrawing
      ) {
        const from = record.destination;
        const title =
          fileTitle(identity.title) ||
          job.path
            .split("/")
            .pop()!
            .replace(/\.sdocx$/i, "");
        const stem = from.slice(0, from.lastIndexOf("/") + 1) + title;
        const suffix =
          from.match(/\.excalidraw(?:\.md)?$/i)?.[0] ?? ".excalidraw.md";
        let to = stem + suffix;
        for (let n = 2; to !== from && this.host.exists(to); n++)
          to = `${stem} (${n})${suffix}`;
        if (to !== from) {
          const latest = await this.host.readSource(job.path);
          if (!latest || sourceRevision(latest) !== revision) return;
          await this.host.renameDrawing(from, to);
          record.destination = to;
        }
        record.sourceTitle = identity.title;
        if (record.sourceContentHash === identity.contentHash) {
          record.acceptedHash = revision;
          record.pendingHash = undefined;
          record.status = "imported";
          record.error = undefined;
        }
        await this.persist();
      }
      if (
        record.acceptedHash === revision &&
        record.sourceContentHash === undefined
      ) {
        record.sourceTitle = identity.title;
        record.sourceContentHash = identity.contentHash;
        await this.persist();
      }
    }
    if (job.expectedHash && revision !== job.expectedHash) {
      if (record) {
        record.pendingHash = revision;
        record.status = "pending";
        await this.persist();
      }
      return;
    }
    if (
      !job.action &&
      (record?.acceptedHash === revision ||
        record?.skippedHash === revision ||
        record?.pendingHash === revision ||
        (!job.retry &&
          record?.status === "failed" &&
          record.lastAttemptHash === revision))
    )
      return;
    if (!record)
      record = this.state.records[job.path] = {
        source: job.path,
        linkKey: link?.key,
        status: "working",
        updatedAt: Date.now(),
      };
    const relative = job.path
      .slice(this.state.settings.sourceFolder.length + 1)
      .replace(/\.sdocx$/i, "");
    const title = fileTitle(identity?.title ?? "");
    const name = title
      ? relative.slice(0, relative.lastIndexOf("/") + 1) + title
      : relative;
    const stem = this.state.settings.outputFolder + "/" + name;
    let available = stem + ".excalidraw.md";
    if (!record.acceptedHash && !job.action && this.host.drawingSource) {
      const key = record.linkKey ?? sourceKey(job.path);
      available = (await this.host.findDrawing?.(job.path, key)) ?? available;
      for (let n = 2; this.host.exists(available); n++) {
        const link = await this.host.drawingSource(available);
        if (link?.key === key) {
          record.destination = available;
          record.acceptedHash = link.revision;
          record.drawingHash = link.drawingHash;
          record.updatedAt = Date.now();
          record.error = undefined;
          if (revision === link.revision) {
            record.sourceTitle = identity?.title;
            record.sourceContentHash = identity?.contentHash;
            record.pendingHash = undefined;
            record.status = "imported";
            await this.persist();
            return;
          }
          record.pendingHash = revision;
          record.status = "pending";
          await this.persist();
          this.host.notice(
            "A synced drawing already exists. Review the changed SDOCX before replacing it.",
          );
          return;
        }
        available = `${stem} (${n}).excalidraw.md`;
      }
    }
    if (job.action === "skip") {
      record.skippedHash = revision;
      record.pendingHash = undefined;
      record.status = "skipped";
      record.error = undefined;
      await this.persist();
      return;
    }
    if (
      !job.action &&
      (record.pendingHash ||
        (record.acceptedHash && !this.state.settings.autoReplace))
    ) {
      const first = !record.pendingHash;
      record.pendingHash = revision;
      record.status = "pending";
      record.error = undefined;
      record.updatedAt = Date.now();
      await this.persist();
      if (first)
        this.host.notice(
          "SDOCX source changed. Review pending imports to replace, version, or skip.",
        );
      return;
    }
    this.controller = new AbortController();
    const signal = this.controller.signal,
      settings = { ...this.state.settings };
    const replace =
      !!record.destination &&
      (job.action === "replace" || (!job.action && settings.autoReplace));
    let target = record.destination;
    if (!replace || !target || !this.host.exists(target)) {
      target = available;
      for (let n = 2; this.host.exists(target); n++)
        target = `${stem} (${n}).excalidraw.md`;
    }
    const replacing =
      replace && target === record.destination && this.host.exists(target);
    const expectedRevision = replacing
      ? await this.host.targetRevision(target)
      : null;
    record.status = "working";
    record.lastAttemptHash = revision;
    record.error = undefined;
    record.updatedAt = Date.now();
    await this.persist();
    try {
      const options: ConversionOptions = {
        ...settings,
        signal,
        onProgress: (p) => {
          this.progress = `${job.path}: ${p.phase} ${p.completed}/${p.total}`;
          this.host.changed(true);
        },
      };
      const result = await this.convert(bytes, options);
      const checkSource = async () => {
        checkAbort(signal);
        if (!this.accepts(job.path))
          throw new Error("Source folder changed during conversion.");
        const current = await this.host.readSource(job.path);
        if (!current || sourceRevision(current) !== revision)
          throw new Error(
            "Source changed during conversion; waiting for a stable revision.",
          );
      };
      await checkSource();
      await this.host.publish(
        result,
        target,
        replacing,
        expectedRevision,
        checkSource,
        { source: job.path, hash: revision, key: record.linkKey },
      );
      record.drawingHash = record.publishing?.contentHash;
      record.publishing = undefined;
      record.acceptedHash = revision;
      record.sourceTitle = identity?.title;
      record.sourceContentHash = identity?.contentHash;
      record.pendingHash = undefined;
      record.skippedHash = undefined;
      record.destination = target;
      record.status = "imported";
      record.warnings = result.warnings;
      record.statistics = result.statistics;
      record.updatedAt = Date.now();
      await this.persist();
    } catch (err) {
      record.status = record.pendingHash ? "pending" : "failed";
      if (signal.aborted) record.lastAttemptHash = undefined;
      record.error = signal.aborted
        ? "Import cancelled; retry is available."
        : err instanceof Error
          ? err.message
          : String(err);
      await this.persist();
      if (!signal.aborted)
        this.host.notice(`Import failed: ${job.path}. ${record.error}`);
    } finally {
      this.controller = undefined;
      this.progress = "";
      this.host.changed();
    }
  }
}
