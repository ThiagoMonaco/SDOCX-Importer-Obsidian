import { describe, expect, it, vi } from "vitest";
import {
  deviceStateKey,
  readDeviceState,
  saveDeviceState,
} from "../src/storage";
import { initialState } from "../src/state";
describe("device-local tracking", () => {
  it("migrates existing tracking and settings when the local store is absent", () => {
    const shared = initialState();
    shared.settings.outputFolder = "SDOCX/Out";
    shared.records.a = {
      source: "a",
      acceptedHash: "old",
      status: "imported",
      updatedAt: 0,
    };
    const result = readDeviceState(
      { loadLocalStorage: () => null, saveLocalStorage: () => {} },
      shared,
    );
    expect(result.records.a.acceptedHash).toBe("old");
    expect(result.settings.outputFolder).toBe("SDOCX/Out");
  });
  it("retains accepted export revisions when synchronized plugin data is replaced", async () => {
    const old = initialState(),
      local = initialState();
    old.records.a = {
      source: "a",
      acceptedHash: "old",
      pendingHash: "new",
      status: "pending",
      updatedAt: 0,
    };
    local.records.a = {
      source: "a",
      acceptedHash: "new",
      status: "imported",
      updatedAt: 1,
    };
    let saved: unknown = null;
    const storage = {
      loadLocalStorage: () => saved,
      saveLocalStorage: vi.fn((_key, value) => {
        saved = structuredClone(value);
      }),
    };
    await saveDeviceState(storage, local, async () => {});
    expect(storage.saveLocalStorage).toHaveBeenCalledWith(
      deviceStateKey,
      local,
    );
    expect(readDeviceState(storage, old).records.a).toEqual(local.records.a);
  });
  it("preserves a publication journal locally when writing the shared file fails", async () => {
    const state = initialState();
    state.records.a = {
      source: "a",
      status: "imported",
      updatedAt: 0,
      exporting: { previousHash: "old", contentHash: "new", backup: "backup" },
    };
    let local: unknown;
    const storage = {
      loadLocalStorage: () => local,
      saveLocalStorage: (_key: string, value: unknown) => {
        local = structuredClone(value);
      },
    };
    await expect(
      saveDeviceState(storage, state, async () => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    expect(
      readDeviceState(storage, null).records.a.exporting?.contentHash,
    ).toBe("new");
  });
  it("refuses an unsupported local state instead of silently using older synchronized data", () => {
    expect(() =>
      readDeviceState(
        {
          loadLocalStorage: () => ({ version: 2 }),
          saveLocalStorage: () => {},
        },
        initialState(),
      ),
    ).toThrow("Unsupported");
  });
});
