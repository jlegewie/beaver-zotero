# PDF Table Extraction — Porting pdf-inspector's Table Detection to BeaverExtract

Status: proposal / scoping document. Nothing here is implemented yet.

## 1. The problem

BeaverExtract has no table detection. `TableItem` exists in the extraction schema
(`packages/agent-core/src/extract/schema.ts`) but carries only a bbox — no cells, no
text — and nothing in the PDF pipeline ever emits one. `canonicalProjection.ts` maps
the kind through, but no upstream stage produces it. Table text therefore flows
through `ParagraphDetector` as ordinary prose.

The result on a two-column regression table (one bordered, one borderless, generated
from HTML and printed to PDF):

```
Table 1. Bordered results table
Variable Model 1 Model 2 Model 3
Police stops -0.041 -0.038 -0.052 Age 0.012 0.014 0.011   <- two rows merged
Free lunch -0.220 -0.198 -0.205
285,439 285,439 212,004                                    <- "N" row label lost

Table 2. Borderless results table
-0.041 Police stops                                        <- column order inverted
(0.011)
```

For an agent reading a research paper this is worse than useless: the numbers survive
but their row/column identity does not, so anything the model says about the table is
guesswork. Regression tables, descriptive-statistics tables, and appendix tables are
exactly the content researchers ask about.

The same PDF through [pdf-inspector](https://github.com/firecrawl/pdf-inspector):

```
|Variable|Model 1|Model 2|Model 3|
|---|---|---|---|
|Police stops|-0.041 (0.011)|-0.038 (0.010)|-0.052 (0.014)|
|Age|0.012 (0.003)|0.014 (0.004)|0.011 (0.003)|
```

Both tables recovered, including the two-line `estimate / (standard error)` cells.

## 2. Why port rather than bundle

pdf-inspector is a Rust crate (MIT) that also ships a browser WASM build. We evaluated
bundling it and decided against it for this purpose:

- It parses the PDF itself (via `lopdf`), so every document would be parsed twice —
  once by MuPDF for our pipeline, once by pdf-inspector for tables. Two parsers means
  two coordinate spaces, two font-decoding paths, and two sets of failure modes to
  reconcile per page.
- The WASM build is 4.3–4.8 MB (1.4–2.3 MB gzipped), on top of the 9.5 MB MuPDF blob
  we already ship.
- Its cell geometry would arrive in *its* coordinate frame, and our citation/highlight
  machinery needs bboxes in ours.

Porting the detection layer instead keeps one parser, one coordinate space, and lets
tables become first-class `DocumentItem`s that participate in sentence mapping,
citations, and the reader overlay like every other item kind.

The important asymmetry: **we already have the hard inputs.** The expensive plumbing
that table detection depends on — running a device over the page content stream and
collecting vector primitives — exists in `src/beaver-extract/worker/`. What's missing
is the geometry layer that turns those primitives into grids.

## 3. What already exists on our side

| Input the algorithms need | Where we have it |
|---|---|
| Text items with position, font, size | `RawPageData` / `RawLine` from `worker/docHelpers.ts` |
| Filled rectangles (cell backgrounds, `re` ops) | `collectFilledRects` → `filterToContainerRects` in `worker/docHelpers.ts` |
| Stroked rules (gridlines, `m`/`l`/`S` ops) | `filterToDividerLines` in `worker/docHelpers.ts` |
| Column / band segmentation | `ColumnDetector.ts` |
| Per-page orchestration seam | `FilteredParagraphPipeline.ts`, `PageExtractor.ts` |

Two known adjustments in that list:

- `filterToDividerLines` currently requires a rule to span ≥50% of the page width
  (`MIN_SPAN_RATIO`). Table rules live inside a column and are routinely much shorter,
  so they are all being discarded today. Table detection needs a second, looser view of
  the same strokes.
- `filterToContainerRects` drops fills under 900 pt² and near-white fills, tuned for
  "is this an aside box". Cell-background rects are often smaller and often white-ish.
  Same story: the collection is right, the filter is tuned for a different consumer.

We do not read the PDF structure tree at all today (no `StructTreeRoot` usage anywhere
in the codebase). That is relevant below.

## 4. What the port covers

Only `src/tables/` in pdf-inspector, plus the orchestration that drives it. Roughly
10k lines of algorithm code and ~7k lines of inline unit tests:

| Module | ~LOC (code) | Role |
|---|---|---|
| `detect_rects.rs` | 3.0k | Table detection from filled rectangles; union-find clustering of cell rects; also produces "hint regions" that later detectors reuse |
| `detect_heuristic.rs` | 2.0k | Detection from text alignment alone — no vector graphics. Gap-histogram column boundaries with bimodal detection, switching between center- and edge-based clustering |
| `detect_lines.rs` | 1.6k | Detection from stroked gridlines; merges per-cell segments into logical rules, snaps edges, anchors rows to text |
| `mod.rs` | 1.5k | Shared `Table` type, rect-guided construction, TOC detection |
| `grid.rs` | 0.5k | Column/row boundary finding and cell assignment, shared by the detectors |
| `format.rs` | 0.5k | Grid → Markdown, header-row recovery, continuation-row merging across page breaks |
| `detect_struct.rs` | 0.6k | Tables from the tagged-PDF structure tree |
| `structured.rs` | 0.5k | Cell model carrying per-cell page-point bboxes |
| `financial.rs` | 0.1k | Splitting merged numeric items (`-0.041 (0.011)` arriving as one item) |

Also worth reading, though it is not part of `src/tables/`: the orchestration in
`src/markdown/mod.rs` around lines 1200–1650. That is where the detectors are actually
sequenced, and it is the part most directly analogous to what we need to write.

## 5. The shape of the algorithm

Four ideas carry most of the value. A developer should understand these before writing
any code; the rest is tuning.

**Per-band, not per-page.** Detection runs inside vertical bands (side-by-side column
regions), not across the whole page. Two-column papers otherwise produce phantom
columns from the facing column's text. We have band segmentation already
(`ColumnDetector`), so this maps onto an existing concept.

**A cascade with claims, not a single detector.** Four strategies run in priority order
per band, each skipping items already claimed by a higher-priority one:

1. structure tree (semantic, when the PDF is tagged — accepted only if it covers ≥50%
   of the band's items, since partial tagging is common and worse than geometry)
2. filled rectangles
3. stroked gridlines (only attempted when rects found nothing)
4. text-alignment heuristics (the fallback that handles borderless academic tables)

Each detected table records `item_indices` — the text items it consumed. Those items
are then excluded from the prose flow. This claim mechanism is the integration
contract: it is how a table stops being paragraph text, and it is what we would wire
into `FilteredParagraphPipeline` so `ParagraphDetector` never sees table items.

**Merge glyph-level items before doing geometry.** PDFs commonly emit one text item per
glyph. Column detection over raw glyph positions is meaningless. `merge_adjacent_items`
(in `detect_heuristic.rs`) coalesces items within a line by Y proximity, X adjacency,
and font size first. Our MuPDF path already gives us line- and span-level grouping, so
this may need less work on our side — worth checking early, since it changes how much
of `grid.rs` transfers directly.

**Column boundaries come from a gap histogram, not average spacing.** `find_column_boundaries`
in `grid.rs` analyzes the distribution of consecutive X gaps to detect a bimodal pattern
(small within-column gaps vs. large between-column gaps), and only then picks a
clustering threshold and strategy. Averaging over-clusters on dense tables and
over-splits on wide ones. This is the single function most responsible for the
borderless-table result above.

Beyond those: `format.rs` handles header-row recovery and merging continuation rows
across page breaks (long appendix tables), and there are guardrails worth keeping —
a 25-column ceiling, skipping merged-cell propagation above 10 columns (wide spanning
rects are usually background fills), and TOC detection so dot-leader contents pages
aren't rendered as tables. We have separate TOC handling in `DocumentAnalyzer` already;
the two should agree.

## 6. Where it lands in our pipeline

Roughly:

- **Worker** (`worker/docHelpers.ts`): expose the rects and strokes we already collect
  under filters appropriate for table detection, alongside the existing consumer-specific
  filters. No new MuPDF work.
- **New module(s)** under `src/beaver-extract/`, in the style of the existing detectors
  (`ColumnDetector`, `LineDetector`, `ParagraphDetector`): pure functions over
  `RawPageData` + rects + lines, no worker or WASM dependency, unit-testable in vitest.
- **`FilteredParagraphPipeline.ts`**: run table detection after column detection and
  before paragraph grouping; remove claimed items from what reaches `ParagraphDetector`.
- **Schema** (`packages/agent-core/src/extract/schema.ts`): `TableItem` grows real
  content — a cell grid with per-cell bboxes and a header-row count, plus a Markdown
  rendering for the markdown engine. This is a schema version bump and needs a decision
  about how table cells interact with sentence mapping and citation anchors (a table
  cell is not a sentence; the citation grammar already has a `table` prefix, so the
  question is what a citation to a table resolves to in the reader).
- **Markdown engines** (`worker/ops.ts` → `toMarkdownExtractResult`): emit pipe tables
  at the table's position in reading order instead of the current prose spill.

The schema and citation question is the one piece of genuinely new design — everything
else is a port. It should be settled before the porting work starts, because it
determines whether cell bboxes need to survive the pipeline (they do if tables are ever
clickable in the reader) and therefore how much of `structured.rs` matters.

## 7. Suggested sequencing

The cascade is designed so each stage is independently useful. That makes it natural to
land incrementally rather than as one large change:

1. **Schema + plumbing + one detector.** Decide the `TableItem` shape, wire the claim
   mechanism into `FilteredParagraphPipeline`, and port the heuristic (text-alignment)
   detector. It needs no vector-graphics input, so it can land before any worker
   changes, and it covers borderless academic tables — probably the most common case in
   a Zotero library.
2. **Rect- and line-based detection.** Requires the worker filter changes. Covers
   bordered tables, forms, and government/agency PDFs.
3. **Structure tree.** Independent of the rest and a free accuracy win on tagged PDFs;
   requires new MuPDF work to read `StructTreeRoot`, which we don't do today. Reasonable
   to defer or drop.
4. **Formatting refinements.** Continuation-row merging, header recovery, financial item
   splitting. Each is small and independently testable.

## 8. Validation

The port should be judged on output, not on line-by-line fidelity to the Rust.

- pdf-inspector's inline unit tests are synthetic-data table tests. They translate
  almost mechanically to vitest and are the cheapest correctness signal available —
  port them alongside the code rather than after.
- Our fixture infrastructure (`src/beaver-extract/cli/fixture/`, `npm run beaver-extract
  -- fixture`) already snapshots page-level extraction. Table-bearing PDFs should be
  added to it so regressions in *prose* extraction from the claim mechanism are caught
  too — removing items from the paragraph flow is the most likely way this work breaks
  something that currently works.
- Worth assembling a small corpus of the table styles that actually matter here:
  regression tables with multi-line cells, descriptive statistics with spanning headers,
  appendix tables that break across pages, and at least one borderless table in a
  two-column layout.
- pdf-inspector reports TEDS 0.814 on the opendataloader-bench corpus. We are unlikely
  to reproduce that exactly through a port onto a different text-extraction front end,
  but it is the right order of magnitude to aim at, and the benchmark is public if a
  numeric target is wanted.

## 9. Scope and risks

- **Size.** ~10k lines of Rust, of which the three geometry detectors are ~6.5k. This is
  a multi-week piece of work, not a spike. The heuristic detector alone (step 1 above)
  is a much smaller commitment and delivers most of the visible improvement.
- **Different front end.** The algorithms were tuned against pdf-inspector's own text
  extraction (`lopdf` + its own content-stream state machine). Our items come from MuPDF
  with different grouping and different coordinate conventions (MuPDF is top-left
  origin; PDF/Zotero is bottom-left — see the coordinate section in
  `src/beaver-extract/README.md`). Thresholds tuned in points will mostly transfer;
  assumptions about item granularity may not. Expect retuning, and expect it to be the
  bulk of the debugging time.
- **Licensing/attribution.** pdf-inspector is MIT. A derived TS port must carry the MIT
  notice; the ported files should say what they are derived from, both for compliance
  and so the next person can diff against upstream when it changes.
- **Upstream drift.** The crate is at 0.1.x and actively developed. A port is a
  snapshot; we would not get their improvements for free. That is a real cost, and it is
  the main argument on the other side of the bundle-vs-port decision.
