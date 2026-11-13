import { Archive } from "./archive";
import { Context, Document, Page, Stroke, limits } from "./model";
import { Reader, mask, safeName } from "./reader";
import { stroke } from "./stroke";
import {
  RichText,
  emptyText,
  layoutText,
  textObject,
  textBounds,
  textBoxInset,
  textBoxScale,
  textScale,
  textSectionsValid,
} from "./text";
import { imageObject, mediaIndex, imageAsset, hash } from "./image";
export function pageIDs(data: Uint8Array) {
  const r = new Reader(data);
  r.skip(32);
  const n = r.u16();
  if (n < 1 || n > limits.pages) r.fail(`invalid page count ${n}`);
  const ids: string[] = [],
    seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const id = r.str16();
    r.skip(32);
    if (!safeName(id) || seen.has(id))
      r.fail(`invalid or duplicate page ID ${id}`);
    seen.add(id);
    ids.push(id);
  }
  if (r.pos !== data.length) r.fail("unsupported page index trailing data");
  return ids;
}
function readPageHeader(r: Reader) {
  const layerOff = r.u32(),
    propOff = r.u32();
  if (r.u8() !== 4) r.fail("unsupported page header");
  r.u32();
  if (r.u8() !== 4) r.fail("unsupported page header");
  const props = r.u32();
  r.u32();
  const width = r.u32(),
    height = r.u32();
  if (!width || !height || width > 1000000 || height > 1000000)
    r.fail("invalid page dimensions");
  return { layerOff, propOff, props, width, height };
}

export async function readSdocxPageSize(bytes: Uint8Array) {
  const archive = new Archive(bytes, new Context({}));
  const [id] = pageIDs(await archive.read("pageIdInfo.dat"));
  const { width, height } = readPageHeader(
    new Reader(await archive.read(id + ".page")),
  );
  return { width, height };
}
export function noteFields(data: Uint8Array) {
  const r = new Reader(data),
    flex = r.u32(),
    flags = mask(r);
  mask(r);
  const version = r.u32();
  r.str16();
  r.skip(4 + 16);
  const width = r.u32(),
    height = r.u32();
  r.skip(12);
  if (!version || !width || !height || width > 1000000 || height > 100000000)
    r.fail("invalid note metadata");
  const titleOffset = r.pos;
  const title = r.take(r.u32());
  const bodyOffset = r.pos;
  const body = r.take(r.u32());
  if (flags & 8) {
    const w = r.u32(),
      h = r.u32();
    if (!w || !h || w > 1000000 || h > 1000000)
      r.fail(
        "missing or invalid default page dimensions declared by note header",
      );
  }
  if (flex < r.pos || flex > data.length)
    r.fail("invalid note flexible offset");
  return { titleOffset, bodyOffset, title, body, flex, width };
}
export function noteBody(data: Uint8Array) {
  const { body } = noteFields(data);
  return body.length ? textObject(body) : emptyText();
}
export async function readSdocxTitle(bytes: Uint8Array) {
  return (await readSdocxIdentity(bytes)).title;
}
export async function readSdocxIdentity(bytes: Uint8Array) {
  const archive = new Archive(bytes, new Context({}));
  const { title, body } = noteFields(await archive.read("note.note"));
  const units = title.length ? textObject(title).units : [];
  if (units.length > 1000) throw new Error("Invalid note title length");
  const index = await archive.read("pageIdInfo.dat");
  const content = [...archive.entries.values()]
    .filter(
      (entry) =>
        !["note.note", "pageIdInfo.dat", "end_tag.bin"].includes(entry.name),
    )
    .map((entry) => JSON.stringify([entry.name, entry.size, entry.crc]))
    .sort();
  content.push(hash(body), hash(index.subarray(32)));
  return {
    title: String.fromCharCode(...units).trim(),
    contentHash: hash(new TextEncoder().encode(content.join("\n"))),
  };
}
export class Parser {
  readonly doc: Document = {
    pages: [],
    assets: new Map(),
    warnings: [
      "Samsung pen materials and pressure response are approximated by Excalidraw's renderer",
    ],
  };
  objects = 0;
  points = 0;
  private layerOrder = 0;
  private media?: Map<number, string>;
  private resolved = new Map<number, string>();
  constructor(
    private archive: Archive,
    private ctx: Context,
  ) {}
  async loadImage(data: Uint8Array) {
    const { image, bind } = imageObject(data);
    if (!this.resolved.has(bind)) {
      this.media ??= mediaIndex(await this.archive.read("media/mediaInfo.dat"));
      const name = this.media.get(bind);
      if (!name) throw new Error(`missing image media bind ID ${bind}`);
      const { id, asset } = imageAsset(await this.archive.read(name));
      this.doc.assets.set(id, asset);
      this.resolved.set(bind, id);
    }
    image.assetID = this.resolved.get(bind)!;
    return image;
  }
  async read(ids: string[], body: RichText) {
    body.lineAdvance = this.ctx.options.textLineHeight ?? 1.9;
    this.doc.warnings.push(...body.warnings);
    for (let i = 0; i < ids.length; i++) {
      this.ctx.progress("pages", i, ids.length);
      const pg = await this.page(
        ids[i],
        await this.archive.read(ids[i] + ".page"),
      );
      this.doc.pages.push(pg);
    }
    for (const o of body.objects) {
      if (o.kind !== 3 && o.kind !== 7) {
        this.doc.warnings.push(
          `unsupported inline object type ${o.kind} omitted`,
        );
        continue;
      }
      if (!textSectionsValid(body, this.doc.pages.length))
        throw new Error(
          "cannot place inline image without valid page sections",
        );
      const page = body.sections.findIndex(
        (s) => o.target >= s.start && o.target < s.start + s.length,
      );
      if (page < 0) throw new Error("inline image target has no page");
      if (body.inlineImages.has(o.target))
        throw new Error("multiple inline images at one text target");
      const im = await this.loadImage(o.data);
      body.inlineImages.set(o.target, im);
      this.doc.pages[page].images.push(im);
    }
    if (body.units.length) {
      await layoutText(
        this.doc,
        body,
        0,
        0,
        0,
        this.doc.pages[0].width,
        textScale(this.doc.pages[0].width),
        true,
        this.ctx,
      );
      this.doc.warnings.push(
        "typed text uses sans-serif font substitution and approximate layout metrics",
      );
    }
    const names = new Set(ids.map((id) => id + ".page"));
    for (const name of this.archive.entries.keys())
      if (name.endsWith(".page") && !names.has(name))
        throw new Error(`page ${name} is absent from pageIdInfo.dat`);
    this.ctx.progress("pages", ids.length, ids.length);
    return this.doc;
  }
  async page(id: string, data: Uint8Array) {
    const pg: Page = {
        id,
        width: 0,
        height: 0,
        strokes: [],
        texts: [],
        images: [],
      },
      r = new Reader(data);
    const { layerOff, propOff, props, width, height } = readPageHeader(r);
    pg.width = width;
    pg.height = height;
    r.skip(8);
    const pageID = r.str16();
    r.skip(16);
    if (pageID !== id) r.fail("page UUID does not match index");
    if (propOff < r.pos || layerOff < propOff || layerOff >= data.length - 4)
      r.fail("invalid page section offsets");
    if (props & (0x4 | 0x8 | 0x100 | 0x200 | 0x40000))
      this.doc.warnings.push(
        `page ${id}: background/template/PDF/custom page content is not exported`,
      );
    r.seek(layerOff);
    const n = r.u16();
    r.u16();
    if (n > 1024) r.fail("excessive layer count");
    const layers: { number: number; strokes: Stroke[] }[] = [];
    for (let i = 0; i < n; i++) {
      await this.ctx.checkpoint();
      const start = r.pos,
        size = r.u32(),
        meta = r.u32(),
        a = r.u8(),
        flags = r.u8(),
        b = r.u8(),
        optional = r.u8(),
        number = r.u32();
      if (optional & 1 && !(flags & 1))
        this.doc.warnings.push(`page ${id}: layer transparency is not applied`);
      if (
        size < 16 ||
        size > data.length - start - 4 ||
        meta < start + 16 ||
        meta > start + size ||
        a !== 1 ||
        b !== 1
      )
        r.fail(`invalid layer header at ${start}`);
      r.seek(start + size);
      const count = r.u32();
      this.layerOrder = number * (limits.objects + 1);
      const strokes = await this.objectsRead(r, count, 0, !(flags & 1), pg);
      r.skip(32);
      layers.push({ number, strokes });
    }
    const tail = data.length - r.pos;
    if (tail !== 58 && tail !== 60)
      r.fail(`unsupported page trailer (${tail} bytes)`);
    layers.sort((a, b) => a.number - b.number);
    pg.strokes = layers.flatMap((l) => l.strokes);
    return pg;
  }
  private async objectsRead(
    r: Reader,
    count: number,
    depth: number,
    visible: boolean,
    pg: Page,
  ): Promise<Stroke[]> {
    if (depth > 32 || count > limits.objects - this.objects)
      r.fail("object count or nesting limit exceeded");
    const strokes: Stroke[] = [];
    for (let i = 0; i < count; i++) {
      if (i % 32 === 0) await this.ctx.checkpoint();
      if (++this.objects > limits.objects)
        r.fail("object count limit exceeded");
      const typ = r.u8(),
        children = r.u16();
      if (
        ![1, 2, 3, 4, 7, 8, 10, 11, 13, 14, 15, 17, 19, 20, 21, 23].includes(
          typ,
        )
      )
        r.fail(`unknown object type ${typ}; cannot determine record boundary`);
      const size = r.u32();
      if (size < 38) r.fail(`invalid object size ${size}`);
      const obj = r.take(size).subarray(0, size - 32);
      if (visible) {
        if (typ === 1 || typ === 15) {
          const result = stroke(obj),
            s = result.stroke;
          if (s.points.length > limits.points - this.points)
            r.fail("total point limit exceeded");
          this.points += s.points.length;
          s.order = this.layerOrder + this.objects;
          strokes.push(s);
          this.doc.warnings.push(
            ...result.warnings.map(
              (w) => `page ${pg.id} stroke ${i + 1}: ${w}`,
            ),
          );
        } else if (typ === 3 || typ === 7) {
          const im = await this.loadImage(obj);
          im.order = this.layerOrder + this.objects;
          pg.images.push(im);
        } else if (typ === 2) {
          let content: RichText | undefined;
          try {
            content = textObject(obj);
          } catch (err) {
            this.doc.warnings.push(
              `page ${pg.id}: unsupported text object omitted: ${(err as Error).message}`,
            );
          }
          if (content) {
            const b = textBounds(obj),
              tmp: Document = {
                pages: [
                  {
                    id: "",
                    width: b[2] - b[0],
                    height: b[3] - b[1],
                    texts: [],
                    strokes: [],
                    images: [],
                  },
                ],
                assets: new Map(),
                warnings: [],
              };
            const [insetX, insetY] = textBoxInset(pg.width);
            await layoutText(
              tmp,
              content,
              0,
              b[0] + insetX,
              b[1] + insetY,
              tmp.pages[0].width,
              textBoxScale(pg.width),
              false,
              this.ctx,
            );
            for (const text of tmp.pages[0].texts) {
              text.order = this.layerOrder + this.objects;
              pg.texts.push(text);
            }
            this.doc.warnings.push(...content.warnings);
          }
        } else
          this.doc.warnings.push(
            `page ${pg.id}: unsupported object type ${typ} omitted`,
          );
      }
      if (children) {
        if (typ !== 4)
          r.fail(`unsupported child records for object type ${typ}`);
        strokes.push(
          ...(await this.objectsRead(r, children, depth + 1, visible, pg)),
        );
      }
    }
    return strokes;
  }
}
