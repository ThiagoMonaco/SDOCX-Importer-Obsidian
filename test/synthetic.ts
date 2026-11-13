import { zipSync } from "fflate";
class Writer {
  data: number[] = [];
  bytes(b: Uint8Array | number[]) {
    this.data.push(...b);
    return this;
  }
  u8(n: number) {
    this.data.push(n);
    return this;
  }
  u16(n: number) {
    return this.bytes([n & 255, (n >>> 8) & 255]);
  }
  u32(n: number) {
    return this.bytes([
      n & 255,
      (n >>> 8) & 255,
      (n >>> 16) & 255,
      (n >>> 24) & 255,
    ]);
  }
  f64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    return this.bytes(b);
  }
  zeros(n: number) {
    return this.bytes(new Uint8Array(n));
  }
  str(s: string) {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  }
  end() {
    return Uint8Array.from(this.data);
  }
}
export function syntheticMembers() {
  const id = "synthetic-page";
  const own = new Uint8Array(66),
    v = new DataView(own.buffer);
  v.setUint32(0, 66, true);
  v.setUint16(4, 1, true);
  v.setUint32(6, 58, true);
  own[10] = 1;
  own[11] = 1;
  own[12] = 1;
  own[13] = 12;
  v.setUint16(14, 3, true);
  v.setFloat64(16, 10, true);
  v.setFloat64(24, 20, true);
  v.setUint16(32, 32, true);
  v.setUint16(34, 32, true);
  v.setUint16(36, 32, true);
  v.setUint16(38, 32, true);
  v.setFloat32(40, 0.5, true);
  v.setUint32(58, 0xff123456, true);
  v.setFloat32(62, 3.5, true);
  const base = new Writer()
    .u32(62)
    .u16(0)
    .u32(62)
    .u8(0)
    .u8(0)
    .zeros(4)
    .u16(0)
    .zeros(8)
    .f64(10)
    .f64(20)
    .f64(12)
    .f64(22)
    .zeros(4)
    .end();
  const object = new Writer()
    .u8(1)
    .u16(0)
    .u32(base.length + own.length + 32)
    .bytes(base)
    .bytes(own)
    .zeros(32)
    .end();
  const head = new Writer()
    .u32(0)
    .u32(0)
    .u8(4)
    .u32(0)
    .u8(4)
    .u32(0)
    .u32(0)
    .u32(720)
    .u32(1018)
    .zeros(8)
    .str(id)
    .zeros(16)
    .end();
  new DataView(head.buffer).setUint32(0, head.length, true);
  new DataView(head.buffer).setUint32(4, head.length, true);
  const start = head.length + 4;
  const page = new Writer()
    .bytes(head)
    .u16(1)
    .u16(0)
    .u32(16)
    .u32(start + 16)
    .u8(1)
    .u8(0)
    .u8(1)
    .u8(0)
    .u32(0)
    .u32(1)
    .bytes(object)
    .zeros(32 + 58)
    .end();
  const note = new Writer()
    .u32(0)
    .u8(1)
    .u8(0)
    .u8(1)
    .u8(0)
    .u32(1)
    .str("")
    .zeros(4 + 16)
    .u32(720)
    .u32(1018)
    .zeros(12)
    .u32(0)
    .u32(0)
    .end();
  new DataView(note.buffer).setUint32(0, note.length, true);
  return {
    "pageIdInfo.dat": new Writer().zeros(32).u16(1).str(id).zeros(32).end(),
    "note.note": note,
    [id + ".page"]: page,
  };
}
export const syntheticNote = () => zipSync(syntheticMembers());
