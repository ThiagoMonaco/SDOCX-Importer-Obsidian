# SDOCX Importer

Import Samsung Notes SDOCX exports as editable Excalidraw drawings in Obsidian and export edited drawings back to linked SDOCX files. Conversion runs locally.

Requires Obsidian 1.8.7 or later and Excalidraw 2.29.1 or later, enabled in the same vault.

## Install

1. Download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](../../releases).
2. Put the three files in your vault's `.obsidian/plugins/samsung-notes-importer/` directory.
3. Reload Obsidian and enable **SDOCX Importer** under **Community plugins**.

## Use

Put SDOCX exports into `SDOCX/Inbox`. The plugin creates drawings in `SDOCX/Drawings`. Use **Scan SDOCX inbox** to scan on demand and **Review pending SDOCX imports** to review changed files. Keep synced drawings under your configured output folder so the plugin can rediscover their links.

Open a linked drawing and run **Export active drawing back to linked SDOCX** to review and save your edits. The plugin verifies a backup before replacing the linked file. Some content, including rotated text, cropped images, and native objects such as audio or PDFs, cannot round-trip. Review conversion warnings before replacing a source.

## Build

Use Node.js 22.

```sh
npm ci
npm run package
```

The build writes installable files to `dist/` and a ZIP and checksum to `release/`.

## License

[MIT](LICENSE). See the [third-party notices](THIRD_PARTY_NOTICES.md).
