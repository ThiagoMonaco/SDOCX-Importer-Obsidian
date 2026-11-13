import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "esbuild";
import { convertSdocx, type ConversionResult } from "@sdocx-importer/converter";
import { runConversion } from "../src/runner";
import { syntheticNote, syntheticMembers } from "./synthetic";
import { zipSync } from "fflate";
beforeEach(() => vi.stubGlobal("window", { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());
describe("complete portable conversion", () => {
  it("converts a synthetic note without personal fixtures or Go", async () => {
    const r = await convertSdocx(syntheticNote(), { pageFrames: true });
    expect(r.statistics).toMatchObject({ pages: 1, strokes: 1, points: 3 });
    expect(r.scene.elements).toMatchObject([
      {
        type: "freedraw",
        strokeColor: "#123456",
        points: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        pressures: [0.5, 0.5, 0.5],
      },
      { type: "frame", name: "Page 1" },
    ]);
  });
  it("rejects unknown framing and unindexed pages", async () => {
    const members = syntheticMembers();
    const page = members["synthetic-page.page"].slice();
    const headerLength = new DataView(page.buffer).getUint32(0, true);
    page[headerLength + 4 + 16 + 4] = 99;
    await expect(
      convertSdocx(zipSync({ ...members, "synthetic-page.page": page })),
    ).rejects.toThrow("unknown object");
    await expect(
      convertSdocx(zipSync({ ...members, "extra.page": new Uint8Array() })),
    ).rejects.toThrow("absent from");
  });
  it("runs the actual browser worker bundle through messaging", async () => {
    const bundle = await build({
      entryPoints: ["src/worker.ts"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
    });
    const bridge =
      "const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;globalThis.postMessage=m=>parentPort.postMessage(m);parentPort.on('message',data=>globalThis.onmessage({data}));\n";
    const worker = new NodeWorker(bridge + bundle.outputFiles[0].text, {
        eval: true,
      }),
      bytes = syntheticNote();
    try {
      const received = await new Promise<ConversionResult>(
        (resolve, reject) => {
          worker.on("error", reject);
          worker.on("message", (data) => {
            if (data.type === "ready")
              worker.postMessage({ bytes: bytes.buffer, options: {} });
            if (data.type === "error") reject(new Error(data.error));
            if (data.type === "result") resolve(data.result);
          });
        },
      );
      expect(received).toEqual(await convertSdocx(bytes));
    } finally {
      await worker.terminate();
    }
  }, 15000);
  it("uses the cooperative converter when Worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    expect(await runConversion(syntheticNote())).toEqual(
      await convertSdocx(syntheticNote()),
    );
  });
  it("falls back when worker construction is blocked", async () => {
    vi.stubGlobal("CONVERTER_WORKER", "");
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("CSP");
        }
      },
    );
    expect((await runConversion(syntheticNote())).statistics.strokes).toBe(1);
  });
  it("cancels a running worker and terminates it", async () => {
    let terminated = false;
    vi.stubGlobal("CONVERTER_WORKER", "");
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((e: unknown) => void) | null = null;
        onerror = null;
        onmessageerror = null;
        constructor() {
          queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
        }
        postMessage() {}
        terminate() {
          terminated = true;
        }
      },
    );
    const c = new AbortController(),
      p = runConversion(syntheticNote(), { signal: c.signal });
    await Promise.resolve();
    c.abort();
    await expect(p).rejects.toThrow();
    expect(terminated).toBe(true);
  });
});
