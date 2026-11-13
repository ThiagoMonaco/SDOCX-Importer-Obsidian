import { Context, Document, ImageObject, TextRun } from "./model";
import { Reader, finite, color } from "./reader";
interface Span {
  kind: number;
  start: number;
  end: number;
  color: number;
  size: number;
}
export interface RichText {
  sections: { start: number; length: number }[];
  objects: { kind: number; target: number; data: Uint8Array }[];
  inlineImages: Map<number, ImageObject>;
  lineAdvance: number;
  units: number[];
  spans: Span[];
  margins: number[];
  warnings: string[];
}
export const emptyText = (): RichText => ({
  sections: [],
  objects: [],
  inlineImages: new Map(),
  lineAdvance: 0,
  units: [],
  spans: [],
  margins: [0, 0, 0, 0],
  warnings: [],
});
export function textObject(data: Uint8Array): RichText {
  const r = new Reader(data);
  while (r.pos < data.length) {
    const start = r.pos,
      size = r.u32(),
      typ = r.u16();
    if (size < 6 || size > data.length - start)
      r.fail("invalid text subrecord size");
    if (typ === 7) {
      const shape = new Reader(data.subarray(start, start + size));
      shape.skip(6);
      const own = shape.u32();
      shape.skip(3);
      const m = shape.u32();
      if (!(m & 1)) shape.fail("shape has no text payload");
      if (own < shape.pos || own > size - 4)
        shape.fail("invalid TextCommon offset");
      shape.seek(own);
      const body = shape.take(shape.u32());
      if (m & 0x2000 && shape.u8() !== 2)
        shape.fail("missing text shape trailer declared by flag 0x2000");
      return parseText(body);
    }
    r.seek(start + size);
  }
  return r.fail("no text shape subrecord");
}
export function parseText(data: Uint8Array): RichText {
  const out = emptyText(),
    r = new Reader(data),
    n = r.u32();
  if (n > 250000) r.fail("text length limit exceeded");
  const u = new Reader(r.take(n * 2));
  for (let i = 0; i < n; i++) out.units.push(u.u16());
  const count = r.u32();
  if (count > 10000 || count * n > 10000000)
    r.fail("text span count or layout complexity limit exceeded");
  for (let i = 0; i < count; i++) {
    const size = r.u16();
    if (size < 20) r.fail("invalid text span size");
    const s = new Reader(r.take(size)),
      span = { kind: s.u32(), start: s.u32(), end: s.u32(), color: 0, size: 0 };
    s.u32();
    if (span.start > span.end || span.end > n)
      r.fail("invalid text span range");
    if (span.kind === 1 || span.kind === 17) span.color = s.u32();
    else if (span.kind === 3) {
      span.size = s.f32();
      if (!finite(span.size) || span.size <= 0 || span.size > 10000)
        s.fail("invalid text font size");
    } else
      out.warnings.push(
        `text style span ${span.kind} is approximated with plain sans-serif text`,
      );
    out.spans.push(span);
  }
  const paragraphs = r.u32();
  if (paragraphs > 10000) r.fail("paragraph count limit exceeded");
  for (let i = 0; i < paragraphs; i++) {
    const size = r.u16();
    if (size < 20) r.fail("invalid paragraph size");
    const p = new Reader(r.take(size)),
      kind = p.u32(),
      start = p.u32(),
      end = p.u32(),
      value = p.u32();
    if (start > end || end > n + 1) p.fail("invalid paragraph range");
    if (kind !== 6 && !(kind === 3 && value === 0))
      out.warnings.push("paragraph alignment/list/spacing is approximated");
  }
  for (let i = 0; i < 4; i++) {
    const v = r.f32();
    if (!finite(v) || v < 0 || v > 10000) r.fail("invalid text margin");
    out.margins[i] = v;
  }
  r.u8();
  const refs = r.u16();
  if (refs > 4096) r.fail("text reference count limit exceeded");
  for (let i = 0; i < refs; i++) {
    const start = r.u32(),
      length = r.u32();
    if (start + length > n)
      out.warnings.push(
        "invalid or legacy text page sections: using estimated pagination",
      );
    out.sections.push({ start, length });
  }
  if (r.pos < data.length) {
    const flags = r.u32();
    r.u32();
    if (flags & 1) {
      const count = r.u32();
      if (count > 4096) r.fail("embedded text object limit exceeded");
      for (let i = 0; i < count; i++) {
        const record = new Reader(r.take(r.u32())),
          size = record.u32(),
          kind = record.u32(),
          blob = record.take(size),
          target = record.u32();
        if (target >= n) r.fail("invalid inline object target");
        out.objects.push({ kind, target, data: blob });
      }
    }
  }
  if (r.pos !== data.length) r.fail("unsupported TextCommon trailing data");
  return out;
}
export function textSectionsValid(t: RichText, pages: number) {
  if (t.sections.length !== pages) return false;
  let end = 0;
  for (const s of t.sections) {
    if (s.start !== end) return false;
    end += s.length;
  }
  return end === t.units.length;
}
function style(t: RichText, index: number) {
  let size = 14,
    foreground = 0xff252525,
    background = 0;
  for (const s of t.spans)
    if (index >= s.start && index < s.end) {
      if (s.kind === 1) foreground = s.color;
      if (s.kind === 3) size = s.size;
      if (s.kind === 17) background = s.color;
    }
  return { size, foreground, background };
}
export function textScale(width: number) {
  if (width <= 720) return Math.max(0.5, (1.6 * width) / 720);
  if (width < 961) return 1.6 + ((width - 720) / (961 - 720)) * 1.6;
  if (width < 1080) return 3.2 + ((width - 961) / (1080 - 961)) * (2.19 - 3.2);
  return Math.min(8, (2.19 * width) / 1080);
}
export function textBoxScale(width: number) {
  // Samsung draws positioned text with a larger scale than flowing body text.
  return textScale(width) * 1.4;
}
export function textBoxInset(width: number): [number, number] {
  // The native renderer adds padding beyond the margins stored in the box.
  const scale = textBoxScale(width);
  return [6 * scale, 4 * scale];
}
export function charWidth(ch: string, size: number) {
  if (ch === "\t") return size * 1.112;
  if (ch === " " || "ilI.,!:;'|".includes(ch)) return size * 0.278;
  if ("mwMW@".includes(ch)) return size * 0.833;
  if (/\p{Mn}/u.test(ch)) return 0;
  if (ch.codePointAt(0)! > 0x2fff) return size;
  if (/\p{Lu}/u.test(ch)) return size * 0.667;
  return size * 0.556;
}
export async function layoutText(
  doc: Document,
  t: RichText,
  firstPage: number,
  x: number,
  y: number,
  width: number,
  scale: number,
  paginate: boolean,
  ctx: Context,
) {
  if (!doc.pages.length) throw new Error("text has no page");
  let page = firstPage,
    sectionIndex = 0,
    lineHeight = 0,
    run = -1,
    value = "";
  const sections = paginate && textSectionsValid(t, doc.pages.length),
    left = x + t.margins[0],
    top = y + t.margins[1],
    right = left + width - t.margins[0] - t.margins[2],
    advanceEm = t.lineAdvance || 1.2;
  x = left;
  y = top;
  const flush = () => {
    if (run >= 0) {
      doc.pages[page].texts[run].value = value;
      value = "";
    }
  };
  const advance = () => {
    flush();
    if (!lineHeight) lineHeight = 14 * scale * advanceEm;
    y += lineHeight;
    x = left;
    lineHeight = 0;
    run = -1;
    if (
      paginate &&
      !sections &&
      y + 14 * scale * 1.2 > doc.pages[page].height - t.margins[3]
    ) {
      page++;
      if (page >= doc.pages.length)
        throw new Error("typed text exceeds available pages");
      y = top;
    }
  };
  for (let i = 0; i < t.units.length; ) {
    if (i % 256 === 0) await ctx.checkpoint();
    const start = i;
    if (sections) {
      while (
        sectionIndex < t.sections.length - 1 &&
        start >=
          t.sections[sectionIndex].start + t.sections[sectionIndex].length
      )
        sectionIndex++;
      if (sectionIndex !== page) {
        flush();
        page = sectionIndex;
        x = left;
        y = top;
        run = -1;
        lineHeight = 0;
      }
    }
    let code = t.units[i++];
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i < t.units.length &&
      t.units[i] >= 0xdc00 &&
      t.units[i] <= 0xdfff
    )
      code = 0x10000 + ((code - 0xd800) << 10) + t.units[i++] - 0xdc00;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    const ch = String.fromCodePoint(code),
      image = t.inlineImages.get(start);
    if (image && ch === "\ufffc") {
      flush();
      run = -1;
      y = Math.max(y, image.y + image.height);
      continue;
    }
    if (ch === "\ufffc") continue;
    const s = style(t, start),
      font = s.size * scale,
      height = font * 1.2;
    lineHeight = Math.max(lineHeight, font * advanceEm);
    if (ch === "\r") continue;
    if (ch === "\n") {
      advance();
      continue;
    }
    const w = charWidth(ch, font);
    if (x + w > right && x > left) {
      advance();
      lineHeight = font * advanceEm;
    }
    if (w > right - left) throw new Error("text glyph exceeds available width");
    const pg = doc.pages[page],
      fg = color(s.foreground),
      bgOpacity = ((s.background >>> 24) * 100) / 255,
      background = bgOpacity > 0 ? color(s.background) : "transparent",
      opacity = ((s.foreground >>> 24) * 100) / 255;
    const last = pg.texts[run];
    if (
      !last ||
      last.fontSize !== font ||
      last.color !== fg ||
      last.opacity !== opacity ||
      last.background !== background ||
      last.backgroundOpacity !== bgOpacity
    ) {
      flush();
      const text: TextRun = {
        x,
        y,
        fontSize: font,
        color: fg,
        opacity,
        background,
        backgroundOpacity: bgOpacity,
        width: 0,
        height: 0,
        value: "",
        order: 0,
      };
      pg.texts.push(text);
      run = pg.texts.length - 1;
    }
    value += ch;
    pg.texts[run].width += w;
    pg.texts[run].height = Math.max(pg.texts[run].height, height);
    x += w;
  }
  flush();
}
export function textBounds(data: Uint8Array): [number, number, number, number] {
  let r = new Reader(data);
  const size = r.u32();
  if (size < 6 || size > data.length) r.fail("invalid base subrecord size");
  r = new Reader(data.subarray(0, size));
  r.u32();
  if (r.u16() !== 0) r.fail("missing text base subrecord");
  r.u32();
  r.skip(r.u8());
  r.skip(r.u8());
  r.skip(4);
  r.skip(r.u16());
  r.skip(8);
  const b: [number, number, number, number] = [
    r.f64(),
    r.f64(),
    r.f64(),
    r.f64(),
  ];
  if (!b.every(finite)) r.fail("invalid text bounding box");
  if (b[2] <= b[0] || b[3] <= b[1]) r.fail("empty text bounding box");
  return b;
}
