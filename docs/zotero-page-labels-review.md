# How Zotero Handles PDF Page Labels — and How It Would Fit Into Beaver

Research review for [discussion #361, point 3](https://github.com/jlegewie/beaver-zotero/discussions/361):
_"Zotero attempts to parse extracted text from PDFs and look for page labels in the
margins."_ Beaver deliberately does not do this today. This document reviews the
Zotero implementation in detail, enumerates the cases it handles, and maps out how
the equivalent could fit into Beaver and `beaver-extract`.

---

## 1. Background: what a "page label" is

A PDF's *physical* page index is its 0-based position in the page tree. Its *logical*
page number (a.k.a. **page label**) is what the reader prints in the margin — e.g.
front matter numbered `i, ii, iii …` followed by a body numbered `1, 2, 3 …`, so
physical page 5 shows label `1`. Two sources exist:

1. **Embedded labels** — the optional `/PageLabels` number tree in the PDF catalog.
   Structured (`D`/`R`/`A` style + `P` prefix + `St` start).
2. **Printed-but-not-embedded labels** — the number is only *drawn* in the page
   margin; there is no `/PageLabels` tree. Recovering these requires reading the
   extracted text and guessing.

Point 2 of the discussion (embedded labels) is handled by both tools. Point 3
(margin text parsing) is the gap.

---

## 2. How Zotero does it

Zotero's page-label handling is split across three repos:

| Layer | Repo | Role |
|---|---|---|
| Detection engine (embedded + text heuristic) | `zotero/pdf.js` (fork of Mozilla PDF.js, vendored as the `pdfjs/pdf.js` submodule of the reader) | Reads embedded `/PageLabels`; runs the margin text heuristic |
| Reader UI / mapping | `zotero/reader` | Requests labels, maps page index → label, "Edit Page Number" popup |
| Persistence / citations | `zotero/zotero` | Stores `pageLabel` per annotation in SQLite; uses it as the citation locator |

> Caveat: the detection engine (`getPageLabels2` and the `module` subsystem) is
> **unique to Zotero's PDF.js fork**, not upstream Mozilla PDF.js. Zotero 7 rewrote
> this path, which is why forum threads report label-detection regressions vs Zotero 6.
> Line numbers below are from current `master` (fetched 2026-07-23); function names
> are stable, line numbers drift.

### 2.1 Embedded `/PageLabels` (the official path)

Standard PDF.js catalog reading — `zotero/pdf.js` → `src/core/catalog.js`,
`get rawPageLabels()`, `get pageLabels()`, `#readPageLabels()`. It walks the
`PageLabels` number tree and materialises one string per page honouring the spec:

- `S` = style: `D` decimal, `R`/`r` upper/lower Roman, `A`/`a` alphabetic.
- `P` = prefix prepended to every label in the range.
- `St` = start integer (default 1).

Zotero does **not** call PDF.js's stock `getPageLabels()`. It uses a custom
`getPageLabels2()` that *combines* the embedded labels with the text heuristic
(next section) so it can validate and override bad embedded labels.

### 2.2 The margin text-parsing heuristic

Lives entirely in `zotero/pdf.js` → `src/core/module/page-label.js` (~386 lines).
Plumbing: reader `_initProcessedData()` → `pdfDocument.getPageLabels2()` → worker
`GetPageLabels2` handler (`src/core/worker.js`) → `Module.getPageLabels()`
(`src/core/module/module.js`, memoised in `this._pageLabels`) → the standalone
`getPageLabels(pdfDocument, structuredCharsProvider)`.

**Number parsing**
- `romanToInteger(str)` — validates a *pure* upper- or lower-case Roman numeral
  (rejects mixed case), handles subtractive notation.
- `extractLastInteger(str)` — grabs the trailing digit run (so `"p. 12"` → `12`).
- `parseCandidateNumber(str)` → `{ type: 'arabic' | 'roman', integer }` or `null`.

**Positional word extraction** — `getPageWords(chars, viewportRect)` computes, per
word:
- `relativeX` — horizontal offset relative to the *nearest edge* of the text block
  (so a number in the same margin position clusters across pages).
- `relativeY` — distance into the header (from top) or footer (from bottom) margin.
- `relativeOffset` — reading-order position from whichever end is closer.

**Single-page detection** — `getPageLabel(pdfDocument, provider, pageIndex)`:
- Windows over `[pageIndex−2, pageIndex+2]` (`NEXT_PREV_PAGES = 2`).
- Collects numeric words → `{ pageIndex, type, integer, relativeX, relativeY }`.
- `getClusters(objects, property, eps=5)` — clusters by `relativeY`, then `relativeX`.
  A cluster is kept only if it spans **≥ 3 distinct page indexes**
  (`new Set(cluster.map(x => x.pageIndex)).size >= 3`) — a stray margin number is ignored.
- `getLabelSequence(words)` — finds the longest run where **page-index delta equals
  integer delta** (`b.pageIndex − prev.pageIndex === b.integer − prev.integer`), min
  length 3. This is the core signal: real page numbers increase by exactly 1 per page.
- The winning sequence must also be geometrically tight
  (`getClusterMaxDistance(seq, 'relativeY'|'relativeX') <= eps`).

So detection is **not** "read the number on page N" — it's "find a monotonic
arithmetic sequence of numbers in a consistent margin position across several
consecutive pages, then read page N off that sequence." This rejects years, figure
numbers, and incidental body digits.

**Whole-document build** — `getPageLabels(...)`:
- Runs `getPageLabel` over the first `MAX_PAGES = 25` pages.
- `validateExtractedPageLabels(labels)` — any two same-type detections must have
  matching page/integer deltas, else the whole extracted set is discarded.
- Reads embedded labels (`pdfManager.ensureCatalog("pageLabels")`).
- Reconciles via `predictPageLabels(extracted, catalog, pagesCount)`:

```js
if (catalogPageLabels && catalogPageLabels.length === pagesCount &&
    (numCatalogValidatedPageLabels || !hasArabic || hasRoman)) {
  // (1) Trust embedded /PageLabels for every page
  for (let i = 0; i < pagesCount; i++) pageLabels[i] = catalogPageLabels[i];
} else if (hasArabic) {
  // (2) No usable catalog: extrapolate from ONE detected arabic page
  const first = extractedPageLabels.find(x => x.type === 'arabic');
  const startInteger = first.integer - first.pageIndex;
  for (let i = 0; i < pagesCount; i++)
    pageLabels[i] = (startInteger + i >= 1) ? (startInteger + i).toString() : '-';
} else {
  // (3) Nothing detected: physical 1-based
  for (let i = 0; i < pagesCount; i++) pageLabels[i] = (i + 1).toString();
}
```

Key behaviours:
- **Embedded wins** *only if* it covers the whole doc **and** either it matches the
  printed text (`numCatalogValidatedPageLabels`), or the text has no arabic, or the
  text shows Roman (`!hasArabic || hasRoman`). This guards against PDFs with *wrong*
  embedded labels.
- **Offset extrapolation:** one reliably-detected arabic page fills the whole document
  via `startInteger = integer − pageIndex`. Pages that would compute `< 1` stay `'-'`
  (front matter before arabic numbering).
- **Roman front matter** is detected and validated in sequences but is carried mainly
  through the embedded path; in pure text mode it falls to `'-'` while the arabic body
  is numbered.

### 2.3 Storage, mapping, override

- **Caching:** memoised worker-side (`Module._pageLabels`) and reader-side
  (`pdf-view.js _pageLabels`, mirrored to React `state.pageLabels`).
- **Index → label at annotation time:** `pdf-view.js _getPageLabel(pageIndex, usePrevAnnotation)`
  — `this._pageLabels[pageIndex] || (pageIndex+1)`. With `usePrevAnnotation=true`
  (used everywhere annotations are created), it derives the label as a *consistent
  offset* from the user's most recent corrected annotation instead of the raw
  auto-detected value.
- **Persistence:** `itemAnnotations.pageLabel TEXT` in `userdata.sql`; bridged as
  `annotationPageLabel` in `annotations.js`/`item.js`; used as the citation `locator`
  in `editorInstance.js`. **Labels are stored per annotation, not as a document-wide
  map.**
- **"Edit Page Number" override:** context-menu `reader-edit-page-number` →
  `_handleOpenPageLabelPopup` → `label-popup.js`. Numeric labels cascade by offset
  across a chosen scope (`single`/`selected`/`page`/`from`/`all`); non-numeric labels
  are restricted to single/page scope (no arithmetic cascade); an "Auto-detect"
  checkbox resets back to engine labels.

### 2.4 The cases, end-to-end

| Case | Zotero behaviour |
|---|---|
| Embedded labels present, cover all pages, consistent | Read per spec; `predictPageLabels` branch 1 uses verbatim; text only validates. |
| No embedded, printed numbers in margins | Heuristic finds an arithmetic sequence over ≥3 pages; branch 2 extrapolates `startInteger = integer − pageIndex` across the doc; gaps → `'-'`. |
| Neither | Branch 3 → physical 1-based; reader guards with `|| (pageIndex+1)`. |
| Roman front matter | Roman recognised/validated; carried mainly via embedded path or `!hasArabic || hasRoman` bias; else `'-'` in text mode. |
| User override | "Edit Page Number" writes explicit per-annotation `pageLabel`; numeric cascades by offset; later annotations inherit the offset. |

---

## 3. How Beaver handles page labels today

### 3.1 Embedded labels only

`beaver-extract` reads embedded labels via MuPDF `page.getLabel()`:

- `src/beaver-extract/worker/docHelpers.ts` → `collectPageLabels(doc)` /
  `collectPagesData(doc)` — loop pages, `page.getLabel()`, keep non-empty into a
  `Record<pageIndex, label>`. MuPDF returns a label only when a `/PageLabels` entry
  exists, so a standard PDF yields `{}`.
- Assembled in `src/services/documentExtractionCore.ts` →
  `buildExtractedDocumentCacheMetadata`, stored on the document cache as
  `DocumentCachePageLabels = Record<string, string>` (`src/services/documentExtraction/shared/contentKinds.ts`).
- Cache semantics (`pageLabelResolution.ts`): `pageLabels === null` = "not yet
  checked"; `{}` = "checked, no embedded labels."

There is **no margin text parsing to recover labels** — this is exactly point 3.

### 3.2 Where labels are consumed

- **Display:** `react/utils/pageLabels.ts` (`resolvePageLabelFromLabels`,
  `translatePageNumberToLabelFromLabels`, and the `preload*` functions),
  `src/utils/pageLabelTranslation.ts` (forward + reverse translation),
  `react/utils/locationDisplay.ts` (`explicitPageLabel`, `formatLocationChip`).
  Any non-empty map is treated as authoritative; otherwise the raw physical number is shown.
- **Agent page requests:** `src/services/agentDataProvider/pageLabelResolution.ts` —
  when a handler sets `prefer_page_labels=true`, `resolvePageValue` interprets the
  agent's page numbers as *labels* and maps them back to physical indices (label
  lookup first, numeric fallback). `ensurePageLabelsForResolution` lazily loads labels
  via a metadata-only `BeaverExtractor.getMetadata` (opens PDF, reads catalog, closes —
  **no text extraction**).
- **Annotations:** `src/services/annotations/createAnnotation.ts` and
  `react/utils/annotationUtils.ts` set `annotationPageLabel` from a supplied
  `pageLabel`, falling back to `String(pageIndex + 1)`. When Beaver creates
  annotations *through the live reader*, `annotationUtils` pulls `pageLabel` off
  `reader._internalReader._annotationManager` — i.e. it already inherits **Zotero's own
  detected/overridden labels** in that path. The gap is the background/extraction path,
  which has no reader.

### 3.3 The important find: Beaver already has the detector — for a different purpose

`src/beaver-extract/MarginFilter.ts` already contains a mature page-number-in-margin
parser, currently used to **remove** running headers/footers from body text (not to
emit labels):

- `parsePageNumber(text)` — arabic, prefix forms (`"page 3"`, `"p. 3"`, multilingual
  `PAGE_WORDS`/`PAGE_ABBREVS`), ranges (`"3 of 13"`, `"3/13"`), CJK wrapped/suffix
  (`第3页`, `3ページ`), middot-wrapped (`·42·`).
- `parseRoman(text)` / `isBareRoman(text)` — bounded Roman numerals (`ROMAN_MAX = 50`),
  used to split a Roman preface from an arabic body.
- `normalizeDigits(text)` — folds full-width / Arabic-Indic / Devanagari / etc. digits.
- `isIncreasingSequence(numbers)` — strict monotonic check across pages.
- Margin-zone detection (`getMarginPosition`, `isEntirelyInMarginZone`) plus
  `StyleAnalyzer`, and cross-page bucketing in `identifyElementsToRemove`
  (`templateKey`, distinct-page guard, per-numeral-system sequence check).
- `MarginElement` (`src/beaver-extract/types.ts`) already carries `{ text, position,
  bbox, pageIndex, line }` — so detected numbers are already tied to their page.

This is substantially the same machinery Zotero uses. The difference is direction:
Zotero **emits** the detected numbers as labels; Beaver **discards** them as noise.

The pipeline entry point is
`src/beaver-extract/FilteredParagraphPipeline.ts` → `MarginFilter.filterPageWithSmartRemoval`,
with the cross-page analysis set resolved by `AnalysisWindow.ts` (`resolveAnalysisPages`,
the `analysisWindow` knob — analogous to Zotero's `MAX_PAGES`/`NEXT_PREV_PAGES`).

### 3.4 Detection primitives side by side

| Concern | Zotero `page-label.js` | Beaver `MarginFilter.ts` |
|---|---|---|
| Arabic parse | `extractLastInteger` | `parsePageNumber` (`/^\d+$/`, prefixes, ranges, CJK, middot) |
| Roman parse | `romanToInteger` | `parseRoman` / `isBareRoman` (bounded to 50) |
| Digit normalisation | (basic) | `normalizeDigits` (multi-script) |
| Positional clustering | `getPageWords` relativeX/relativeY + `getClusters` eps=5 | margin-zone position + `StyleAnalyzer` + `templateKey` buckets |
| Cross-page evidence | ≥3 distinct pages | distinct-page guard |
| Sequence test | `getLabelSequence`: **pageΔ == integerΔ** | `isIncreasingSequence`: strictly increasing (weaker) |
| Extrapolate whole doc | `predictPageLabels`: `startInteger = integer − pageIndex` | **none** (removal only) |
| Reconcile with embedded | `predictPageLabels` catalog branch + validation | **none** |
| Scan budget | `MAX_PAGES = 25`, window ±2 | `analysisWindow` |

Beaver's detection is actually *richer* on parsing/normalisation; it lacks the two
label-specific pieces: the stricter `pageΔ == integerΔ` sequence test and the
`predictPageLabels` extrapolation/reconciliation.

---

## 4. How margin-based labels would fit into Beaver

### 4.1 Shape of the change

Add a **label-detection + reconciliation** step to `beaver-extract` that reuses the
existing `MarginFilter` parsers and emits a full-document label map, then merge it with
the embedded-label map.

1. **`PageLabelDetector` (new module in `beaver-extract`).** Reuse
   `parsePageNumber` / `parseRoman` / `normalizeDigits` and the `MarginElement`
   stream. Per candidate word record `{ pageIndex, type: 'arabic'|'roman', integer,
   position, offset }`. Cluster by margin position, require ≥3 distinct pages, then
   run the **Zotero sequence test** (`pageΔ == integerΔ`, min length 3) rather than the
   looser `isIncreasingSequence` — this is the one algorithmic addition needed.
   Budget the scan to ~25 pages to match Zotero and cap cost.
2. **`predictPageLabels` port.** Given `{ detected, embedded (collectPageLabels),
   pageCount }`, reproduce the three-branch reconciliation:
   embedded-covers-all-and-validates → embedded; else arabic detected → extrapolate
   `startInteger = integer − pageIndex`; else physical.
3. **Merge point.** `buildExtractedDocumentCacheMetadata`
   (`documentExtractionCore.ts`) is the natural place to combine detected labels with
   `doc.pageLabels`, since the full extraction already has per-page text/geometry there.
   Doing it in the worker (`collectPagesData` / `ops.ts`) alongside geometry is the
   alternative if we want it available without the React layer.

### 4.2 The hard part: provenance and cache semantics

This is where a naive port breaks Beaver's current contracts. Today the label map is
sparse and means "embedded labels that differ from physical." Zotero-style detection
produces a **dense** map that includes physical numbers for undetected pages. That
collides with existing assumptions:

- `hasPageLabels()` (display) and `ensurePageLabelsForResolution` treat **any**
  non-empty map as authoritative embedded labels. A dense synthetic map would make
  every PDF look "labelled," and `resolvePageValue`'s numeric fallback would rarely
  fire.
- `translatePageLabelToNumber` (reverse lookup) builds a first-wins reverse map;
  duplicate/placeholder labels (`'-'`, or physical numbers reused as labels) would
  create ambiguous or lossy round-trips.
- Citation display would start substituting heuristic labels silently, and margin
  detection is **fuzzy** — Zotero itself regressed here. Wrong labels in a citation
  locator are worse than raw page numbers.

Recommended mitigations:
- **Add a provenance field** to the cache metadata, e.g.
  `pageLabelsSource: 'embedded' | 'detected' | 'none'` (or store `detectedPageLabels`
  separately from the embedded `pageLabels`). Keep the existing `pageLabels` field
  meaning "embedded/authoritative" so current consumers are unaffected by default.
- **Gate consumption** behind a pref (mirroring the discussion's "for various reasons"
  caution). Display/citation/agent-resolution opt in explicitly; when using detected
  labels, consider surfacing them as lower-confidence (e.g. a tooltip, or not feeding
  them into `prefer_page_labels` resolution unless enabled).
- **Store `'-'` gaps as "unknown," not as a label** — never let a placeholder become a
  citation locator.

### 4.3 Cost / where it runs

- Detection needs extracted **text over a page sample**, so it must ride the full
  extraction pipeline (`documentExtractionCore` / worker ops), **not** the cheap
  catalog-only `getMetadata` path that `ensurePageLabelsForResolution` uses today. That
  path stays embedded-only; detected labels come from the already-cached full
  extraction. Result is cached in the document cache like the rest of the metadata.
- Reuse `resolveAnalysisPages` / the `analysisWindow` knob to bound the page sample.

### 4.4 What already works and needs nothing

- **Annotations created through the live reader** already inherit Zotero's
  detected/overridden `pageLabel` (via `_internalReader._annotationManager` in
  `annotationUtils.ts`). Point 4 of the discussion (user-edited labels) is therefore
  *already* honoured in that path — but only for annotation-driven flows, and Zotero
  stores those overrides **per annotation**, not as a document map, so they can't be
  read back to label an arbitrary non-annotated page for a citation.
- The **display, agent-resolution, and reverse-translation plumbing** is all in place
  and label-shape-agnostic; feeding it a detected map is a matter of populating the
  cache, plus the provenance guard above.

---

## 5. Recommendation

The engineering cost is moderate and lower than it looks, because Beaver already owns
~80% of the detector in `MarginFilter.ts`. The net-new work is:

1. A stricter `pageΔ == integerΔ` sequence finder (small).
2. A `predictPageLabels`-style reconciler that merges detected + embedded labels (small).
3. A wiring pass through `buildExtractedDocumentCacheMetadata` / worker ops (small).
4. **Provenance + opt-in gating so heuristic labels never silently replace physical
   numbers in citations** (the real design work).

Given that margin detection is inherently fuzzy (Zotero itself regressed on it), the
safe path is: implement detection behind a provenance flag, keep `pageLabels`
meaning "embedded/authoritative," expose detected labels as a separate, opt-in,
clearly-lower-confidence source. That directly resolves the #361 discrepancy for users
whose PDFs rely on Zotero's parsing, without importing Zotero's fragility into Beaver's
citation locators by default.
