import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Asset, ImageObject } from "./model";
import { Reader, finite, safeName } from "./reader";
import { textBounds } from "./text";
import { crc32 } from "./archive";
export const hash = (data: Uint8Array) => bytesToHex(sha256(data));
export function mediaIndex(data: Uint8Array) {
  const r = new Reader(data),
    version = r.u32(),
    count = r.u16();
  if (!version || count > 10000) r.fail("unsupported media header or count");
  const out = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const e = new Reader(r.take(r.u32())),
      id = e.u32(),
      name = e.str16();
    e.skip(64 + 2 + 8 + 1);
    if (!safeName(name)) e.fail(`invalid media filename ${name}`);
    if (out.has(id)) e.fail(`duplicate media bind ID ${id}`);
    out.set(id, "media/" + name);
  }
  if (new TextDecoder().decode(r.take(data.length - r.pos)) !== "EOFX")
    r.fail("unsupported media footer");
  return out;
}
/** Inspect headers only; never allocate pixel buffers. */
export function imageAsset(data: Uint8Array): { id: string; asset: Asset } {
  const r = new Reader(data);
  let width = 0,
    height = 0,
    mimeType = "";
  if (
    data.length >= 33 &&
    r.view.getUint32(0) === 0x89504e47 &&
    r.view.getUint32(4) === 0x0d0a1a0a
  ) {
    if (
      r.view.getUint32(8) !== 13 ||
      r.view.getUint32(12) !== 0x49484452 ||
      ![0, 2, 3, 4, 6].includes(data[25]) ||
      ![1, 2, 4, 8, 16].includes(data[24]) ||
      data[26] ||
      data[27] ||
      data[28] > 1
    )
      r.fail("unsupported or corrupt PNG");
    width = r.view.getUint32(16);
    height = r.view.getUint32(20);
    mimeType = "image/png";
  } else if (
    data.length >= 13 &&
    ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(data.subarray(0, 6)))
  ) {
    width = r.view.getUint16(6, true);
    height = r.view.getUint16(8, true);
    mimeType = "image/gif";
    if (data[10] & 0x80 && data.length < 13 + 3 * (2 << (data[10] & 7)))
      r.fail("truncated GIF color table");
  } else if (data[0] === 0xff && data[1] === 0xd8) {
    r.seek(2);
    while (r.pos < data.length) {
      if (r.u8() !== 0xff) r.fail("invalid JPEG marker");
      let marker = r.u8();
      while (marker === 0xff) marker = r.u8();
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = (r.u8() << 8) | r.u8();
      if (size < 2) r.fail("invalid JPEG segment");
      const segment = new Reader(r.take(size - 2));
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (segment.u8() !== 8) r.fail("unsupported JPEG precision");
        height = (segment.u8() << 8) | segment.u8();
        width = (segment.u8() << 8) | segment.u8();
        const components = segment.u8();
        if (![1, 3, 4].includes(components) || size !== 8 + 3 * components)
          r.fail("invalid JPEG frame");
        segment.skip(3 * components);
        mimeType = "image/jpeg";
        break;
      }
    }
  }
  if (!mimeType) r.fail("unsupported or corrupt image");
  if (
    width <= 0 ||
    height <= 0 ||
    width > 32768 ||
    height > 32768 ||
    width * height > 40000000
  )
    r.fail("image dimensions exceed limit");
  if (mimeType === "image/png") {
    const validDepths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };
    if (
      !validDepths[data[25]]?.includes(data[24]) ||
      crc32(data.subarray(12, 29)) !== r.view.getUint32(29)
    )
      r.fail("unsupported or corrupt PNG header/CRC");
  }
  return { id: hash(data), asset: { mimeType, data } };
}
export function imageObject(data: Uint8Array): {
  image: ImageObject;
  bind: number;
} {
  const b = textBounds(data),
    out: ImageObject = {
      assetID: "",
      x: b[0],
      y: b[1],
      width: b[2] - b[0],
      height: b[3] - b[1],
      opacity: 100,
      order: 0,
    };
  const r = new Reader(data);
  let found = false,
    bind = 0;
  while (r.pos < data.length) {
    const start = r.pos,
      size = r.u32(),
      typ = r.u16();
    if (size < 6 || size > data.length - start)
      r.fail("invalid image subrecord size");
    const sub = new Reader(data.subarray(start, start + size));
    if (typ === 6) {
      sub.skip(6);
      const own = sub.u32();
      if (own > 0) {
        if (own < 10 || own > size - 14)
          sub.fail("invalid image layout offset");
        sub.seek(own + 10);
        const alpha = sub.u32();
        if (alpha > 255) sub.fail("invalid image alpha");
        out.opacity *= alpha / 255;
      }
    } else if (typ === 7) {
      sub.skip(6);
      const own = sub.u32();
      sub.skip(3);
      const m = sub.u32();
      if (m & 0x20) {
        if (own < sub.pos || own > size - 10)
          sub.fail("invalid image fill offset");
        sub.seek(own);
        const effectSize = sub.u32(),
          effectType = sub.u8();
        if (effectType !== 2)
          sub.fail(`unsupported image fill effect ${effectType}`);
        if (effectSize !== 62 || size - own !== 67)
          sub.fail("unsupported image fill layout");
        const imageType = sub.u8();
        if (imageType !== 0)
          sub.fail(`unsupported image tiling mode ${imageType}`);
        bind = sub.u32();
        sub.skip(16 + 8 + 4 + 4);
        const transparency = sub.f32();
        if (!finite(transparency) || transparency < 0 || transparency > 100)
          sub.fail("invalid image transparency");
        out.opacity *= 1 - transparency / 100;
        found = true;
      }
    } else if (typ === 3 && size !== 17)
      sub.fail("cropped or transformed image-own payload is not supported");
    r.seek(start + size);
  }
  if (!found) r.fail("missing image fill reference");
  return { image: out, bind };
}
export function base64(data: Uint8Array) {
  let out = "";
  for (let i = 0; i < data.length; i += 32768)
    out += String.fromCharCode(...data.subarray(i, i + 32768));
  return btoa(out);
}
