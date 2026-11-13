import { loadState, State } from "./state";
/** App local storage is scoped to this vault on this device, outside Sync's plugin files. */
export const deviceStateKey = "samsung-notes-importer:device-state:v1";
export interface DeviceStorage {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}
export function readDeviceState(
  storage: DeviceStorage,
  shared: unknown,
): State {
  const local = storage.loadLocalStorage(deviceStateKey);
  return loadState(local ?? shared);
}
export async function saveDeviceState(
  storage: DeviceStorage,
  state: State,
  sharedSave: (state: State) => Promise<void>,
) {
  // Persist the journal locally before touching a source or shared configuration.
  // Keep data.json as a migration fallback for devices installing this version.
  storage.saveLocalStorage(deviceStateKey, state);
  await sharedSave(state);
}
