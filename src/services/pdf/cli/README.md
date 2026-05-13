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

# Per-phase timing breakdown for structured extract (1 cold + 2 warm runs)
npm run beaver-extract -- profile "$SMOKE" --pages 0,1 --repeat 3
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
| `profile`        | Structured extract with per-phase timing breakdown.    |
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

## Profiling structured extract

`profile` runs the same pipeline as `extract --mode structured` and
surfaces CLI wall time plus the per-phase timing breakdown the worker
records on `result.metadata.timings`. Use it to identify bottlenecks,
prioritize optimization work, and verify that a refactor didn't regress.

```bash
# Cold run + 2 warm runs over pages 0 and 1
npm run beaver-extract -- profile "$PDF" --pages 0,1 --repeat 3

# Whole document; JSON for diffing
npm run beaver-extract -- profile "$PDF" --repeat 3 --json --pretty > before.json
# ... change code ...
npm run beaver-extract -- profile "$PDF" --repeat 3 --json --pretty > after.json
```

Flags:

| Flag | Purpose |
| ---- | ------- |
| `--pages <list>` / `--page-range <s>:<e>` | Narrow the target pages. Same parsers as `extract`. |
| `--analysis-window <n>` | Forwarded to the analysis-context prefix. |
| `--repeat <N>` | Re-run the same extract N times. Run 1 is reported as **cold**; runs 2..N are averaged as **warm-cache**. The doc cache and the splitter are warm after the first run, so warm averages reflect the steady-state hot path. |
| `--language <lang>` | Splitter language code (forwarded to `sentencex`). |
| `--settings <path>` / `--paragraph-settings <path>` | JSON-file overrides. |
| `--json` / `--pretty` | Emit a machine-readable envelope instead of the human report. |

Human report shape (cold + warm sections, abbreviated):

```
beaver-extract profile — <pdf>
runs: 3 (1 cold, 2 warm)

cold run (1st execution):
  totalMs=305ms  worker=114ms  runtimeOverhead=191ms  docOpen=8ms  walk=35ms  analysis=4ms
  pages=10  chars=26581
  phase                  total     /page   share  per1kchars
  detailedWalk             35.96ms    3.60ms   56.6%    1.35ms/1k
  fontBridge                0.52ms    0.05ms    0.8%    0.02ms/1k
  filteredParagraphs       13.82ms    1.38ms   21.7%    0.52ms/1k
    marginFilter            0.19ms    0.02ms     -      0.01ms/1k
    columnDetect            4.03ms    0.40ms     -      0.15ms/1k
    lineDetect              1.47ms    0.15ms     -      0.06ms/1k
    paragraphDetect         7.56ms    0.76ms     -      0.28ms/1k
  sentenceMap              13.22ms    1.32ms   20.8%    0.50ms/1k

warm-cache avg (2 runs):
  ...
```

Columns:

- **total** — sum across all profiled target pages.
- **/page** — `total / pages`, comparable across documents of similar layout.
- **share** — share of the structured-loop budget (`detailedWalk +
  fontBridge + filteredParagraphs + sentenceMap`). The nested
  sub-phases of `filteredParagraphs` show `-` because including them
  would double-count their parent.
- **per1kchars** — `total / charCount × 1000`. The only column that
  normalizes for document size, so use it for cross-document
  comparisons.

`totalMs` is measured around the full CLI-side `extractPdf` call, so the
cold run includes runtime initialization such as MuPDF and sentence
splitter loading. `worker`, `docOpen`, `walk` (JSON walk over analysis
pages), and `analysis` (`buildPageAnalysisContext` — StyleAnalyzer +
cross-page MarginFilter) come from worker timings and are reported in
the top-level line because they are paid once across all target pages.

JSON envelope shape (`--json`):

```json
{
  "ok": true,
  "result": {
    "runs": [
      {
        "runIndex": 0,
        "cold": true,
        "cliWallMs": ...,
        "timings": { "totalMs": ..., "perPagePhases": [{ "pageIndex": 0, "detailedWalkMs": ..., ... }] },
        "pageCount": 10
      }
    ],
    "aggregated": { "scope": "warm-avg", "phases": [...], "topLevel": {...} }
  }
}
```

The raw `perPagePhases[]` entries on each run carry `charCount`,
`lineCount`, `paragraphCount`, and `degradationCount` alongside the
ms fields so you can chart timing vs. page complexity offline.

### Stable methodology for tracking improvements

- Always use the **warm** average for steady-state numbers — the cold
  run is dominated by WASM initialization and the first doc-cache miss.
- Use `--repeat 3` minimum; bigger N reduces variance but the cache is
  already warm after run 2.
- Pin the corpus: capture a baseline JSON for the same set of PDFs
  before and after a change, then diff the `aggregated.phases` block.
- The dominant phases are usually **`detailedWalk`** and
  **`filteredParagraphs.{column,line,paragraph}Detect`** — the first
  is WASM/MuPDF cost, the second is JS cost on the target page.
  `fontBridge` is typically <1% and should not be optimized
  speculatively.

## Configuration

| Env var                           | Default                              | Purpose                                                                                                                  |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `BEAVER_EXTRACT_WASM_DIR`         | `<repo>/addon/content/lib`           | Override WASM file directory.                                                                                            |
| `BEAVER_EXTRACT_FIXTURES_DIR`     | `tests/fixtures/pdfs/extract` (legacy) | Absolute path to the private fixtures checkout (`beaver-extract-fixtures`). When set, `fixture`/`ocr-fixture` default `--root` to it, and the smoke tier + bench script load fixtures from there. |

Both the CLI (`src/services/pdf/cli/main.ts`) and the smoke vitest config
preload `.env` via `dotenv/config`, so setting `BEAVER_EXTRACT_FIXTURES_DIR`
(or `BEAVER_EXTRACT_WASM_DIR`) in the repo's `.env` is enough — no shell
export needed. The in-process CLI test seam (`runCli`) skips this so tests
drive env explicitly.

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

- `tests/fixtures/pdfs/extract-public/` (inside `beaver-zotero`) — committed,
  redistributable. Required for CI; missing or invalid fixtures fail the
  smoke tier.
- The private corpus, hosted in the separate `beaver-extract-fixtures`
  repo. Point at your local checkout by exporting
  `BEAVER_EXTRACT_FIXTURES_DIR=/absolute/path/to/beaver-extract-fixtures`.
  When unset, the CLI falls back to the legacy in-tree path
  `tests/fixtures/pdfs/extract/`.

`--root` resolution per command invocation:

- Explicit `--root <dir>` always wins.
- When `BEAVER_EXTRACT_FIXTURES_DIR` is set, the default `--root` is the
  private corpus — so `fixture capture`/`update` writes there with no
  extra flags. Pass `--root tests/fixtures/pdfs/extract-public` to target
  the public corpus.
- When the env var is unset, the default `--root` is the public corpus
  for safety.

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
# Capture (default --root follows $BEAVER_EXTRACT_FIXTURES_DIR if set,
# otherwise falls back to the public corpus).
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
