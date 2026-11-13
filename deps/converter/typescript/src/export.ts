import { Context, Document, Element, Scene } from "./model";
import { base64, hash } from "./image";
export const stableID = (key: string) =>
  hash(new TextEncoder().encode(key)).slice(0, 24);
function base(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Element {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    created: null,
    link: null,
    locked: false,
  };
}
export async function exportScene(doc: Document, ctx: Context): Promise<Scene> {
  const strokeScale = ctx.options.strokeScale ?? 1,
    scene: Scene = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff", gridSize: null },
      files: {},
    };
  let y = 0;
  for (let pi = 0; pi < doc.pages.length; pi++) {
    await ctx.checkpoint();
    ctx.progress("export", pi, doc.pages.length);
    const p = doc.pages[pi];
    if (
      !Number.isFinite(p.width) ||
      !Number.isFinite(p.height) ||
      p.width <= 0 ||
      p.height <= 0
    )
      throw new Error("invalid page dimensions");
    const frameID = stableID(`page/${pi}/${p.id}`),
      frame = base(frameID, "frame", 0, y, p.width, p.height);
    frame.name = `Page ${pi + 1}`;
    const parentFrame = ctx.options.pageFrames ? frameID : null,
      elements: Element[] = [],
      orders = new Map<string, number>();
    for (let ii = 0; ii < p.images.length; ii++) {
      const im = p.images[ii],
        asset = doc.assets.get(im.assetID);
      if (!asset) throw new Error(`missing image asset ${im.assetID}`);
      if (
        !asset.data.length ||
        !["image/jpeg", "image/png", "image/gif"].includes(asset.mimeType)
      )
        throw new Error("invalid image asset");
      if (im.width <= 0 || im.height <= 0 || im.opacity < 0 || im.opacity > 100)
        throw new Error("invalid image dimensions or opacity");
      if (!scene.files[im.assetID])
        scene.files[im.assetID] = {
          id: im.assetID,
          mimeType: asset.mimeType,
          dataURL: `data:${asset.mimeType};base64,${base64(asset.data)}`,
          created: 0,
          lastRetrieved: 0,
        };
      const el = base(
        stableID(`${frameID}/image/${ii}`),
        "image",
        im.x,
        y + im.y,
        im.width,
        im.height,
      );
      Object.assign(el, {
        fileId: im.assetID,
        status: "saved",
        scale: [1, 1],
        crop: null,
        opacity: im.opacity,
        frameId: parentFrame,
      });
      elements.push(el);
      orders.set(el.id, im.order);
    }
    for (let ti = 0; ti < p.texts.length; ti++) {
      const t = p.texts[ti],
        id = stableID(`${frameID}/text/${ti}`);
      if (t.fontSize <= 0 || t.width < 0 || t.height <= 0)
        throw new Error("invalid text dimensions");
      if (
        t.background &&
        t.background !== "transparent" &&
        t.backgroundOpacity > 0
      ) {
        const bg = base(
          id + "-background",
          "rectangle",
          t.x,
          y + t.y,
          t.width,
          t.height,
        );
        Object.assign(bg, {
          backgroundColor: t.background,
          strokeColor: "transparent",
          strokeWidth: 0,
          opacity: t.backgroundOpacity,
          frameId: parentFrame,
        });
        elements.push(bg);
        orders.set(bg.id, t.order);
      }
      const el = base(id, "text", t.x, y + t.y, t.width, t.height);
      Object.assign(el, {
        strokeColor: t.color,
        opacity: t.opacity,
        frameId: parentFrame,
        text: t.value,
        originalText: t.value,
        fontSize: t.fontSize,
        fontFamily: 2,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.2,
      });
      elements.push(el);
      orders.set(el.id, t.order);
    }
    for (let si = 0; si < p.strokes.length; si++) {
      if (si % 32 === 0) await ctx.checkpoint();
      const s = p.strokes[si];
      if (!s.points.length) throw new Error("empty stroke");
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const [x, y] of s.points) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const el = base(
        stableID(`${frameID}/stroke/${si}`),
        "freedraw",
        x0,
        y + y0,
        x1 - x0,
        y1 - y0,
      );
      Object.assign(el, {
        strokeColor: s.color,
        strokeWidth: (s.width / 4.25) * strokeScale,
        opacity: s.opacity,
        frameId: parentFrame,
        points: s.points.map(([x, y]) => [x - x0, y - y0]),
        pressures: s.pressures,
        simulatePressure: false,
        lastCommittedPoint: null,
      });
      if (s.highlighter) {
        el.strokeOptions = { variability: "constant", streamline: 0 };
        el.strokeWidth = (s.width / 1.4) * strokeScale;
      }
      if (
        s.pressures.length !== s.points.length ||
        s.pressures.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
      )
        throw new Error("invalid normalized pressure");
      elements.push(el);
      orders.set(el.id, s.order);
    }
    for (const el of elements)
      el.customData = { samsungNotes: { pageWidth: p.width } };
    elements.sort((a, b) => orders.get(a.id)! - orders.get(b.id)!);
    for (const element of elements) scene.elements.push(element);
    if (ctx.options.pageFrames) scene.elements.push(frame);
    y += p.height + 100;
  }
  // JSON.stringify silently converts non-finite numbers to null; reject explicitly.
  JSON.stringify(scene, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("non-finite scene number");
    return value;
  });
  ctx.progress("export", doc.pages.length, doc.pages.length);
  return scene;
}
