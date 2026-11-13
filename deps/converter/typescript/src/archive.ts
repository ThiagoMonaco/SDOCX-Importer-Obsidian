import { Inflate } from "fflate";
import { Context, limits } from "./model";
import { Reader } from "./reader";
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[i] = c >>> 0;
}
export function crc32(data: Uint8Array, seed = 0) {
  let crc = seed ^ -1;
  for (const b of data) crc = (crc >>> 8) ^ table[(crc ^ b) & 255];
  return (crc ^ -1) >>> 0;
}
interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}
/** Classic ZIP reader; central-directory preflight precedes any decompression. No extraction. */
export class Archive {
  readonly entries = new Map<string, Entry>();
  private consumed = 0;
  private centralOffset = 0;
  readonly footer: Uint8Array;
  constructor(
    private bytes: Uint8Array,
    private ctx: Context,
  ) {
    const r = new Reader(bytes);
    let end = -1;
    // Samsung may append a small raw footer after EOCD.
    for (
      let p = bytes.length - 22;
      p >= Math.max(0, bytes.length - 131072);
      p--
    ) {
      if (r.view.getUint32(p, true) === 0x06054b50) {
        end = p;
        break;
      }
    }
    if (end < 0) throw new Error("open sdocx: ZIP end record not found");
    r.seek(end + 4);
    if (r.u16() !== 0 || r.u16() !== 0)
      throw new Error("multi-disk ZIP is unsupported");
    const diskCount = r.u16(),
      count = r.u16(),
      size = r.u32(),
      offset = r.u32(),
      comment = r.u16();
    if (count === 65535 || size === 0xffffffff || offset === 0xffffffff)
      throw new Error("ZIP64 is unsupported");
    if (
      count !== diskCount ||
      count > 20000 ||
      offset + size > end ||
      end + 22 + comment > bytes.length
    )
      throw new Error("invalid ZIP directory or entry limit");
    this.centralOffset = offset;
    this.footer = bytes.subarray(end + 22 + comment);
    r.seek(offset);
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (r.u32() !== 0x02014b50) throw new Error("invalid ZIP directory");
      r.skip(4);
      const flags = r.u16(),
        method = r.u16();
      r.skip(4);
      const crc = r.u32(),
        compressed = r.u32(),
        uncompressed = r.u32();
      const nl = r.u16(),
        el = r.u16(),
        cl = r.u16(),
        disk = r.u16();
      r.skip(6);
      const local = r.u32();
      const name = new TextDecoder("utf-8", { fatal: true }).decode(r.take(nl));
      r.skip(el + cl);
      if (flags & 1 || disk || ![0, 8].includes(method))
        throw new Error("unsupported ZIP encryption, disk, or compression");
      if (this.entries.has(name))
        throw new Error(`duplicate archive entry ${name}`);
      total += uncompressed;
      if (uncompressed > limits.member || total > limits.archive)
        throw new Error("archive exceeds decompressed size limits");
      if (local + 30 > offset || compressed === 0xffffffff)
        throw new Error("invalid ZIP entry offset");
      this.entries.set(name, {
        name,
        flags,
        method,
        crc,
        compressed,
        size: uncompressed,
        offset: local,
      });
    }
    if (r.pos !== offset + size) throw new Error("invalid ZIP directory size");
  }
  async read(name: string): Promise<Uint8Array> {
    await this.ctx.checkpoint();
    const e = this.entries.get(name);
    if (!e) throw new Error(`missing archive entry ${name}`);
    const r = new Reader(this.bytes);
    r.seek(e.offset);
    if (r.u32() !== 0x04034b50) throw new Error("invalid ZIP local header");
    r.skip(2);
    const flags = r.u16(),
      method = r.u16();
    r.skip(16);
    const nl = r.u16(),
      el = r.u16();
    const localName = new TextDecoder().decode(r.take(nl));
    r.skip(el);
    if (
      flags !== e.flags ||
      method !== e.method ||
      localName !== name ||
      r.pos + e.compressed > this.centralOffset
    )
      throw new Error("ZIP local header mismatch");
    const compressed = r.take(e.compressed);
    const output = new Uint8Array(e.size);
    let used = 0,
      crc = 0;
    const append = (chunk: Uint8Array) => {
      this.ctx.check();
      if (
        chunk.length > e.size - used ||
        chunk.length > limits.member - used ||
        chunk.length > limits.archive - this.consumed
      )
        throw new Error("entry exceeds decompressed size limits");
      output.set(chunk, used);
      used += chunk.length;
      this.consumed += chunk.length;
      crc = crc32(chunk, crc);
    };
    if (e.method === 0) {
      for (let i = 0; i < compressed.length; i += 65536) {
        append(compressed.subarray(i, i + 65536));
        await this.ctx.checkpoint();
      }
    } else {
      const stream = new Inflate(append);
      // Small compressed chunks bound inflater's temporary output allocation, even for dishonest sizes.
      for (let i = 0; i < compressed.length; i += 1024) {
        stream.push(
          compressed.subarray(i, i + 1024),
          i + 1024 >= compressed.length,
        );
        await this.ctx.checkpoint();
      }
      if (!compressed.length) stream.push(compressed, true);
    }
    if (used !== e.size || crc !== e.crc)
      throw new Error(`ZIP size/CRC mismatch for ${name}`);
    return output;
  }
}
