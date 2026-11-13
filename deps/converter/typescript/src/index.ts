import { Archive } from "./archive";
import { Context, ConversionOptions, ConversionResult } from "./model";
import { Parser, noteBody, pageIDs } from "./parser";
import { exportScene } from "./export";
export type {
  ConversionOptions,
  ConversionResult,
  Progress,
  Scene,
} from "./model";
export async function convertSdocx(
  bytes: Uint8Array | ArrayBuffer,
  options: ConversionOptions = {},
): Promise<ConversionResult> {
  for (const [name, value] of [
    ["stroke scale", options.strokeScale ?? 1],
    ["text line height", options.textLineHeight ?? 1.9],
  ] as const)
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive finite number`);
  const ctx = new Context(options);
  await ctx.checkpoint(true);
  ctx.progress("archive", 0, 1);
  const archive = new Archive(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    ctx,
  );
  const ids = pageIDs(await archive.read("pageIdInfo.dat")),
    body = noteBody(await archive.read("note.note"));
  ctx.progress("archive", 1, 1);
  const doc = await new Parser(archive, ctx).read(ids, body),
    scene = await exportScene(doc, ctx);
  const statistics = {
    pages: doc.pages.length,
    strokes: 0,
    points: 0,
    texts: 0,
    highlights: 0,
    images: 0,
  };
  for (const p of doc.pages) {
    statistics.strokes += p.strokes.length;
    statistics.texts += p.texts.length;
    statistics.images += p.images.length;
    for (const s of p.strokes) {
      statistics.points += s.points.length;
      if (s.highlighter) statistics.highlights++;
    }
  }
  return { scene, warnings: [...new Set(doc.warnings)], statistics };
}
export { convertExcalidraw } from "./reverse";
export { checkAbort } from "./model";
export { hash } from "./image";
export { readSdocxIdentity, readSdocxPageSize, readSdocxTitle } from "./parser";
export { renameSdocx } from "./write";
