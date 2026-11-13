import { Point, Stroke } from "./model";
import { Reader, finite, mask, color } from "./reader";
export function delta(w: number) {
  const v = (w & 0x7fff) / 32;
  return w & 0x8000 ? -v : v;
}
export function geometry(data: Uint8Array) {
  const r = new Reader(data),
    size = r.u32(),
    typ = r.u16(),
    flex = r.u32();
  const props = mask(r),
    styleMask = mask(r),
    n = r.u16();
  if (size !== data.length || typ !== 1 || flex < r.pos || flex > data.length)
    r.fail("invalid stroke subrecord offsets");
  if (n < 1 || n > 65535) r.fail(`invalid point count ${n}`);
  if (props & ~0x465)
    r.fail(`unsupported stroke geometry flags 0x${props.toString(16)}`);
  const g = new Reader(data.subarray(r.pos, flex));
  const points: Point[] = [],
    pressures: number[] = [];
  const axes = props & 4 ? 2 : 0;
  if (props & 1) {
    const expected = 16 + 4 * (n - 1) + (2 + axes) * (4 + 2 * (n - 1)) + 2;
    if (expected !== g.data.length)
      g.fail(
        `compact geometry length mismatch: got ${g.data.length}, expected ${expected}`,
      );
    points.push([g.f64(), g.f64()]);
    for (let i = 1; i < n; i++)
      points.push([
        points[i - 1][0] + delta(g.u16()),
        points[i - 1][1] + delta(g.u16()),
      ]);
    pressures.push(g.f32());
    for (let i = 1; i < n; i++)
      pressures.push(pressures[i - 1] + delta(g.u16()) / 128);
  } else {
    const coordinateBytes = g.data.length - ((2 + axes) * 4 * n + 2);
    if (coordinateBytes !== 8 * n && coordinateBytes !== 16 * n)
      g.fail("unsupported raw geometry length");
    for (let i = 0; i < n; i++)
      points.push(
        coordinateBytes === 8 * n ? [g.f32(), g.f32()] : [g.f64(), g.f64()],
      );
    for (let i = 0; i < n; i++) pressures.push(g.f32());
  }
  if (pressures.some((p) => !finite(p)))
    g.fail("non-finite or excessive pressure");
  if (points.some((p) => !finite(p[0]) || !finite(p[1])))
    g.fail("non-finite or excessive coordinate");
  return { points, pressures, styleMask, flex };
}
export function stroke(data: Uint8Array): {
  stroke: Stroke;
  warnings: string[];
} {
  const out: Stroke = {
    points: [],
    pressures: [],
    color: "#000000",
    width: 2,
    opacity: 100,
    highlighter: false,
    order: 0,
  };
  let own: Uint8Array | undefined,
    base = false;
  const r = new Reader(data);
  while (r.pos < data.length) {
    const start = r.pos,
      size = r.u32(),
      typ = r.u16();
    if (size < 6 || size > data.length - start)
      r.fail(`invalid subrecord size ${size}`);
    const record = data.subarray(start, start + size);
    if (typ === 0) {
      if (base) r.fail("duplicate base subrecord");
      base = true;
      const b = new Reader(record);
      b.skip(6);
      const offset = b.u32();
      b.skip(b.u8());
      b.skip(b.u8());
      b.skip(4);
      b.skip(b.u16());
      b.skip(8);
      const left = b.f64(),
        top = b.f64(),
        right = b.f64(),
        bottom = b.f64();
      if (
        ![left, top, right, bottom].every(finite) ||
        right < left ||
        bottom < top
      )
        b.fail("invalid object bounds");
      if (offset < b.pos || offset > record.length)
        b.fail("invalid base flexible offset");
    } else if (typ === 1) {
      if (own) r.fail("duplicate stroke subrecord");
      own = record;
    }
    r.seek(start + size);
  }
  if (!base || !own) r.fail("missing base or stroke subrecord");
  const g = geometry(own!);
  out.points = g.points;
  out.pressures = g.pressures;
  const marker = new Reader(own!);
  marker.skip(10);
  const flags = marker.take(marker.u8());
  out.highlighter = !!(flags[0] & 0x40);
  const warnings: string[] = [];
  if (out.pressures.some((p) => p < 0 || p > 1))
    warnings.push("pressure outside [0,1]: clamped to Excalidraw range");
  out.pressures = out.pressures.map((p) => Math.max(0, Math.min(1, p)));
  const style = new Reader(own!.subarray(g.flex)),
    m = g.styleMask;
  if (m & 1) {
    warnings.push("unknown style prefix: using black, opaque, 2-unit fallback");
    return { stroke: out, warnings };
  }
  if (m & 2) style.u32();
  if (m & 4) {
    const argb = style.u32();
    out.color = color(argb);
    out.opacity = ((argb >>> 24) * 100) / 255;
  } else warnings.push("no direct ARGB color: using black, opaque fallback");
  if (m & 8) {
    const width = style.f32();
    if (finite(width) && width > 0 && width <= 10000) out.width = width;
    else warnings.push("invalid pen width: using 2-unit fallback");
  } else warnings.push("no direct pen width: using 2-unit fallback");
  return { stroke: out, warnings };
}
