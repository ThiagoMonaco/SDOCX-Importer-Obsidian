export class Reader {
  pos = 0;
  readonly view: DataView;
  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  fail(message: string): never {
    throw new Error(message);
  }
  take(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.data.length - this.pos)
      this.fail(`truncated record at byte ${this.pos} (need ${n} bytes)`);
    const start = this.pos;
    this.pos += n;
    return this.data.subarray(start, this.pos);
  }
  skip(n: number) {
    this.take(n);
  }
  seek(pos: number) {
    if (!Number.isSafeInteger(pos) || pos < 0 || pos > this.data.length)
      this.fail(`invalid offset ${pos}`);
    this.pos = pos;
  }
  u8() {
    return this.take(1)[0];
  }
  u16() {
    const p = this.pos;
    this.take(2);
    return this.view.getUint16(p, true);
  }
  u32() {
    const p = this.pos;
    this.take(4);
    return this.view.getUint32(p, true);
  }
  f32() {
    const p = this.pos;
    this.take(4);
    return this.view.getFloat32(p, true);
  }
  f64() {
    const p = this.pos;
    this.take(8);
    return this.view.getFloat64(p, true);
  }
  str16() {
    const n = this.u16();
    return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(
      this.take(n * 2),
    );
  }
}
export const finite = (v: number) => Number.isFinite(v) && Math.abs(v) <= 1e9;
export const color = (argb: number) =>
  "#" + (argb & 0xffffff).toString(16).padStart(6, "0");
export const mask = (r: Reader) => {
  const n = r.u8();
  if (n < 1 || n > 4) r.fail(`unsupported mask length ${n}`);
  let m = 0;
  for (let i = 0; i < n; i++) m |= r.u8() << (i * 8);
  return m >>> 0;
};
export const safeName = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name);
