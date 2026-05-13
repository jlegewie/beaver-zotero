# BeaverExtract — public fixture corpus

Small, redistributable PDFs and their captured `ExtractionSnapshot` outputs.
This corpus runs in CI; missing or invalid fixtures here fail the smoke tier.
The companion private corpus lives in the separate `beaver-extract-fixtures`
repo and is loaded via `$BEAVER_EXTRACT_FIXTURES_DIR` (the CLI and smoke
tier fall back to the legacy in-tree `tests/fixtures/pdfs/extract/` when
the env var is unset).

Every PDF and its captured text snapshot in this directory must be
redistributable. Snapshots embed extracted text from the PDF, so the text
itself is also subject to the license requirement.

## PDFs

`_shared/<sha256>.pdf` is the dedup-keyed PDF storage. Every fixture
references one of these by `pdfSha256`.

| File (sha256 prefix) | Source | License |
|----------------------|--------|---------|
| `d86a26bf17a0e191…`  | Single-page excerpt (page 231) from Legewie, Joscha and Jeffrey Fagan. "Aggressive Policing and the Educational Performance of Minority Youth." *American Sociological Review*, 84(2): 220–247. | Self-authored by repository owner; committed with author's permission. |

Add new committed PDFs only when their license clearly permits redistribution
(CC0, public domain, author-owned). Anything else goes in the gitignored
private corpus.

## Working with the corpus

Capture, evaluate, and rebaseline are CLI subcommands of `beaver-extract`:

```bash
# capture (single-page, document-wide analysis context)
npm run beaver-extract -- fixture capture <pdf> --pages 0 --id <id>

# read-only check
npm run beaver-extract -- fixture evaluate <id>

# rebaseline expected (idempotent — preserves config and capturedAt)
npm run beaver-extract -- fixture update <id>
```

The smoke tier (`npm run test:cli-smoke`) runs every fixture in this corpus
plus any present in the private corpus.

## OCR-detection fixtures

The same corpus also hosts OCR-detection regression fixtures
(`ocr.json`), managed by `beaver-extract ocr-fixture …`. OCR fixtures
are keyed by paperKey alone (no `__pN` suffix) because the detector is
document-wide, and they share `_shared/<sha>.pdf` with extract fixtures.
See `src/services/pdf/cli/README.md` for the command surface.
