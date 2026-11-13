import { build } from "esbuild";
import { mkdir, copyFile, readFile } from "node:fs/promises";
const worker = await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
});
const result = await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian"],
  define: { CONVERTER_WORKER: JSON.stringify(worker.outputFiles[0].text) },
  metafile: true,
  logLevel: "info",
});
for (const output of Object.values(result.metafile.outputs))
  for (const entry of output.imports)
    if (entry.external && entry.path !== "obsidian")
      throw new Error(`Unexpected external runtime dependency: ${entry.path}`);
await mkdir("dist", { recursive: true });
for (const file of [
  "manifest.json",
  "styles.css",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
])
  await copyFile(file, `dist/${file}`);
const manifest = JSON.parse(await readFile("manifest.json", "utf8")),
  pkg = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== pkg.version)
  throw new Error("Manifest/package version mismatch");
