// Samsung's observed 4000 profile. Keep binary layouts aligned with internal/sdocx/write.go.
import { zipSync, Zippable } from "fflate";
import { sha256 } from "@noble/hashes/sha256";
import {
  Document,
  Page,
  Point,
  Stroke,
  TextRun,
  ImageObject,
  limits,
} from "./model";
import { hash, imageAsset } from "./image";
import { charWidth, textBoxInset, textBoxScale, textScale } from "./text";
import { Archive } from "./archive";
import { noteFields } from "./parser";
import { Context } from "./model";

class Bin {
  private data = new Uint8Array(256);
  length = 0;
  private reserve(n: number) {
    if (this.length + n > limits.archive)
      throw new Error("Generated record exceeds size limit");
    if (this.length + n > this.data.length) {
      const next = new Uint8Array(
        Math.max(this.length + n, this.data.length * 2),
      );
      next.set(this.data);
      this.data = next;
    }
  }
  bytes(data: Uint8Array | number[]) {
    this.reserve(data.length);
    this.data.set(data, this.length);
    this.length += data.length;
    return this;
  }
  zeros(n: number) {
    this.reserve(n);
    this.data.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }
  number(n: number | bigint, size: number, kind: "u" | "f") {
    this.reserve(size);
    const v = new DataView(this.data.buffer),
      p = this.length;
    if (kind === "f") {
      if (size === 4) v.setFloat32(p, Number(n), true);
      else v.setFloat64(p, Number(n), true);
    } else if (size === 8) v.setBigUint64(p, BigInt(n), true);
    else if (size === 4) v.setUint32(p, Number(n), true);
    else if (size === 2) v.setUint16(p, Number(n), true);
    else v.setUint8(p, Number(n));
    this.length += size;
    return this;
  }
  u8(n: number) {
    return this.number(n, 1, "u");
  }
  u16(n: number) {
    return this.number(n, 2, "u");
  }
  u32(n: number) {
    return this.number(n, 4, "u");
  }
  u64(n: number | bigint) {
    return this.number(n, 8, "u");
  }
  f32(n: number) {
    return this.number(n, 4, "f");
  }
  f64(n: number) {
    return this.number(n, 8, "f");
  }
  ascii(s: string) {
    return this.bytes(new TextEncoder().encode(s));
  }
  str(s: string) {
    if (s.length > 65535) throw new Error("String too long");
    this.u16(s.length);
    return this.utf16(s);
  }
  utf16(s: string) {
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  }
  sized(b: Uint8Array) {
    return this.u32(b.length).bytes(b);
  }
  rect(r: number[]) {
    for (const n of r) this.f64(n);
    return this;
  }
  patch(p: number, n: number) {
    new DataView(this.data.buffer).setUint32(p, n, true);
    return this;
  }
  set(p: number, n: number) {
    this.data[p] = n;
    return this;
  }
  end() {
    return this.data.slice(0, this.length);
  }
}
const join = (...parts: Uint8Array[]) => {
  const b = new Bin();
  for (const p of parts) b.bytes(p);
  return b.end();
};
const digest = (b: Uint8Array) => sha256(b);
const identity = (id: string, now: number) =>
  digest(new TextEncoder().encode(id + now));
function sdkID() {
  const raw = crypto.getRandomValues(new Uint8Array(16)),
    v = new DataView(raw.buffer);
  const ticks = BigInt(Date.now()) * 10000n + 0x01b21dd213814000n;
  v.setUint32(0, Number(ticks & 0xffffffffn));
  v.setUint16(4, Number((ticks >> 32n) & 0xffffn));
  v.setUint16(6, Number((ticks >> 48n) & 0xfffn) | 0x1000);
  raw[8] = (raw[8] & 0x3f) | 0x80;
  raw[10] |= 1;
  const h = Array.from(raw, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function colorARGB(color: string, opacity: number) {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100)
    throw new Error("Invalid opacity");
  color =
    (
      { black: "#000000", white: "#ffffff", red: "#ff0000" } as Record<
        string,
        string
      >
    )[color.toLowerCase()] ?? color;
  if (color === "transparent") return 0;
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color))
    throw new Error(`Unsupported color ${color}; use hex colors`);
  let s = color.slice(1);
  if (s.length < 5) s = Array.from(s, (ch) => ch + ch).join("");
  const rgb = parseInt(s.slice(0, 6), 16),
    alpha = s.length === 8 ? parseInt(s.slice(6), 16) : 255;
  return ((Math.round((alpha * opacity) / 100) << 24) | rgb) >>> 0;
}
const record = (type: number, data: Uint8Array) =>
  new Bin()
    .u32(data.length + 6)
    .u16(type)
    .bytes(data)
    .end();
function base(
  id: string,
  rect: number[],
  w: number,
  h: number,
  now: number,
  kind: string,
) {
  const b = new Bin()
    .u32(0)
    .u16(0)
    .u32(105)
    .u8(2)
    .u16(0x1bf)
    .u8(4)
    .u32(kind === "image" ? 0xe000 : kind === "note" ? 0x4000 : 0x6000)
    .u32(4000)
    .u16(36)
    .ascii(id)
    .u64(now)
    .rect(rect)
    .u32(0)
    .u8(0);
  if (kind === "note") b.u32(w).u32(0);
  else {
    b.u64(now).u32(w).u32(h);
    if (kind === "image") b.u8(2);
  }
  return b.patch(0, b.length).end();
}
interface ObjectRecord {
  order: number;
  data: Uint8Array;
  hash: Uint8Array;
}
interface PackedPage {
  id: string;
  data: Uint8Array;
  hash: Uint8Array;
  width: number;
  height: number;
}
function object(
  type: number,
  payload: Uint8Array,
  id: string,
  now: number,
  order: number,
): ObjectRecord {
  const h = identity(id, now);
  return {
    order,
    hash: h,
    data: new Bin()
      .u8(type)
      .u16(0)
      .u32(payload.length + 32)
      .bytes(payload)
      .bytes(h)
      .end(),
  };
}
const delta = (word: number, scale: number) =>
  ((word & 0x8000 ? -1 : 1) * (word & 0x7fff)) / scale;
function strokeRecord(s: Stroke, w: number, h: number, now: number) {
  if (
    !Number.isFinite(s.width) ||
    s.width < 0 ||
    s.width > 10000 ||
    !s.points.length ||
    s.points.length > 60000
  )
    throw new Error("Invalid stroke size");
  const id = sdkID(),
    argb = colorARGB(s.color, s.opacity);
  let g = new Bin().f64(s.points[0][0]).f64(s.points[0][1]),
    compact = true;
  const current = [...s.points[0]];
  for (const p of s.points.slice(1))
    for (let axis = 0; axis < 2; axis++) {
      const v = p[axis] - current[axis],
        mag = Math.round(Math.abs(v) * 32);
      if (mag >= 32768) compact = false;
      const word = (mag & 0xffff) | (v < 0 ? 0x8000 : 0);
      g.u16(word);
      current[axis] += delta(word, 32);
    }
  const pressure = s.pressures.length ? s.pressures : s.points.map(() => 1 / 3);
  if (pressure.length !== s.points.length)
    throw new Error("Pressure count mismatch");
  s.points.forEach((p, i) => {
    if (
      !p.every(Number.isFinite) ||
      !Number.isFinite(pressure[i]) ||
      pressure[i] < 0 ||
      pressure[i] > 1
    )
      throw new Error("Invalid stroke point or pressure");
  });
  let flags = compact ? 0x425 : 0;
  if (compact) {
    g.f32(pressure[0]);
    let previous = Math.fround(pressure[0]);
    for (const p of pressure.slice(1)) {
      const v = p - previous,
        word = Math.round(Math.abs(v) * 4096) | (v < 0 ? 0x8000 : 0);
      g.u16(word);
      previous += delta(word, 4096);
    }
    g.u32(0);
    for (let i = 1; i < s.points.length; i++) g.u16(8);
    for (let axis = 0; axis < 2; axis++) {
      g.f32(0);
      for (let i = 1; i < s.points.length; i++) g.u16(0);
    }
  } else {
    g = new Bin();
    for (const p of s.points) g.f32(p[0]).f32(p[1]);
    for (const p of pressure) g.f32(p);
    s.points.forEach((_, i) => g.u32(i * 8));
  }
  if (s.highlighter) flags |= 0x40;
  g.u16(3);
  const own = new Bin()
    .u32(20 + g.length)
    .u8(2)
    .u16(flags)
    .u8(4)
    .u32(s.highlighter ? 0x248e : 0x258e)
    .u16(s.points.length)
    .bytes(g.end())
    .u32(s.highlighter ? 3 : 1)
    .u32(argb)
    .f32(s.width)
    .u32(s.highlighter ? 2 : 0);
  if (!s.highlighter) own.f32(s.width);
  own.u32(1).f32(Math.max(0.1, s.width - 2.5));
  const r = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of s.points) {
    r[0] = Math.min(r[0], p[0]);
    r[1] = Math.min(r[1], p[1]);
    r[2] = Math.max(r[2], p[0]);
    r[3] = Math.max(r[3], p[1]);
  }
  r.forEach((_, i) => (r[i] += i < 2 ? -s.width : s.width));
  return object(
    1,
    join(base(id, r, w, h, now, "stroke"), record(1, own.end())),
    id,
    now,
    s.order,
  );
}
function shapeBase(r: number[], alpha: number, minimal: boolean) {
  const b = new Bin()
    .u32(minimal ? 27 : 91)
    .bytes([1, 0, 1, 12])
    .u32(minimal ? 0 : 4);
  if (!minimal) {
    const [l, t, right, bottom] = r;
    b.rect([
      (l + right) / 2,
      t,
      right,
      (t + bottom) / 2,
      (l + right) / 2,
      bottom,
      l,
      (t + bottom) / 2,
    ]);
  }
  return record(
    6,
    b
      .u32(4)
      .zeros(5)
      .u32(19)
      .u16(1)
      .u32(2)
      .u32(alpha)
      .zeros(9)
      .u32(12)
      .zeros(12)
      .end(),
  );
}
function shapePrefix(r: number[], own: number, mask: number, minimal: boolean) {
  const b = new Bin()
    .u32(own)
    .bytes([1, mask === 0x20 ? 0 : 4, 4])
    .u32(mask)
    .u32(4)
    .rect(r)
    .u32(0);
  if (minimal) b.zeros(5);
  else {
    b.u32(73).u32(5);
    const pts: Point[] = [
      [r[0], r[1]],
      [r[2], r[1]],
      [r[2], r[3]],
      [r[0], r[3]],
    ];
    pts.forEach((p, i) =>
      b
        .u8(i === 0 ? 1 : 2)
        .f64(p[0])
        .f64(p[1]),
    );
    b.u16(6);
  }
  return b;
}
const trailer = new Uint8Array([15, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0]);
function spans(b: Bin, units: number, font: number, argb: number) {
  b.u32(2);
  for (const type of [3, 1]) {
    b.u16(24).u32(type).u32(0).u32(units).u32(1);
    if (type === 3) b.f32(font);
    else b.u32(argb);
    b.u32(0);
  }
}
function common(value: string, font: number, argb: number, margins: number[]) {
  const b = new Bin().u32(value.length).utf16(value);
  spans(b, value.length, font, argb);
  const lines = value.split("\n").length;
  b.u32(lines + 1);
  for (let i = 0; i <= lines; i++) {
    const start = i === 0 ? 0 : i - 1;
    b.u16(20)
      .u32(i === 0 ? 3 : 6)
      .u32(start)
      .u32(start + 1)
      .u32(0)
      .u32(0);
  }
  for (const m of margins) b.f32(m);
  return b.u8(0).u16(0).u32(0).u32(0).end();
}
function textRecord(t: TextRun, w: number, h: number, now: number) {
  if (
    t.value.length > 250000 ||
    ![t.fontSize, t.width, t.height].every(Number.isFinite) ||
    t.fontSize <= 0
  )
    throw new Error("Invalid text field");
  // Keep explicit lines intact when the Samsung font measures wider.
  let widestLine = 0;
  for (const line of t.value.split("\n")) {
    let lineWidth = 0;
    for (const ch of line) lineWidth += charWidth(ch, t.fontSize);
    widestLine = Math.max(widestLine, lineWidth);
  }
  const [insetX, insetY] = textBoxInset(w);
  const left = t.x - 8 - insetX;
  const top = t.y - 4 - insetY;
  const id = sdkID(),
    r = [
      left,
      top,
      left + Math.max(360, t.width + 16, widestLine * 1.1 + 16),
      top + Math.max(132, t.height + 8) * 1.5,
    ];
  const shape = shapePrefix(r, 135, 0x2001, false)
    .sized(
      common(
        t.value,
        t.fontSize / textBoxScale(w),
        colorARGB(t.color, t.opacity),
        [8, 4, 8, 4],
      ),
    )
    .u8(2);
  return object(
    2,
    join(
      base(id, r, w, h, now, "text"),
      shapeBase(r, 255, false),
      record(7, shape.end()),
      trailer,
    ),
    id,
    now,
    t.order,
  );
}
function imageRecord(
  im: ImageObject,
  bind: number,
  w: number,
  h: number,
  now: number,
) {
  if (
    ![im.x, im.y, im.width, im.height, im.opacity].every(Number.isFinite) ||
    im.width <= 0 ||
    im.height <= 0 ||
    im.opacity < 0 ||
    im.opacity > 100
  )
    throw new Error("Invalid image geometry");
  const id = sdkID(),
    r = [im.x, im.y, im.x + im.width, im.y + im.height];
  const shape = shapePrefix(r, 135, 0x20, false)
    .u32(62)
    .u8(2)
    .u8(0)
    .u32(bind)
    .zeros(24)
    .f32(100)
    .f32(100)
    .f32(0)
    .u8(0)
    .zeros(16)
    .u32(w);
  return object(
    3,
    join(
      base(id, r, w, h, now, "image"),
      shapeBase(r, Math.round((im.opacity * 255) / 100), false),
      record(7, shape.end()),
      record(3, new Uint8Array([0, 0, 0, 0, 1, 0, 4, 0, 0, 0, 0])),
    ),
    id,
    now,
    im.order,
  );
}
function writePage(
  pg: Page,
  binds: Map<string, number>,
  now: number,
): PackedPage {
  const w = Math.ceil(pg.width),
    h = Math.ceil(pg.height),
    id = sdkID(),
    objects: ObjectRecord[] = [];
  for (const s of pg.strokes)
    for (let start = 0; start < s.points.length; ) {
      const end = Math.min(start + 60000, s.points.length),
        chunk = {
          ...s,
          points: s.points.slice(start, end),
          pressures: s.pressures.slice(start, end),
        };
      if (chunk.points.length === 1) {
        chunk.points.push(chunk.points[0]);
        if (chunk.pressures.length) chunk.pressures.push(chunk.pressures[0]);
      }
      objects.push(strokeRecord(chunk, w, h, now));
      if (end === s.points.length) break;
      start = end - 1;
    }
  for (const t of pg.texts) objects.push(textRecord(t, w, h, now));
  for (const im of pg.images) {
    const bind = binds.get(im.assetID);
    if (bind === undefined) throw new Error("Missing image asset");
    objects.push(imageRecord(im, bind, w, h, now));
  }
  if (objects.length > limits.objects) throw new Error("Object limit exceeded");
  objects.sort((a, b) => a.order - b.order);
  const p = new Bin()
    .zeros(18)
    .u32(0)
    .u32(w)
    .u32(h)
    .zeros(8)
    .str(id)
    .u64(now)
    .u32(4000)
    .u32(4000);
  p.zeros(128 - p.length);
  let props = 0x70;
  if (objects.length) {
    props |= 1;
    p.rect([0, 0, w, h]);
  }
  p.u32(2).u32(0xfffcfcfc).u32(w);
  const layerOff = p.length,
    layerID = sdkID(),
    extra = new Bin().str(layerID).u64(now);
  p.u16(1)
    .u16(0)
    .u32(16 + extra.length)
    .u32(layerOff + 20)
    .bytes([1, 2, 1, 0x18])
    .u32(0)
    .bytes(extra.end())
    .u32(objects.length);
  const hashes = new Bin();
  for (const obj of objects) {
    p.bytes(obj.data);
    hashes.bytes(obj.hash);
  }
  hashes.bytes(identity(layerID, now));
  const layerHash = digest(hashes.end());
  p.bytes(layerHash);
  p.patch(0, layerOff).patch(4, 128).set(8, 4).set(13, 4).patch(14, props);
  const pageHash = digest(join(layerHash, identity(id, now)));
  p.bytes(pageHash).ascii("Page for SAMSUNG S-Pen SDK");
  return { id, data: p.end(), hash: pageHash, width: w, height: h };
}
function titleCommon(title: string) {
  const b = new Bin()
    .u32(title.length)
    .utf16(title)
    .u32(0)
    .u32(title.length ? 1 : 0);
  if (title.length) b.u16(20).u32(6).u32(0).u32(1).u32(0).u32(0);
  return b.f32(11.25).f32(0).f32(11.25).f32(0).u8(0).u16(0).u32(0).u32(0).end();
}
function emptyCommon(pages: number) {
  const b = new Bin().u32(0);
  spans(b, 0, 14, 0xff252525);
  b.u32(1)
    .u16(20)
    .u32(3)
    .u32(0)
    .u32(1)
    .u32(0)
    .u32(0)
    .f32(16)
    .f32(10)
    .f32(16)
    .f32(10)
    .u8(0)
    .u16(pages);
  for (let i = 0; i < pages; i++)
    b.u32(i === 0 ? 0xffffffff : 0).u32(i === 0 ? 1 : 0);
  return b.u32(0).u32(0).end();
}
function noteText(data: Uint8Array, w: number, now: number, isTitle = false) {
  const id = sdkID(),
    r = [0, 0, 0, 0],
    shape = shapePrefix(r, 62, isTitle ? 1 : 0x2001, true).sized(data);
  if (!isTitle) shape.u8(2);
  return join(
    base(id, r, w, 0, now, "note"),
    shapeBase(r, 255, true),
    record(7, shape.end()),
    trailer,
  );
}

/** Replaces only the native title record, keeping pages, media, and body data. */
export async function renameSdocx(bytes: Uint8Array, title: string) {
  const archive = new Archive(bytes, new Context({}));
  const original = await archive.read("note.note");
  const { titleOffset, bodyOffset, flex, width } = noteFields(original);
  if (original.length < flex + 32)
    throw new Error("Missing note integrity data");
  const field = noteText(titleCommon(title), width, Date.now() * 1000, true);
  const note = new Bin()
    .bytes(original.subarray(0, titleOffset))
    .sized(field)
    .bytes(original.subarray(bodyOffset, -32))
    .patch(0, flex + field.length + titleOffset + 4 - bodyOffset)
    .end();
  const checksum = digest(note);
  const index = await archive.read("pageIdInfo.dat");
  if (index.length < 34) throw new Error("Invalid page index");
  index.set(checksum);
  const zip: Zippable = Object.create(null);
  for (const name of archive.entries.keys()) {
    zip[name] =
      name === "note.note"
        ? join(note, checksum)
        : name === "pageIdInfo.dat"
          ? index
          : await archive.read(name);
  }
  return join(zipSync(zip, { level: 1 }), archive.footer);
}
function positionedBody(t: TextRun, w: number, now: number) {
  if (
    ![t.x, t.y, t.fontSize].every(Number.isFinite) ||
    t.x < 0 ||
    t.y < 0 ||
    t.fontSize <= 0
  )
    throw new Error("Invalid body text geometry");
  const advance = t.fontSize * 1.9,
    lines = Math.floor(t.y / advance),
    value = "\n".repeat(Math.min(lines, 9991)) + t.value;
  if (
    lines > 9990 ||
    lines + t.value.split("\n").length - 1 > 9990 ||
    value.length > 250000
  )
    throw new Error("Body text limit exceeded");
  return noteText(
    common(value, t.fontSize / textScale(w), colorARGB(t.color, t.opacity), [
      t.x,
      t.y - lines * advance,
      0,
      0,
    ]),
    w,
    now,
  );
}
const fountain = "com.samsung.android.sdk.pen.pen.preload.FountainPen",
  marker = "com.samsung.android.sdk.pen.pen.preload.Marker4";
function dimensions(pages: PackedPage[]) {
  return {
    w: Math.max(...pages.map((p) => p.width)),
    h: 8 + pages.reduce((n, p) => n + p.height, 0),
  };
}
function writeNote(
  pages: PackedPage[],
  title: string,
  now: number,
  body?: Uint8Array,
) {
  const { w, h } = dimensions(pages),
    b = new Bin()
      .u32(0)
      .u8(4)
      .u32(8)
      .u8(4)
      .u32(0xc8e80)
      .u32(4000)
      .str("")
      .u32(5)
      .u64(now)
      .u64(now)
      .u32(w)
      .u32(h)
      .u32(0)
      .u32(8)
      .u32(4000)
      .sized(
        noteText(
          titleCommon(Array.from(title).slice(0, 120).join("")),
          w,
          now,
          true,
        ),
      )
      .sized(body ?? noteText(emptyCommon(pages.length), w, now));
  b.u32(pages[0].width)
    .u32(pages[0].height)
    .patch(0, b.length)
    .u32(0)
    .u32(0xffffffff)
    .u64(0);
  const ids = new Bin().u16(4);
  [fountain, "18;0;100;", marker, "18;0;100;"].forEach((s, i) =>
    ids.u32(i).str(s),
  );
  b.sized(ids.end()).u32(0);
  const pen = new Bin()
    .str(fountain)
    .f32(2)
    .u32(0xff252525)
    .u32(1)
    .str("")
    .u32(0)
    .u32(50)
    .u32(1)
    .f32(0)
    .u32(0)
    .f32(0)
    .f32(0)
    .f32(37 / 255)
    .u32(0)
    .zeros(8)
    .f32(1)
    .zeros(20)
    .u32(5)
    .zeros(20);
  b.u32(pen.length + 4)
    .bytes(pen.end())
    .u32(2)
    .u32(2);
  b.bytes(digest(b.end()));
  return b.end();
}
function endTag(pages: PackedPage[], now: number) {
  const { w, h } = dimensions(pages),
    b = new Bin()
      .u32(4000)
      .str("")
      .u64(now)
      .u32(0)
      .str("")
      .u32(w)
      .f32(h)
      .str("")
      .u32(0xffffffff)
      .u32(0xffffffff)
      .str("")
      .u32(4000)
      .u64(now)
      .u32(0)
      .u16(0)
      .u16(0)
      .str("")
      .u32(0)
      .u32(0)
      .u64(now)
      .u64(Math.floor(now / 1000))
      .u64(0)
      .str("")
      .u32(2)
      .u32(2)
      .u64(0xffffffffffffffffn)
      .u32(0)
      .u32(0)
      .u32(0)
      .ascii("Document for S-Pen SDK");
  return new Bin().u16(b.length).bytes(b.end()).end();
}
/** Returns a self-contained ZIP with Samsung's required appended SDK footer. */
export function writeSdocx(doc: Document, title: string): Uint8Array {
  if (!doc.pages.length || doc.pages.length >= limits.pages)
    throw new Error("Invalid page count");
  const now = Date.now() * 1000,
    entries = new Map<string, Uint8Array>(),
    binds = new Map<string, number>(),
    media = new Bin().u32(5500),
    keys = [...doc.assets.keys()].sort();
  if (keys.length > 10000) throw new Error("Too many image assets");
  media.u16(keys.length);
  keys.forEach((key, i) => {
    const asset = doc.assets.get(key)!,
      checked = imageAsset(asset.data);
    if (checked.asset.mimeType !== asset.mimeType)
      throw new Error("Image MIME type mismatch");
    const ext =
        asset.mimeType === "image/jpeg"
          ? "jpg"
          : asset.mimeType === "image/gif"
            ? "gif"
            : "png",
      name = `${i}@image.${ext}`;
    binds.set(key, i);
    const m = new Bin()
      .u32(i)
      .str(name)
      .ascii(hash(asset.data))
      .u16(1)
      .u64(now)
      .u8(1);
    media.sized(m.end());
    entries.set("media/" + name, asset.data);
  });
  entries.set("media/mediaInfo.dat", media.ascii("EOFX").end());
  const pages = doc.pages.map((p) => ({ ...p, texts: [...p.texts] }));
  let bodyText: TextRun | undefined;
  // Flowing body text uses Samsung's line spacing. Labels on a drawing need
  // independent coordinates so they stay aligned with ink and images.
  if (
    pages.reduce((n, p) => n + p.texts.length, 0) === 1 &&
    pages[0].texts.length === 1 &&
    pages.every((p) => !p.strokes.length && !p.images.length)
  )
    bodyText = pages[0].texts.pop();
  pages.push({
    id: "",
    width: pages[0].width,
    height: pages[0].height,
    strokes: [],
    texts: [],
    images: [],
  });
  const packed = pages.map((p) => {
    if (
      ![p.width, p.height].every(Number.isFinite) ||
      p.width < 1 ||
      p.height < 1 ||
      p.width > 20000 ||
      p.height > 20000
    )
      throw new Error("Invalid or excessive Samsung page size");
    const pg = writePage(p, binds, now);
    entries.set(pg.id + ".page", pg.data);
    return pg;
  });
  const note = writeNote(
      packed,
      title,
      now,
      bodyText ? positionedBody(bodyText, packed[0].width, now) : undefined,
    ),
    end = endTag(packed, now),
    index = new Bin().bytes(note.slice(-32)).u16(packed.length);
  for (const p of packed) index.str(p.id).bytes(p.hash);
  entries.set("pageIdInfo.dat", index.end());
  entries.set("note.note", note);
  entries.set("end_tag.bin", end);
  const rank = (n: string) =>
    n === "pageIdInfo.dat"
      ? 0
      : n.endsWith(".page")
        ? 1
        : n === "media/mediaInfo.dat"
          ? 2
          : n.startsWith("media/")
            ? 3
            : n === "note.note"
              ? 4
              : 5;
  const zip: Zippable = {};
  let total = 0;
  for (const [name, data] of [...entries].sort(
    (a, b) => rank(a[0]) - rank(b[0]),
  )) {
    total += data.length;
    if (data.length > limits.member || total > limits.archive)
      throw new Error("Generated archive exceeds size limit");
    zip[name] = [
      data,
      {
        level:
          name.startsWith("media/") && name !== "media/mediaInfo.dat" ? 0 : 1,
        mtime: new Date(),
      },
    ];
  }
  const out = join(zipSync(zip), end);
  if (out.length > limits.archive)
    throw new Error("Generated archive exceeds size limit");
  return out;
}
