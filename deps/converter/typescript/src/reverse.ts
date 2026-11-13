import {
  Context,
  ConversionOptions,
  Document,
  Element,
  Page,
  Point,
  Scene,
} from "./model";
import { colorARGB, writeSdocx } from "./write";
import { imageAsset } from "./image";
interface InputElement extends Element {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  opacity?: number;
  isDeleted?: boolean;
  points?: Point[];
  pressures?: number[];
  simulatePressure?: boolean;
  text?: string;
  fontSize?: number;
  name?: string;
  fileId?: string;
  scale?: number[];
  crop?: unknown;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  strokeOptions?: { variability?: string };
  customData?: { samsungNotes?: { pageWidth?: number } };
}
const valid = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1e9;
function arrowHead(a: Point, b: Point, width: number): Point[] {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]),
    size = Math.min(
      Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.4,
      Math.max(12, width * 5),
    );
  return [
    [b[0] - size * Math.cos(angle - 0.5), b[1] - size * Math.sin(angle - 0.5)],
    b,
    [b[0] - size * Math.cos(angle + 0.5), b[1] - size * Math.sin(angle + 0.5)],
  ];
}
/** Matches the Go finite-page converter; unsupported content fails closed. */
export async function importScene(
  scene: Scene,
  ctx = new Context({}),
): Promise<Document> {
  if (
    scene.type !== "excalidraw" ||
    scene.version !== 2 ||
    !Array.isArray(scene.elements)
  )
    throw new Error("Expected an Excalidraw version-2 scene");
  if (scene.elements.length > 100000)
    throw new Error("Element count exceeds limit");
  const doc: Document = {
    pages: [],
    assets: new Map(),
    warnings: [
      "The canvas becomes one finite Samsung Notes page with a trailing blank page. Pen appearance, fonts, and text placement are approximate.",
    ],
  };
  const pg: Page = {
    id: "",
    width: 720,
    height: 1018,
    strokes: [],
    texts: [],
    images: [],
  };
  const sourcePage = ctx.options.sourcePageSize;
  if (sourcePage) {
    if (
      ![sourcePage.width, sourcePage.height].every(
        (size) => valid(size) && size >= 1 && size <= 20000,
      )
    )
      throw new Error("Invalid or excessive linked SDOCX page dimensions");
    pg.width = sourcePage.width;
    pg.height = sourcePage.height;
  }
  let minPageWidth = 720,
    totalPoints = 0,
    assetBytes = 0;
  for (let order = 0; order < scene.elements.length; order++) {
    await ctx.checkpoint();
    const el = scene.elements[order] as InputElement;
    if (el.isDeleted) continue;
    const x = el.x ?? 0,
      y = el.y ?? 0,
      w = el.width ?? 0,
      h = el.height ?? 0,
      angle = el.angle ?? 0,
      op = el.opacity ?? 100,
      sw = el.strokeWidth ?? 2,
      color = el.strokeColor || "#000000";
    if (
      ![x, y, w, h, angle, op, sw].every(valid) ||
      op < 0 ||
      op > 100 ||
      sw < 0 ||
      sw > 10000
    )
      throw new Error(`Invalid geometry or style in ${el.id}`);
    const sourceWidth = el.customData?.samsungNotes?.pageWidth;
    if (sourceWidth !== undefined) {
      if (!valid(sourceWidth) || sourceWidth < 1 || sourceWidth > 20000)
        throw new Error("Invalid source page width");
      minPageWidth = Math.max(minPageWidth, sourceWidth);
    }
    if (op === 0) continue;
    const addStroke = (
      points: Point[],
      pressures: number[],
      width: number,
      highlighter = false,
    ) => {
      if (!points.length) throw new Error(`Element ${el.id} has no points`);
      totalPoints += points.length;
      if (totalPoints > 4000000) throw new Error("Point limit exceeded");
      const cx = x + w / 2,
        cy = y + h / 2;
      points = points.map((p) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(valid))
          throw new Error("Invalid stroke coordinate");
        const dx = p[0] - cx,
          dy = p[1] - cy;
        return [
          cx + dx * Math.cos(angle) - dy * Math.sin(angle),
          cy + dx * Math.sin(angle) + dy * Math.cos(angle),
        ];
      });
      if (!pressures.length) pressures = points.map(() => 1 / 3);
      if (
        pressures.length !== points.length ||
        pressures.some((p) => !valid(p) || p < 0 || p > 1)
      )
        throw new Error("Invalid stroke pressures");
      colorARGB(color, op);
      pg.strokes.push({
        points,
        pressures,
        color,
        width,
        opacity: op,
        highlighter,
        order,
      });
    };
    switch (el.type) {
      case "freedraw":
      case "line":
      case "arrow": {
        const pts = (el.points ?? []).map((p) => [x + p[0], y + p[1]] as Point),
          marker = el.strokeOptions?.variability === "constant";
        let width = sw,
          pressure: number[] = [];
        if (el.type === "freedraw") {
          width = sw * (marker ? 1.4 : 4.25);
          if (!el.simulatePressure) pressure = el.pressures ?? [];
          else
            doc.warnings.push(
              "Simulated freehand pressure is exported with neutral pressure.",
            );
        }
        addStroke(pts, pressure, width, marker);
        if (el.type === "arrow" && pts.length >= 2) {
          if (el.endArrowhead)
            addStroke(
              arrowHead(pts[pts.length - 2], pts[pts.length - 1], sw),
              [],
              sw,
            );
          if (el.startArrowhead)
            addStroke(arrowHead(pts[1], pts[0], sw), [], sw);
          if (
            [el.startArrowhead, el.endArrowhead].some(
              (head) => head && head !== "arrow",
            )
          )
            doc.warnings.push("Arrowheads are approximated with open arrows.");
        }
        if (el.type !== "freedraw" && (el.roundness || el.elbowed))
          doc.warnings.push(
            "Curved and elbowed lines are approximated as straight segments.",
          );
        break;
      }
      case "rectangle":
      case "diamond":
      case "ellipse":
      case "frame": {
        let pts: Point[];
        if (el.type === "diamond")
          pts = [
            [x + w / 2, y],
            [x + w, y + h / 2],
            [x + w / 2, y + h],
            [x, y + h / 2],
            [x + w / 2, y],
          ];
        else if (el.type === "ellipse")
          pts = Array.from({ length: 129 }, (_, i) => [
            x + w / 2 + (Math.cos((2 * Math.PI * i) / 128) * w) / 2,
            y + h / 2 + (Math.sin((2 * Math.PI * i) / 128) * h) / 2,
          ]);
        else
          pts = [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
            [x, y],
          ];
        addStroke(pts, [], sw);
        if (el.backgroundColor && el.backgroundColor !== "transparent")
          throw new Error(
            `Filled shapes cannot be exported without losing their fill (${el.id}). Remove the fill first.`,
          );
        if (el.type === "frame" && el.name)
          pg.texts.push({
            order,
            value: el.name,
            x,
            y: y - 24,
            width: Math.max(100, w),
            height: 24,
            fontSize: 20,
            color,
            opacity: op,
            background: "transparent",
            backgroundOpacity: 0,
          });
        break;
      }
      case "text": {
        if (!el.text) break;
        if (angle !== 0)
          throw new Error(`Rotated text is unsupported (${el.id})`);
        const font = el.fontSize ?? 0;
        if (
          !valid(font) ||
          font <= 0 ||
          font > 10000 ||
          el.text.length > 250000
        )
          throw new Error("Invalid text size");
        colorARGB(color, op);
        pg.texts.push({
          order,
          value: el.text,
          x,
          y,
          width: Math.max(1, w),
          height: Math.max(font * 1.2, h),
          fontSize: font,
          color,
          opacity: op,
          background: "transparent",
          backgroundOpacity: 0,
        });
        break;
      }
      case "image": {
        if (
          angle !== 0 ||
          el.crop != null ||
          (el.scale && (el.scale.length !== 2 || el.scale.some((s) => s !== 1)))
        )
          throw new Error(
            `Rotated, cropped, or mirrored images are unsupported (${el.id})`,
          );
        if (w <= 0 || h <= 0) throw new Error("Invalid image size");
        const id = el.fileId ?? "",
          file = scene.files?.[id];
        if (!file)
          throw new Error(
            `Image ${id} is not loaded; wait for it to load and retry`,
          );
        if (!doc.assets.has(id)) {
          const prefix = `data:${file.mimeType};base64,`;
          if (
            !file.dataURL.startsWith(prefix) ||
            file.dataURL.length > 90 * 1024 ** 2
          )
            throw new Error(
              "Images must be embedded PNG, JPEG, or GIF data within size limits",
            );
          const raw = atob(file.dataURL.slice(prefix.length)),
            data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
          assetBytes += data.length;
          if (data.length > 64 * 1024 ** 2 || assetBytes > 128 * 1024 ** 2)
            throw new Error("Image data limit exceeded");
          const checked = imageAsset(data);
          if (checked.asset.mimeType !== file.mimeType)
            throw new Error("Image MIME type mismatch");
          doc.assets.set(id, checked.asset);
        }
        pg.images.push({
          order,
          assetID: id,
          x,
          y,
          width: w,
          height: h,
          opacity: op,
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported Excalidraw element: ${el.type}. Export stopped to preserve your note.`,
        );
    }
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const bounds = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const s of pg.strokes)
    for (const p of s.points)
      bounds(p[0] - s.width, p[1] - s.width, 2 * s.width, 2 * s.width);
  for (const t of pg.texts) bounds(t.x, t.y, t.width, t.height);
  for (const im of pg.images) bounds(im.x, im.y, im.width, im.height);
  if (minX !== Infinity) {
    const dx = minX < 0 ? 32 - minX : 0,
      dy = minY < 0 ? 32 - minY : 0;
    const neededWidth = Math.ceil(maxX + dx + 32);
    const neededHeight = Math.ceil(maxY + dy + 32);
    if (sourcePage) {
      // Expand both dimensions together when edits extend outside the paper.
      // The drawing coordinates stay intact and the original aspect is retained.
      const scale = Math.max(
        1,
        neededWidth / sourcePage.width,
        neededHeight / sourcePage.height,
      );
      pg.width = Math.round(sourcePage.width * scale);
      pg.height = Math.round(sourcePage.height * scale);
    } else {
      pg.width = Math.max(minPageWidth, neededWidth);
      pg.height = Math.max(1018, neededHeight);
    }
    if (pg.width > 20000 || pg.height > 20000)
      throw new Error("Canvas exceeds the 20000-unit Samsung page limit");
    for (const s of pg.strokes)
      for (const p of s.points) {
        p[0] += dx;
        p[1] += dy;
      }
    for (const o of [...pg.texts, ...pg.images]) {
      o.x += dx;
      o.y += dy;
    }
  }
  doc.pages = [pg];
  doc.warnings = [...new Set(doc.warnings)];
  return doc;
}
export async function convertExcalidraw(
  scene: Scene,
  title: string,
  options: ConversionOptions = {},
) {
  const ctx = new Context(options),
    doc = await importScene(scene, ctx);
  await ctx.checkpoint(true);
  const bytes = writeSdocx(doc, title);
  ctx.check();
  return { bytes, warnings: doc.warnings };
}
