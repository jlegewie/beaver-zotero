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
SMOKE=tests/fixtures/pdfs/extract-public/_shared/d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf

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
| `fixture`        | Manage extraction-regression fixtures (see below).     |
| `ocr-fixture`    | Manage OCR-detection regression fixtures (see below).  |

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

### Logging

The CLI writes structured log lines to **stderr** via the package's shared
log sink (analyzer modules + worker doc-cache + WASM bootstrap all route
through it). JSON output on stdout is unaffected.

Control verbosity with the global `--log-level` flag, placed **before** the
subcommand:

```bash
npm run beaver-extract -- --log-level info  info "$PDF"   # full trace
npm run beaver-extract -- --log-level warn  info "$PDF"   # default
npm run beaver-extract -- --log-level silent info "$PDF"  # quiet
```

Levels: `error | warn | info | silent`. Default is `warn`, so analyzer
errors and warnings still surface but the chatty `[pdf:INFO]` doc-cache
and trace lines stay out of pipe-friendly output.

## Fixtures

Regression fixtures for the structured-mode extract pipeline live in two
parallel corpus roots:

- `tests/fixtures/pdfs/extract-public/` — committed, redistributable.
  Required for CI; missing or invalid fixtures fail the smoke tier.
- `tests/fixtures/pdfs/extract/` — gitignored, larger private/local corpus.

The default `--root` for every `fixture` subcommand is the public corpus.
Pass `--root tests/fixtures/pdfs/extract` to target the private one.

### Subcommands

```bash
# Capture a fresh fixture (single page, document-wide analysis context).
# Default --analysis-scope is "document"; pass --analysis-window <n> for
# a finite window. Mutually exclusive with --analysis-scope.
npm run beaver-extract -- fixture capture paper.pdf \
    --pages 14 \
    --id paper__p14

# Read-only diff against the captured `expected` snapshot.
npm run beaver-extract -- fixture evaluate paper__p14

# Rebaseline `expected` (preserves the stored config). Idempotent —
# re-running with no algorithm change writes nothing.
npm run beaver-extract -- fixture update paper__p14

# Replace config (page indices, settings, splitter). Use --update to
# allow overwriting the stored fixture; capture-time flags become the
# new stored config.
npm run beaver-extract -- fixture capture paper.pdf \
    --id paper__p14 --pages 13,14 --update

# List fixture ids under a corpus root.
npm run beaver-extract -- fixture list --json --pretty
```

`capture` refuses scanned PDFs by default: it runs `analyzeOCRNeeds`
first and bails out with a pointer to `ocr-fixture capture` if the PDF
needs OCR. Pass `--allow-ocr` to override — useful for mixed scan/text
PDFs where the text-bearing pages are still worth baselining.

Multi-page fixtures: `--pages 13,14`, naming convention `paperKey__p13-14`
or `paperKey__intro-p0-2`. Reserve them for cases where correctness
depends on neighboring emitted pages (cross-column continuation,
front-matter / body transitions, page-label issues).

The smoke tier runs every fixture in both corpora when present:

```bash
npm run test:cli-smoke
```

## OCR-detection fixtures

`ocr-fixture` is the parallel command group for `analyzeOCRNeeds`
regression fixtures. OCR detection is document-wide, so each fixture
covers a whole PDF — not a page list — and the fixture id is the
paperKey only (no `__pN` suffix). Both extract and OCR fixtures live in
the same corpus roots and share `_shared/<sha>.pdf`; they're
distinguished by file name (`fixture.json` vs `ocr.json`).

```bash
# Capture (default --root is the public corpus).
npm run beaver-extract -- ocr-fixture capture paper.pdf --id paperKey

# Capture a false-positive case with a human-readable note.
npm run beaver-extract -- ocr-fixture capture scan.pdf --id scanKey \
    --notes "false positive — should be false"

# Read-only diff.
npm run beaver-extract -- ocr-fixture evaluate paperKey

# Rebaseline. Preserves notes by default; replace with --notes "..." or
# drop with --clear-notes.
npm run beaver-extract -- ocr-fixture update paperKey

# List OCR fixture ids under a corpus root.
npm run beaver-extract -- ocr-fixture list --json --pretty
```

Fixture file (`ocr.json`) stores both the user's `OCRDetectionOptions`
overrides (stable across default-value drift) and the merged
`effectiveOptions` actually passed to `analyzeOCRNeeds`. A drift in
`DEFAULT_OCR_DETECTION_OPTIONS` will surface as an explicit
`config.effectiveOptions.<knob>` diff, distinguishing it from real
detector behavior changes.

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
│   ├── main.ts                  # 5-line wrapper around runCli
│   ├── envelope.ts              # success/error JSON envelope builders
│   ├── io.ts                    # loadPdf, writePngFile, writeJsonFile, pdfSha256
│   ├── options.ts               # --pages, --page-range, --analysis-window parsers
│   ├── runCliTypes.ts           # CliDeps interface
│   ├── commands/                # one file per command
│   │   ├── _sharedHelpers.ts        # shared envelope plumbing (emitSuccess/emitFailure)
│   │   ├── info.ts                  # `info`
│   │   ├── extract.ts               # `extract`
│   │   ├── overlay.ts               # `overlay`
│   │   ├── analyzeLayout.ts         # `analyze-layout`
│   │   ├── rawDetailed.ts           # `raw-detailed`
│   │   ├── render.ts                # `render`
│   │   ├── fixture.ts               # `fixture {capture,evaluate,update,list}`
│   │   └── ocrFixture.ts            # `ocr-fixture {capture,evaluate,update,list}`
│   └── fixture/                 # extract + OCR fixture file format (Node-only)
│       ├── fixtureFile.ts           # atomic read/write, _shared/ dedup
│       ├── fixtureSchema.ts         # validators with targeted errors
│       ├── fingerprints.ts          # wasm + git + version provenance
│       ├── ocrFixtureFile.ts        # OCR fixture read/write + _shared/ link
│       ├── ocrFixtureSchema.ts      # OCR fixture validators
│       ├── ocrFingerprints.ts       # OCR fingerprints (drops sentencex sha)
│       └── analysisScope.ts         # AnalysisScope <-> internal translation
├── node/               # Node runtime (MuPDF + sentencex bootstrap, sharp overlay)
│   ├── index.ts                 # Node entry barrel
│   ├── bootstrap.ts             # ensureMuPDFNode, ensureSentencexNode, setCliLogLevel
│   ├── paths.ts                 # WASM dir resolution (BEAVER_EXTRACT_WASM_DIR)
│   ├── api.ts                   # typed Node API: extractPdf, renderPages, ...
│   ├── overlayPng.ts            # sharp + SVG composite
│   └── runCli.ts                # in-process runCli(argv, deps) test seam
├── debug/              # browser-safe shared debug helpers
│   ├── overlayBuilders.ts
│   ├── overlaySvg.ts
│   ├── analyzeLayoutProjection.ts
│   ├── extractionSnapshot.ts    # projection + structural diff for extract fixtures
│   └── ocrSnapshot.ts           # projection + diff for OCR fixtures
└── worker/             # MuPDF worker ops, reused as-is from Node
```

The CLI never imports from `src/services/pdf/index.ts` (the main
barrel). That barrel re-exports `MuPDFWorkerClient`, which would try to
spawn a Web Worker. Imports go directly to `worker/ops.ts` and the
`debug/` helpers.
