import { hash } from "@sdocx-importer/converter";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const prefix = "NotesVaultLink/1 ";
export interface SourceLink {
  key: string;
  previous: { name: string; hash: string }[];
}

function comment(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 131072);
    at--
  ) {
    if (view.getUint32(at, true) !== 0x06054b50) continue;
    const start = at + 22;
    const end = start + view.getUint16(at + 20, true);
    if (end > bytes.length) continue;
    const line = bytes.subarray(start, end).indexOf(10);
    if (line < 0 || line > 16384) return { start, end };
    const header = decoder.decode(bytes.subarray(start, start + line));
    if (!header.startsWith(prefix)) return { start, end };
    try {
      const link = JSON.parse(header.slice(prefix.length)) as SourceLink;
      if (
        !/^[a-f0-9]{64}$/.test(link.key) ||
        !Array.isArray(link.previous) ||
        link.previous.length > 32 ||
        !link.previous.every(
          (item) =>
            typeof item.name === "string" &&
            !/[\\/]/.test(item.name) &&
            /\.sdocx$/i.test(item.name) &&
            /^[a-f0-9]{64}$/.test(item.hash),
        )
      )
        return { start, end };
      return { start, end, link, rest: start + line + 1 };
    } catch {
      return { start, end };
    }
  }
  return undefined;
}

export const readSourceLink = (bytes: Uint8Array) => comment(bytes)?.link;

function replaceComment(
  bytes: Uint8Array,
  start: number,
  end: number,
  next: Uint8Array,
) {
  if (next.length > 65535) throw new Error("SDOCX ZIP comment is full");
  const result = new Uint8Array(bytes.length - (end - start) + next.length);
  result.set(bytes.subarray(0, start));
  result.set(next, start);
  result.set(bytes.subarray(end), start + next.length);
  new DataView(result.buffer).setUint16(start - 2, next.length, true);
  return result;
}

/** Link metadata does not constitute a new drawing revision. */
export function sourceRevision(bytes: Uint8Array) {
  const tag = comment(bytes);
  if (tag?.rest === undefined) return hash(bytes);
  const length = tag.end - tag.rest;
  return bytesToHex(
    sha256
      .create()
      .update(bytes.subarray(0, tag.start - 2))
      .update(Uint8Array.of(length & 255, length >>> 8))
      .update(bytes.subarray(tag.rest))
      .digest(),
  );
}

export function writeSourceLink(bytes: Uint8Array, link: SourceLink) {
  const tag = comment(bytes);
  if (!tag) throw new Error("SDOCX ZIP comment could not be located");
  const line = encoder.encode(prefix + JSON.stringify(link) + "\n");
  const original = bytes.subarray(tag.rest ?? tag.start, tag.end);
  const next = new Uint8Array(line.length + original.length);
  next.set(line);
  next.set(original, line.length);
  return replaceComment(bytes, tag.start, tag.end, next);
}

export function rememberSource(
  bytes: Uint8Array,
  key: string,
  path: string,
): SourceLink {
  const link = readSourceLink(bytes);
  const name = path.split("/").pop()!;
  const previous = { name, hash: hash(bytes) };
  const history = (link?.previous ?? []).filter(
    (item) => item.hash !== previous.hash,
  );
  const retained =
    history.length <= 31 ? history : [...history.slice(0, 30), history.at(-1)!];
  return { key, previous: [previous, ...retained] };
}
