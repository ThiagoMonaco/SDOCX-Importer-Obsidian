import { describe, it, expect, vi } from "vitest";
import { ReverseExporter, ExportHost } from "../src/reverse";
import { initialState } from "../src/state";
import {
  hash,
  convertExcalidraw,
  type Scene,
  readSdocxIdentity,
  readSdocxPageSize,
} from "@sdocx-importer/converter";
import { syntheticMembers } from "./synthetic";
import { zipSync } from "fflate";
import { readSourceLink, sourceRevision } from "../src/source-link";
function setup() {
  const state = initialState(),
    source = "SDOCX/Inbox/Test.sdocx",
    destination = "SDOCX/Drawings/Test.excalidraw.md";
  const members = syntheticMembers();
  const page = Object.entries(members).find(([name]) =>
    name.endsWith(".page"),
  )![1];
  const header = new DataView(page.buffer, page.byteOffset, page.byteLength);
  header.setUint32(22, 1600, true);
  header.setUint32(26, 2262, true);
  const original = zipSync(members),
    files = new Map([[source, original]]);
  state.records[source] = {
    source,
    destination,
    acceptedHash: hash(original),
    status: "imported",
    updatedAt: 0,
  };
  const host: ExportHost = {
    read: vi.fn(async (p) => files.get(p)?.slice() ?? null),
    backup: vi.fn(async (p, b) => {
      if (files.has(p)) throw new Error("exists");
      files.set(p, b.slice());
    }),
    write: vi.fn(async (p, b) => {
      files.set(p, b.slice());
    }),
    save: vi.fn(async () => {}),
  };
  const exporter = new ReverseExporter(state, host),
    verify = vi.fn(async () => {});
  const scene: Scene = {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [
      {
        id: "text",
        type: "text",
        text: "Exported",
        x: 20,
        y: 20,
        fontSize: 20,
        width: 100,
        height: 30,
      },
    ],
    files: {},
    appState: {},
  };
  return {
    state,
    source,
    destination,
    original,
    files,
    host,
    exporter,
    verify,
    scene,
    record: state.records[source],
  };
}
describe("Linked SDOCX publication", () => {
  it("syncs an Obsidian rename while keeping incoming drawing changes pending", async () => {
    const f = setup();
    const { bytes } = await convertExcalidraw(f.scene, "Samsung title");
    f.files.set(f.source, bytes);
    f.record.pendingHash = hash(bytes);
    f.record.sourceTitle = "Samsung title";
    f.record.pendingTitle = "Obsidian title";
    await f.exporter.rename(f.record);
    const updated = f.files.get(f.source)!;
    expect(await readSdocxIdentity(updated)).toEqual({
      title: "Obsidian title",
      contentHash: (await readSdocxIdentity(bytes)).contentHash,
    });
    expect(f.record).toMatchObject({
      acceptedHash: hash(f.original),
      pendingHash: sourceRevision(updated),
      status: "pending",
    });
    expect(f.record.pendingTitle).toBeUndefined();
  });
  it("moves an SDOCX and keeps the backup, revision, and drawing link", async () => {
    const f = setup();
    const { bytes } = await convertExcalidraw(f.scene, "Renamed");
    f.files.set(f.source, bytes);
    f.record.acceptedHash = hash(bytes);
    f.record.sourceTitle = "Renamed";
    f.host.rename = async (from, to) => {
      f.files.set(to, f.files.get(from)!);
      f.files.delete(from);
    };
    const occupied = "SDOCX/Inbox/Renamed.sdocx";
    f.files.set(occupied, f.original);
    await f.exporter.syncFilename(f.record);
    const renamed = "SDOCX/Inbox/Renamed (2).sdocx";
    const updated = f.files.get(renamed)!;
    expect(f.files.has(f.source)).toBe(false);
    expect(f.files.get(occupied)).toEqual(f.original);
    expect(f.state.records[renamed]).toBe(f.record);
    expect(f.record.destination).toBe(f.destination);
    expect(sourceRevision(updated)).toBe(hash(bytes));
    expect(readSourceLink(updated)?.previous).toContainEqual({
      name: "Test.sdocx",
      hash: hash(bytes),
    });
  });
  it("backs up exact original bytes, replaces linked source, and suppresses reimport feedback", async () => {
    const f = setup(),
      plan = await f.exporter.prepare(
        f.destination,
        f.scene,
        f.verify,
        "saved-drawing",
      ),
      backup = await f.exporter.commit(plan);
    expect(f.files.get(backup)).toEqual(f.original);
    expect(f.files.get(f.source)).toEqual(plan.bytes);
    expect(await readSdocxPageSize(plan.bytes)).toEqual({
      width: 1600,
      height: 2262,
    });
    expect(f.record.acceptedHash).toBe(hash(plan.bytes));
    expect(f.record.drawingHash).toBe("saved-drawing");
    expect(f.record.exporting).toBeUndefined();
    expect(f.record.pendingHash).toBeUndefined();
    expect(backup).toContain("/_backups/");
    expect(backup).toMatch(/\.sdocx\.bak$/);
  });
  it("rejects an unlinked drawing or changed source before conversion", async () => {
    const f = setup();
    await expect(
      f.exporter.prepare("unknown", f.scene, f.verify),
    ).rejects.toThrow("no unique linked");
    f.files.set(f.source, new Uint8Array([4]));
    await expect(
      f.exporter.prepare(f.destination, f.scene, f.verify),
    ).rejects.toThrow("source changed");
    expect(f.host.write).not.toHaveBeenCalled();
  });
  it("rejects a source changed after preview without replacing it", async () => {
    const f = setup(),
      plan = await f.exporter.prepare(f.destination, f.scene, f.verify),
      incoming = new Uint8Array([7]);
    f.files.set(f.source, incoming);
    await expect(f.exporter.commit(plan)).rejects.toThrow(
      "changed during export",
    );
    expect(f.files.get(f.source)).toEqual(incoming);
    expect(f.host.write).not.toHaveBeenCalled();
  });
  it("checks source and drawing again after backup and journal save", async () => {
    const f = setup(),
      plan = await f.exporter.prepare(f.destination, f.scene, f.verify);
    vi.mocked(f.host.save).mockImplementationOnce(async () => {
      f.files.set(f.source, new Uint8Array([9]));
    });
    await expect(f.exporter.commit(plan)).rejects.toThrow(
      "changed during export",
    );
    expect(f.host.write).not.toHaveBeenCalled();
    expect(f.record.exporting).toBeUndefined();
    expect(f.files.get(f.source)).toEqual(new Uint8Array([9]));
  });
  it("keeps source if backup, backup readback, or drawing verification fails", async () => {
    for (const failure of ["backup", "readback", "drawing"]) {
      const f = setup(),
        plan = await f.exporter.prepare(f.destination, f.scene, f.verify);
      if (failure === "backup")
        vi.mocked(f.host.backup).mockRejectedValueOnce(new Error("disk full"));
      if (failure === "readback")
        vi.mocked(f.host.backup).mockResolvedValueOnce();
      if (failure === "drawing")
        f.verify.mockRejectedValueOnce(new Error("Drawing changed"));
      await expect(f.exporter.commit(plan)).rejects.toThrow();
      expect(f.files.get(f.source)).toEqual(f.original);
      expect(f.host.write).not.toHaveBeenCalled();
    }
  });
  it("recovers a write that committed before storage reported an error", async () => {
    const f = setup(),
      plan = await f.exporter.prepare(f.destination, f.scene, f.verify);
    vi.mocked(f.host.write).mockImplementationOnce(async (p, b) => {
      f.files.set(p, b);
      throw new Error("interrupted");
    });
    await expect(f.exporter.commit(plan)).rejects.toThrow("interrupted");
    expect(f.record.exporting).toBeDefined();
    await f.exporter.recover();
    expect(f.record.acceptedHash).toBe(hash(plan.bytes));
    expect(f.record.exporting).toBeUndefined();
  });
  it("retains original source after a failed write and recovers without publishing", async () => {
    const f = setup(),
      plan = await f.exporter.prepare(f.destination, f.scene, f.verify);
    vi.mocked(f.host.write).mockRejectedValueOnce(new Error("no space"));
    await expect(f.exporter.commit(plan)).rejects.toThrow("no space");
    await expect(
      f.exporter.prepare(f.destination, f.scene, f.verify),
    ).rejects.toThrow("needs recovery");
    await f.exporter.recover();
    expect(f.files.get(f.source)).toEqual(f.original);
    expect(f.record.error).toContain("Original backup");
  });
  it("rejects a stale plan after relinking, pending import, or another export", async () => {
    for (const change of ["relink", "pending", "export"]) {
      const f = setup(),
        plan = await f.exporter.prepare(f.destination, f.scene, f.verify);
      if (change === "relink") f.record.destination = "other";
      if (change === "pending") f.record.pendingHash = "pending";
      if (change === "export") f.record.acceptedHash = "another";
      await expect(f.exporter.commit(plan)).rejects.toThrow("tracking changed");
      expect(f.host.write).not.toHaveBeenCalled();
    }
  });
});
