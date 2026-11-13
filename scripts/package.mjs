import { readFile, mkdir, writeFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
const manifest = JSON.parse(await readFile("manifest.json", "utf8")),
  files = {};
for (const name of [
  "main.js",
  "manifest.json",
  "styles.css",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
])
  files[`${manifest.id}/${name}`] = [
    new Uint8Array(await readFile(`dist/${name}`)),
    { mtime: new Date(2020, 0, 1, 0, 0, 0) },
  ];
const zip = zipSync(files, { level: 9 });
await mkdir("release", { recursive: true });
const name = `${manifest.id}-${manifest.version}.zip`;
await writeFile(`release/${name}`, zip);
await writeFile(
  `release/${name}.sha256`,
  `${createHash("sha256").update(zip).digest("hex")}  ${name}\n`,
);
console.log(`Created release/${name}`);
