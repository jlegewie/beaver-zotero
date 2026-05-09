# beaver-extract CLI

Local Node-based CLI for the BeaverExtract PDF pipeline. Runs the same
extraction code as the Zotero plugin's worker, in-process under Node —
no Zotero, no HTTP round-trip, no XPI rebuild between iterations.

## Install

```bash
npm install
```

This pulls `tsx` (TypeScript runner), `commander` (arg parsing), and
`sharp` (PNG composite for the `overlay` command). All three are
devDependencies; they don't ship in the Zotero plugin XPI.

The CLI loads `mupdf-wasm.{mjs,wasm}` and `sentencex/*` directly from
`addon/content/lib/` — the same WASM the plugin ships, so there's
nothing else to install.

## Run

```bash
npm run beaver-extract -- <command> [options]
```

The `--` after `npm run beaver-extract` is required so npm forwards
arguments to `tsx` instead of consuming them.

### One-line examples

```bash
SMOKE=tests/fixtures/pdfs/sentences/_shared/0a3a5c40534376346b36c03c4469694674fd85ea1493c493be7c777df1ea4561.pdf

# Page count + metadata
npm run beaver-extract -- info "$SMOKE"

# Structured extract for pages 0 and 1, pretty-printed JSON
npm run beaver-extract -- extract "$SMOKE" --pages 0,1 --json --pretty

# Render page 0 with sentence overlays + JSON sidecar
npm run beaver-extract -- overlay "$SMOKE" --page 0 --level sentences \
    --out /tmp/overlay.png --sidecar-json

# Document-wide style + margin analysis
npm run beaver-extract -- analyze-layout "$SMOKE" --pages 0 --json

# Render pages 0,1,2 to /tmp/render/
npm run beaver-extract -- render "$SMOKE" --pages 0,1,2 --out /tmp/render/

# Per-character quad info for one page
npm run beaver-extract -- raw-detailed "$SMOKE" --page 0 --json
```

For per-command help, append `--help`:

```bash
npm run beaver-extract -- overlay --help
```

## Commands

| Command          | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `info`           | Page count + metadata (title, author, page labels).    |
| `extract`        | Full structured (default) or markdown extract.         |
| `overlay`        | Render one page with extraction overlays composited.   |
| `analyze-layout` | Document-wide style + margin analysis.                 |
| `raw-detailed`   | Per-character quad info for one page.                  |
| `render`         | Render one or more pages to PNG.                       |

Overlay levels: `columns | lines | paragraphs | sentences | margins`.

## Output

Every command supports `--json` (and `--pretty`). Success envelope:

```json
{
  "ok": true,
  "input": { "file": "...", "pdfSha256": "...", "pdfBytes": 1234567 },
  "options": { "pageIndices": [0], "analysisWindow": 3 },
  "result": { ... command-specific shape ... }
}
```

Failure envelope (written to stderr; process exits non-zero):

```json
{
  "ok": false,
  "error": {
    "name": "ExtractionError",
    "code": "PAGE_OUT_OF_RANGE",
    "message": "Page index 30 out of range (0..18)",
    "payload": { "details": ..., "pageLabels": ..., "pageCount": ... }
  }
}
```

`render` never inlines PNG bytes into JSON; per-page entries report
`path`, `width`, `height`, `byteLength`, `sha256`. Use
`render --inline-base64` to opt in to embedded bytes.

`overlay --sidecar-json` writes a companion `<out>.json` with rect data,
stats, and effective options for offline diffing.

## Configuration

| Env var                    | Default                              | Purpose                              |
| -------------------------- | ------------------------------------ | ------------------------------------ |
| `BEAVER_EXTRACT_WASM_DIR`  | `<repo>/addon/content/lib`           | Override WASM file directory.        |

## Testing

```bash
npm test                    # unit tier — in-process, mocked deps, fast
npm run typecheck:cli       # tsc on tsconfig.cli.json
npm run test:cli-smoke      # opt-in: real MuPDF + sharp
```

The smoke tier uses real WASM and `sharp`, so it's deliberately separate
from `npm test` because of the install/runtime sensitivity of those
native deps.

## Architecture

```
src/services/pdf/
├── cli/                # commander + per-command files (this dir)
│   ├── main.ts         # 5-line wrapper around runCli
│   ├── commands/       # one file per command
│   ├── envelope.ts     # success/error JSON envelope builders
│   ├── io.ts           # loadPdf, writePngFile, writeJsonFile, pdfSha256
│   ├── options.ts      # --pages, --page-range, --analysis-window parsers
│   └── runCliTypes.ts  # CliDeps interface
├── node/               # Node runtime (MuPDF + sentencex bootstrap, sharp overlay)
│   ├── bootstrap.ts    # ensureMuPDFNode, ensureSentencexNode
│   ├── api.ts          # typed Node API: extractPdf, renderPages, ...
│   ├── overlayPng.ts   # sharp + SVG composite
│   └── runCli.ts       # in-process runCli(argv, deps) test seam
├── debug/              # browser-safe shared debug helpers
│   ├── overlayBuilders.ts
│   ├── overlaySvg.ts
│   └── analyzeLayoutProjection.ts
└── worker/             # MuPDF worker ops, reused as-is from Node
```

The CLI never imports from `src/services/pdf/index.ts` (the main
barrel). That barrel re-exports `MuPDFWorkerClient`, which would try to
spawn a Web Worker. Imports go directly to `worker/ops.ts` and the
`debug/` helpers.
