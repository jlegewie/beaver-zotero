# PDF Extraction Service - Technical Documentation

## Overview

This service provides high-quality text extraction from PDFs using **MuPDF WASM** (compiled to JavaScript). It implements a sophisticated multi-stage pipeline that understands document structure, typography, and layout to produce clean, structured text suitable for indexing, RAG, and semantic search.

**Key Capabilities:**

- Multi-column layout detection with correct reading order
- Line-level text extraction with positional metadata
- Smart header/footer removal via frequency analysis
- Style-based content classification (headings, body text, etc.)
- OCR detection (identifies scanned PDFs that need OCR)
- Encrypted PDF detection
- Coordinate-accurate bounding boxes for highlighting
- **Page-to-image rendering** with configurable DPI/scale and format (PNG/JPEG)
- **Full-text search** with relevance scoring based on text role (heading, body, footnote)

---

## Architecture

### Pipeline Overview

The extraction follows a **3-phase pipeline**:

```
Phase 1: Raw Extraction
    ↓
Phase 2: Document Analysis (styles, margins, layout)
    ↓
Phase 3: Page Processing (filtering, line detection, extraction)
```

#### Phase 1: Raw Extraction

- **Module**: `worker/docHelpers.ts` (called via `MuPDFWorkerClient`)
- **Purpose**: Single-pass extraction of all structured text from MuPDF
- **Output**: `RawDocumentData` with raw blocks, lines, spans, and bboxes
- **Why**: All MuPDF/WASM work runs in a worker so the UI thread stays free; analysis modules work from this cached data without re-entering the worker

#### Phase 2: Document Analysis

- **Modules**: `DocumentAnalyzer.ts`, `StyleAnalyzer.ts`, `MarginFilter.ts`
- **Purpose**: Build document-level understanding
- **Outputs**:
  - `StyleProfile`: Identifies body text vs. headings by character frequency
  - `MarginAnalysis`: Detects repeating headers/footers/page numbers
  - Document metadata: page count, text layer status

#### Phase 3: Page Processing

- **Modules**: `ColumnDetector.ts`, `LineDetector.ts`, `ParagraphDetector.ts`, `PageExtractor.ts`
- **Purpose**: Transform raw data into clean, structured content
- **Process**:
  1. Apply margin filtering (both simple thresholds and smart removal)
  2. Detect columns and determine reading order
  3. Detect lines within each column
  4. Group lines into paragraphs/items
  5. Extract final text in reading order

---

## File Organization

```
src/services/pdf/
├── index.ts                       # Main API entry point (PDFExtractor facade + barrel re-exports)
├── types.ts                       # Shared TypeScript interfaces
├── config.ts                      # Cross-bundle config (worker URLs, log sink, client slot)
├── MuPDFWorkerClient.ts           # Main-thread worker proxy (postMessage RPC)
├── prewarm.ts                     # Eager worker spawn helper
├── worker/
│   ├── index.ts                   # Worker entry point + dispatcher
│   ├── ops.ts                     # Worker-side op handlers
│   ├── opQueue.ts                 # Per-worker op serialization queue
│   ├── config.ts                  # Worker-side URL/config storage
│   ├── docCache.ts                # Short-lived in-worker doc cache (acquireDoc/releaseDoc)
│   ├── docHelpers.ts              # MuPDF/WASM bridge (worker-only)
│   ├── mupdfApi.ts                # MuPDF API wrappers
│   ├── wasmInit.ts                # MuPDF WASM bootstrap
│   ├── wasmHelpers.ts             # WASM utility helpers
│   ├── workerScope.ts             # Worker globalThis typing
│   ├── errors.ts                  # Worker-side error envelopes
│   ├── sentenceExtraction.ts      # Worker-side sentence-bbox pipeline
│   ├── sentencexInit.ts           # sentencex bootstrap (lazy, with fallback)
│   └── splitterResolver.ts        # Resolves SentenceSplitterConfig → splitter fn
├── DocumentAnalyzer.ts            # Text layer & OCR detection
├── StyleAnalyzer.ts               # Font/style analysis
├── MarginFilter.ts                # Header/footer removal
├── ColumnDetector.ts              # Multi-column layout detection
├── LineDetector.ts                # Line detection within columns
├── ParagraphDetector.ts           # Paragraph/heading grouping
├── PageExtractor.ts               # Final page processing
├── SearchScorer.ts                # Search result scoring & ranking
├── AnalysisWindow.ts              # Page-window resolution for analysis
├── FigureTextFilter.ts            # Standalone figure-text column detector
├── FilteredParagraphPipeline.ts   # Margin + column + line + paragraph fused pipeline
├── RawFontBridge.ts               # Bridge per-char font info into detailed pages
├── SentenceMapper.ts              # Span-level sentence → bbox mapping
├── ParagraphSentenceMapper.ts     # Paragraph-level sentence → bbox mapping
├── SentencexSplitter.ts           # sentencex byte/char range conversion + language normalization
├── sentenceTypes.ts               # Sentence-pipeline types
├── sentencePostprocess.ts         # Sentence-output post-processing
└── README.md                      # This file

react/utils/
├── extractionVisualizer.ts        # Debug visualization tools (overlay annotations)
├── extractionOverlay.ts           # Reader overlay rendering
└── extractionFixtures.ts          # Fixture helpers for sentence-pipeline tests
```

### Module Responsibilities

| Module                       | Responsibility                                  | Input                                  | Output                          |
| ---------------------------- | ----------------------------------------------- | -------------------------------------- | ------------------------------- |
| **MuPDFWorkerClient**        | Main-thread proxy: `postMessage` RPC + transfer | PDF bytes, op args                     | Op replies                      |
| **worker/ops + docHelpers**  | WASM interaction (worker-side)                  | PDF bytes                              | `RawPageData[]`                 |
| **DocumentAnalyzer**         | Text layer checks                               | `RawPageData[]`                        | Boolean, page count             |
| **StyleAnalyzer**            | Typography analysis                             | `RawPageData[]`                        | `StyleProfile`                  |
| **MarginFilter**             | Smart filtering                                 | `RawPageData[]`                        | `MarginRemovalResult`           |
| **ColumnDetector**           | Layout detection                                | `RawPageData`                          | `ColumnDetectionResult`         |
| **LineDetector**             | Line extraction                                 | `RawPageData`, columns                 | `PageLineResult`                |
| **ParagraphDetector**        | Semantic grouping                               | `PageLineResult`                       | `PageParagraphResult`           |
| **PageExtractor**            | Orchestration                                   | All above                              | `ProcessedPage`                 |
| **SearchScorer**             | Search scoring                                  | `RawPageData[]`, hits                  | `ScoredPageSearchResult[]`      |
| **FilteredParagraphPipeline**| Margin → column → line → paragraph fused        | `RawPageData`, detailed page, settings | `FilteredParagraphResult`       |
| **ParagraphSentenceMapper**  | Paragraph + splitter → sentence bboxes          | filtered paragraphs, splitter          | `PageSentenceBBoxResult`        |

---

## Core Concepts

### 1. Coordinate Systems

**MuPDF uses top-left origin**, **Zotero uses bottom-left origin**. Conversions are critical for visualization.

#### MuPDF (Top-Left Origin)

```
(0,0) ────────► X
  │
  │  [Text Block]
  │     x, y, w, h
  ▼
  Y
```

#### Zotero/PDF Standard (Bottom-Left Origin)

```
  Y
  ▲
  │  [Text Block]
  │     x1, y1, x2, y2
  │
(0,0) ────────► X
```

**Conversion formulas** (see `extractionVisualizer.ts`):

```typescript
// MuPDF {x, y, w, h} → Zotero [x1, y1, x2, y2]
x1 = rect.x;
x2 = rect.x + rect.w;
y1 = pageHeight - (rect.y + rect.h); // Bottom in Zotero coords
y2 = pageHeight - rect.y; // Top in Zotero coords
```

### 2. Data Types

#### Raw Data (from MuPDF)

```typescript
RawBBox; // { x, y, w, h } - top-left origin
RawFont; // { name, family, weight, style, size }
RawLine; // { wmode, bbox, font, x, y, text }
RawBlock; // { type, bbox, lines[] }
RawPageData; // { pageIndex, width, height, blocks[] }
```

#### Processed Data

```typescript
LineBBox; // { l, t, r, b, width, height } - easier for comparisons
ExtractedLine; // { text, bbox, fontSize, columnIndex }
ProcessedPage; // { index, content, lines[], columns[] }
```

#### Results

```typescript
ExtractionResult; // Result of PDFExtractor.extract (with or without useLineDetection)
PageSentenceBBoxResult; // Result of PDFExtractor.extractSentenceBBoxes
PDFSearchResult; // Result of PDFExtractor.search
PageImageResult; // Result of PDFExtractor.renderPageToImage
```

### 3. Text Layer Detection

**Robust detection** prevents false negatives:

```typescript
// DocumentAnalyzer.hasTextLayer()
1. Extract plain text from sample pages
2. Strip ALL whitespace: text.replace(/\s+/g, "")
3. Check if length > minTextPerPage (default: 100)
```

**Why strip whitespace?** Some PDFs have pages with only `\n\n\n...` which would pass a naive check.

### 4. Style Analysis

**Character-frequency based detection** of body text:

```typescript
// StyleAnalyzer.analyze()
1. Sample pages (default: 100 random pages for large docs)
2. For each span:
   - Filter short/whitespace/non-alphanumeric spans
   - Create style key: `${size}-${font}-${bold}-${italic}`
   - Count characters (not spans!)
3. Sort by character count
4. Primary body style = highest count
5. All body styles = count >= 15% of primary
```

**Why character count?** A single long paragraph in 12pt Times matters more than 50 small footnotes in 8pt Arial.

### 5. Margin Filtering

**Two-stage approach**:

#### Simple Filtering (always applied)

```typescript
DEFAULT_MARGINS = { left: 25, top: 40, right: 25, bottom: 40 };
// Exclude anything outside these thresholds
```

#### Smart Filtering (frequency analysis)

```typescript
DEFAULT_MARGIN_ZONE = { left: 60, top: 80, right: 60, bottom: 80 }

1. Collect elements in margin zones
2. Group by normalized text (case-insensitive, trimmed)
3. Remove if appears on ≥3 pages (repeatThreshold)
4. Detect page numbers:
   - Regex patterns: /^\d+$/, /^page \d+$/, /^[ivxlcm]+$/
   - Verify strictly increasing sequence
5. Log what was removed
```

**Why both?** Simple filtering catches outliers; smart filtering removes repeating elements even if they vary slightly.

### 6. Column Detection Algorithm

**Multi-phase algorithm** for complex layouts:

#### Phase 1: Extract & Filter Blocks

```typescript
1. Define clipping area (exclude header/footer margins)
2. Get text blocks from page
3. Filter:
   - Skip plot/symbol blocks (based on font, text, size)
   - Skip non-horizontal text (check wmode or dir)
   - Build bbox from valid lines only (sufficient alphanumeric chars)
4. Sort by position (top, then left)
```

#### Phase 2: Merge Blocks into Columns

```typescript
1. Try to merge adjacent blocks:
   - Must have x-overlap
   - Union must not intersect other merged blocks
2. Remove duplicates
3. Sort blocks with similar bottom coordinates by x-position
```

#### Phase 3: Join & Sort for Reading Order

```typescript
1. Align edges (if differ by ≤3pt)
2. Join vertically adjacent rectangles (similar edges, small gap)
3. Compute sort key for each column:
   - Find overlapping columns to the left
   - Use leftmost column's top as sort key
   - Ensures proper multi-column reading order
4. Return sorted columns
```

**Critical insight**: Multi-column reading order requires considering **which columns are to the left** of each column.

### 7. Line Detection

**Adaptive grouping** based on font size:

```typescript
1. Extract spans within each column
2. Sort spatially (top → bottom, left → right)
3. Calculate adaptive tolerance: median_font_size * baseTolerance (default 3.0)
4. Group spans into lines using vertical proximity
5. Split lines with large horizontal gaps (gapMultiplier * median_char_width)
6. Merge overlapping lines (handles drop caps, subscripts)
```

**Why adaptive?** A 2pt gap is huge for 8pt text but tiny for 24pt headings.

---

## Extending the Service

### Adding a New Analysis Module

**Example**: Add semantic section detection

1. **Create the module** (`SectionDetector.ts`):

```typescript
import type { PageLineResult } from "./LineDetector";
import type { StyleProfile } from "./types";

export interface Section {
  title: string;
  level: number; // 1 = h1, 2 = h2, etc.
  startLine: number;
  endLine: number;
}

export interface PageSectionResult {
  pageIndex: number;
  sections: Section[];
}

export function detectSections(
  lineResult: PageLineResult,
  styleProfile: StyleProfile,
): PageSectionResult {
  const sections: Section[] = [];

  // Your logic here
  // - Check font size relative to body styles
  // - Look for title case, all caps
  // - Consider line length (short lines often titles)
  // - Use whitespace patterns

  return {
    pageIndex: lineResult.pageIndex,
    sections,
  };
}
```

2. **Add types to `types.ts`**:

```typescript
export interface ProcessedPage {
  // ... existing fields
  sections?: Section[]; // Add optional field
}
```

3. **Integrate in the worker pipeline**:

The fused `extract` op runs inside the worker. Wire new analyzers into
`worker/ops.ts` (or `PageExtractor.ts`) so they execute alongside the
existing column/line/paragraph passes:

```typescript
import { detectSections } from "../SectionDetector";

// Inside the per-page loop in worker/ops.ts → opExtract
for (const rawPage of rawPages) {
  // ... existing column/line/paragraph detection
  const sectionResult = detectSections(lineResult, styleProfile);
  processedPage.sections = sectionResult.sections;
}
```

4. **Export for external use**:

```typescript
// In index.ts
export { detectSections } from "./SectionDetector";
export type { Section, PageSectionResult } from "./SectionDetector";
```

### Adding Extraction Options

1. **Add to `ExtractionSettings` in `types.ts`**:

```typescript
export interface ExtractionSettings {
  // ... existing options
  detectSections?: boolean;
  sectionMinFontSize?: number;
}
```

2. **Update defaults**:

```typescript
export const DEFAULT_EXTRACTION_SETTINGS: Required<ExtractionSettings> = {
  // ... existing
  detectSections: false,
  sectionMinFontSize: 14,
};
```

3. **Use in extraction pipeline**:

```typescript
if (opts.detectSections) {
  const sectionResult = detectSections(lineResult, styleProfile);
  processedPage.sections = sectionResult.sections;
}
```

### Creating Visualization Tools

**Example**: Visualize detected sections

```typescript
// In extractionVisualizer.ts

export async function visualizeCurrentPageSections(): Promise<{
    success: boolean;
    message: string;
}> {
    // 1. Get reader and current page
    const reader = await getCurrentReaderAndWaitForView(undefined, true);
    const currentPageIndex = /* get from pdfViewer */;

    // 2. Load PDF and extract one page via the worker
    const pdfData = await IOUtils.read(filePath);
    const { pages } = await getMuPDFWorkerClient().extractRawPages(
        pdfData,
        [currentPageIndex],
    );
    const rawPage = pages[0];
    if (!rawPage) throw new Error("page out of range");

    // 3. Run detection pipeline
    const filteredPage = MarginFilter.filterPageByMargins(rawPage, DEFAULT_MARGINS);
    const columnResult = detectColumns(filteredPage);
    const lineResult = detectLinesOnPage(filteredPage, columnResult.columns);
    const sectionResult = detectSections(lineResult, styleProfile);

    // 4. Create annotations
    const annotationRefs = await createSectionAnnotations(
        sectionResult.sections,
        currentPageIndex,
        rawPage.height,
        reader,
        viewBoxLL
    );

    BeaverTemporaryAnnotations.addToTracking(annotationRefs);

    return { success: true, message: `Found ${sectionResult.sections.length} sections` };
}
```

---

## Common Patterns

### 1. Processing Raw Data

**Always work from `RawPageData`** to avoid repeated WASM calls:

```typescript
// ✅ Good: Single extraction, multiple analyses
const rawData = mupdf.extractRawPages();
const styleProfile = StyleAnalyzer.analyze(rawData.pages);
const marginAnalysis = MarginFilter.collectMarginElements(rawData.pages);

// ❌ Bad: Multiple extractions
const styleProfile = StyleAnalyzer.analyze(mupdf); // Extracts internally
const marginAnalysis = MarginFilter.analyze(mupdf); // Extracts again
```

### 2. Filtering Pipeline

**Chain filters** for clean data:

```typescript
// 1. Raw page
const rawPage = mupdf.extractRawPage(pageIndex);

// 2. Apply simple margins
const simpleFiltered = MarginFilter.filterPageByMargins(rawPage, margins);

// 3. Apply smart removal
const fullyFiltered = MarginFilter.filterPageWithSmartRemoval(
  simpleFiltered,
  margins,
  marginZone,
  removalResult,
);

// 4. Now process
const columnResult = detectColumns(fullyFiltered);
```

### 3. Error Handling

**Use typed errors** for specific failures:

```typescript
try {
  const result = await extractor.extract(pdfData);
} catch (error) {
  if (error instanceof ExtractionError) {
    switch (error.code) {
      case ExtractionErrorCode.ENCRYPTED:
        // Route to password prompt
        break;
      case ExtractionErrorCode.NO_TEXT_LAYER:
        // Route to OCR service
        break;
      case ExtractionErrorCode.INVALID_PDF:
        // Show error to user
        break;
    }
  }
  throw error; // Unknown error
}
```

### 4. Coordinate Conversion

**Always convert when visualizing**:

```typescript
// MuPDF rect → Zotero rect
const zoteroRect = rectToZoteroFormat(mupdfRect, pageHeight, viewBoxLL);

// Use in annotation
const annotation = {
  position: {
    pageIndex: pageIndex,
    rects: [zoteroRect],
  },
  // ...
};
```

---

## Testing & Debugging

### Console Logging

**Structured logging** for complex results:

```typescript
console.group("Page Analysis");
console.log(`Columns: ${columnResult.columnCount}`);
console.log(`Lines: ${lineResult.allLines.length}`);
console.groupEnd();
```

### Visualization Tools

The plugin's **Dev Tools menu** (`react/components/ui/buttons/DevToolsMenuButton.tsx`,
visible only in dev builds) exposes the PDF debug actions:

1. **Test PDF Extraction**: Extract the selected attachment via `PDFExtractor.extract`
2. **Extract Current Page**: Run extraction on the single page open in the reader
3. **Test PDF Search**: `PDFExtractor.search` against the selected attachment
4. **Test OCR Detection**: `PDFExtractor.analyzeOCRNeeds` against the selected attachment
5. **Visualize Columns**: Blue overlays showing detected columns
6. **Visualize Lines**: Orange overlays for each detected line
7. **Visualize Paragraphs**: Green (paragraphs) and purple (headers)
8. **Visualize Sentences**: Per-sentence overlays from the sentence-bbox pipeline
9. **Clear Visualization**: Remove all temporary overlay annotations

For non-UI debugging, the dev-only HTTP endpoints under `/beaver/test/*`
(see `react/hooks/useHttpEndpoints.ts` and
`docs-zotero/pdf-extraction-debug-endpoints.md`) let you POST a payload
and read back JSON / base64-encoded overlay images without driving the
reader.

### Common Issues

#### Issue: "needsPassword is not a function"

**Cause**: JSM module caching  
**Solution**: Restart Zotero or use metadata fallback in `worker/docHelpers.ts`

#### Issue: False "No text layer" detection

**Cause**: Pages with only whitespace  
**Solution**: Already handled - we strip whitespace before checking

#### Issue: Wrong reading order

**Cause**: Column detection failing  
**Solution**: Check `logColumnDetection()` output; may need to adjust filtering

#### Issue: Coordinates don't match annotations

**Cause**: Coordinate system mismatch  
**Solution**: Verify `rectToZoteroFormat()` is being used

---

## Performance Considerations

### Extraction Speed

**Typical timings** (MacBook Pro M1, 10-page academic paper):

| Operation        | Time       | Notes                 |
| ---------------- | ---------- | --------------------- |
| Raw extraction   | ~50ms      | Single WASM pass      |
| Style analysis   | ~20ms      | Samples pages         |
| Margin analysis  | ~30ms      | Document-wide         |
| Column detection | ~5ms/page  | Fast spatial analysis |
| Line detection   | ~10ms/page | Adaptive grouping     |
| **Total**        | **~200ms** | For 10-page doc       |

### Optimization Tips

1. **Sample instead of analyzing all pages**:

   ```typescript
   styleSampleSize: 100; // Default: don't analyze 500+ page books
   ```

2. **Cache extraction results**:

   ```typescript
   const cachedResult = await new PDFExtractor().extract(pdfData);
   // Store in Map<itemID, ExtractionResult>
   ```

3. **Use page ranges for progressive loading**:

   ```typescript
   // Load first 10 pages immediately
   const preview = await new PDFExtractor().extract(pdfData, {
     pageIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
   });
   // Load rest in background — `pageRange` defers range resolution to the
   // worker so we don't need a separate getPageCount round-trip:
   const rest = await new PDFExtractor().extract(pdfData, {
     pageRange: { startIndex: 10 },
   });
   ```

4. **Use `useLineDetection` when you need positional metadata**:
   ```typescript
   // Each ProcessedPage.lines is populated with bbox + fontSize + columnIndex
   const result = await new PDFExtractor().extract(pdfData, {
     settings: { useLineDetection: true },
   });
   ```

---

## API Quick Reference

### Main Extraction Methods

```typescript
import { PDFExtractor } from "src/services/pdf";

const extractor = new PDFExtractor();

// Whole document
const result = await extractor.extract(pdfData);

// Explicit page list
const result = await extractor.extract(pdfData, { pageIndices: [0, 1, 2] });

// Open-ended range (resolved inside the worker — no pageCount round-trip)
const result = await extractor.extract(pdfData, {
  pageRange: { startIndex: 0, maxPages: 10 },
});

// Line-level extraction (populates ProcessedPage.lines with bbox metadata)
const result = await extractor.extract(pdfData, {
  settings: { useLineDetection: true },
});

// Document metadata + page labels in one round-trip
const meta = await extractor.getMetadata(pdfData);

// Cheap checks
const pageCount = await extractor.getPageCount(pdfData);
const ocrNeeds = await extractor.analyzeOCRNeeds(pdfData);

// Sentence-level bboxes for a single page
const sentences = await extractor.extractSentenceBBoxes(pdfData, {
  pageIndex: 0,
  splitter: { type: "sentencex", language: "en" },
});
```

### Page Image Rendering

Render PDF pages to PNG or JPEG images with configurable resolution.

```typescript
const extractor = new PDFExtractor();

// Render first page at 300 DPI as PNG
const image = await extractor.renderPageToImage(pdfData, 0, {
  dpi: 300, // 300 DPI for high quality
  alpha: false, // Opaque background
  showExtras: true, // Include annotations
  format: "png",
});
// image.data is Uint8Array of PNG bytes
// image.width, image.height - image dimensions in pixels

// Render pages 0-2 as JPEG thumbnails (fused with metadata in one round-trip)
const { pageCount, pageLabels, pages } = await extractor.renderPages(
  pdfData,
  {
    pageIndices: [0, 1, 2],
    options: { scale: 0.5, format: "jpeg", jpegQuality: 85 },
  },
);

// Render all pages — pass `pageIndices: undefined` (or omit) to avoid a
// pageCount round-trip
const all = await extractor.renderPages(pdfData);
```

#### PageImageOptions

| Option        | Type            | Default | Description                              |
| ------------- | --------------- | ------- | ---------------------------------------- |
| `scale`       | number          | 1.0     | Scale factor (1.0 = 72 DPI)              |
| `dpi`         | number          | 0       | Target DPI (takes precedence over scale) |
| `alpha`       | boolean         | false   | Transparent background                   |
| `showExtras`  | boolean         | true    | Render annotations and widgets           |
| `format`      | "png" \| "jpeg" | "png"   | Output format                            |
| `jpegQuality` | number          | 85      | JPEG quality (1-100)                     |

#### PageImageResult

| Property    | Type       | Description               |
| ----------- | ---------- | ------------------------- |
| `pageIndex` | number     | Page index (0-based)      |
| `data`      | Uint8Array | Image bytes (PNG or JPEG) |
| `format`    | string     | "png" or "jpeg"           |
| `width`     | number     | Image width in pixels     |
| `height`    | number     | Image height in pixels    |
| `scale`     | number     | Scale factor used         |
| `dpi`       | number     | Effective DPI             |

### PDF Text Search

Search for text within PDFs with relevance-ranked results. The search uses MuPDF's built-in text search with custom scoring based on document structure analysis.

#### Search Query Syntax

| Feature                 | Supported | Notes                                   |
| ----------------------- | --------- | --------------------------------------- |
| **Literal phrase**      | ✅ Yes    | `"machine learning"` finds exact phrase |
| **Case-insensitive**    | ✅ Yes    | `Machine` matches `machine`, `MACHINE`  |
| **Partial words**       | ✅ Yes    | `learn` matches `learning`, `learner`   |
| **Multiple words**      | ✅ Yes    | `neural network` finds the exact phrase |
| **Boolean AND**         | ❌ No     | Use multiple searches instead           |
| **Boolean OR**          | ❌ No     | Use multiple searches instead           |
| **Wildcards**           | ❌ No     | Not supported by MuPDF                  |
| **Regular expressions** | ❌ No     | Not supported by MuPDF                  |
| **Fuzzy matching**      | ❌ No     | Must match exactly                      |

#### Writing Effective Search Queries

**Best Practices:**

```typescript
const filePath = await attachment.getFilePathAsync();
if (!filePath) {
  throw new Error("Attachment file is unavailable");
}

const pdfData = await IOUtils.read(filePath);
const extractor = new PDFExtractor();

// ✅ Good: Specific phrase
await extractor.search(pdfData, "random forest classifier");

// ✅ Good: Key technical term
await extractor.search(pdfData, "gradient descent");

// ✅ Good: Partial word to catch variations
await extractor.search(pdfData, "optim"); // matches: optimize, optimization, optimal

// ❌ Avoid: Very short queries (too many matches)
await extractor.search(pdfData, "of"); // Matches everywhere

// ❌ Avoid: Very long phrases (may not match exactly)
await extractor.search(pdfData, "the implementation of our novel approach");
```

**For Multiple Terms (Simulating AND):**

```typescript
const filePath = await attachment.getFilePathAsync();
if (!filePath) {
  throw new Error("Attachment file is unavailable");
}

const pdfData = await IOUtils.read(filePath);
const extractor = new PDFExtractor();

// Search for pages containing BOTH terms
const result1 = await extractor.search(pdfData, "machine learning");
const result2 = await extractor.search(pdfData, "neural network");

// Find pages that appear in both results
const pagesWithBoth = result1.pages.filter((p1) =>
  result2.pages.some((p2) => p2.pageIndex === p1.pageIndex),
);
```

#### Basic Usage

```typescript
import { PDFExtractor } from "src/services/pdf";

// Simple search
const filePath = await attachment.getFilePathAsync();
if (!filePath) {
  throw new Error("Attachment file is unavailable");
}

const pdfData = await IOUtils.read(filePath);
const extractor = new PDFExtractor();
const result = await extractor.search(pdfData, "machine learning");

if (result) {
  console.log(
    `Found ${result.totalMatches} matches in ${result.pagesWithMatches} pages`,
  );

  // Pages are ranked by relevance score (highest first)
  for (const page of result.pages) {
    console.log(`Page ${page.pageIndex + 1}: score=${page.score.toFixed(2)}`);
  }
}
```

#### Manual Usage with Raw PDF Data

```typescript
import { PDFExtractor } from "src/services/pdf";

const extractor = new PDFExtractor();
const result = await extractor.search(pdfData, "neural network");

// Access ranked pages
for (const page of result.pages) {
  console.log(`Page ${page.pageIndex + 1}:`);
  console.log(`  Score: ${page.score.toFixed(2)}`);
  console.log(`  Matches: ${page.matchCount}`);
  console.log(`  Text length: ${page.textLength} chars`);

  // Access individual hits with role information
  for (const hit of page.hits) {
    console.log(`  Hit: [${hit.role}] weight=${hit.weight}`);
    if (hit.matchedText) {
      console.log(`    Context: "${hit.matchedText}"`);
    }
  }
}
```

#### Scoring Methodology

Results are ranked using a **weighted role-based scoring system** that prioritizes matches in significant content:

```
Page Score = Σ(hit_weight) × base_multiplier / √(text_length)
```

**Role Weights (Default):**

| Text Role  | Weight | Description                      |
| ---------- | ------ | -------------------------------- |
| `heading`  | 3.0    | Section titles, chapter headings |
| `body`     | 1.0    | Main content text (baseline)     |
| `caption`  | 0.7    | Figure/table captions            |
| `footnote` | 0.3    | Footnotes, endnotes              |
| `unknown`  | 0.5    | Text with undetermined role      |

**How Roles Are Determined:**

The `StyleAnalyzer` builds a typography profile of the document:

- **Body text**: Style with most characters (by frequency analysis)
- **Heading**: Font size > 120% of body size
- **Footnote**: Font size < 85% of body size
- **Caption**: Font size 85-95% of body size

**Why Normalization?**

The `√(text_length)` normalization prevents long pages from dominating results. A page with 5 matches in 500 words ranks higher than 5 matches in 5000 words.

#### Customizing Scoring

```typescript
const result = await extractor.search(pdfData, "query", {
  scoring: {
    // Custom role weights
    roleWeights: {
      heading: 5.0, // Prioritize headings even more
      body: 1.0,
      caption: 0.5,
      footnote: 0.1, // Heavily de-prioritize footnotes
    },

    // Disable text length normalization
    normalizeByTextLength: false,

    // Adjust base multiplier
    baseMultiplier: 100,
  },
});
```

#### Search Options

| Option           | Type     | Default | Description                                  |
| ---------------- | -------- | ------- | -------------------------------------------- |
| `maxHitsPerPage` | number   | 100     | Maximum hits to return per page              |
| `pages`          | number[] | []      | Limit search to specific pages (empty = all) |
| `scoring`        | object   | {}      | Scoring configuration (see below)            |

**Scoring Options:**

| Option                          | Type    | Default   | Description                         |
| ------------------------------- | ------- | --------- | ----------------------------------- |
| `roleWeights`                   | object  | See above | Weight multipliers for text roles   |
| `normalizeByTextLength`         | boolean | true      | Divide score by √(text_length)      |
| `minTextLengthForNormalization` | number  | 200       | Floor for normalization denominator |
| `baseMultiplier`                | number  | 100       | Base score multiplier               |

#### Result Types

**PDFSearchResult:**

```typescript
interface PDFSearchResult {
  query: string; // Search query used
  totalMatches: number; // Total matches across all pages
  pagesWithMatches: number; // Number of pages with matches
  totalPages: number; // Total pages in document
  pages: ScoredPageSearchResult[]; // Ranked page results
  metadata: {
    searchedAt: string; // ISO timestamp
    durationMs: number; // Search duration
    options: PDFSearchOptions;
    scoringOptions: SearchScoringOptions;
  };
}
```

**ScoredPageSearchResult:**

```typescript
interface ScoredPageSearchResult {
  pageIndex: number; // 0-based page index
  label?: string; // Page label (e.g., "iv", "220")
  matchCount: number; // Number of matches on page
  score: number; // Computed relevance score
  rawScore: number; // Sum of hit weights (before normalization)
  textLength: number; // Total text on page
  width: number; // Page width in points
  height: number; // Page height in points
  hits: ScoredSearchHit[]; // Individual hits with positions
}
```

**ScoredSearchHit:**

```typescript
interface ScoredSearchHit {
  quads: QuadPoint[]; // Hit coordinates (for highlighting)
  bbox: RawBBox; // Bounding box of hit
  role: TextRole; // "heading" | "body" | "caption" | "footnote" | "unknown"
  weight: number; // Role weight applied
  matchedText?: string; // Text context of the match
}
```

#### Performance Considerations

| Document Size | Typical Search Time | Notes                            |
| ------------- | ------------------- | -------------------------------- |
| 10 pages      | ~50ms               | Fast for most documents          |
| 100 pages     | ~200ms              | Still responsive                 |
| 500+ pages    | ~500-1000ms         | Consider limiting `pages` option |

**Optimization Tips:**

```typescript
// Limit to first 50 pages for faster results
const result = await extractor.search(pdfData, "query", {
  pages: Array.from({ length: 50 }, (_, i) => i),
});

// Reduce max hits per page if you only need top results
const result = await extractor.search(pdfData, "query", {
  maxHitsPerPage: 20,
});
```

### Detection Functions

```typescript
// Column detection
import { detectColumns } from "src/services/pdf";
const columnResult = detectColumns(rawPage);

// Line detection
import { detectLinesOnPage } from "src/services/pdf";
const lineResult = detectLinesOnPage(rawPage, columns);

// Paragraph detection
import { detectParagraphs } from "src/services/pdf";
const paragraphResult = detectParagraphs(lineResult, bodyStyles);
```

### Visualization

```typescript
import {
  visualizeCurrentPageColumns,
  visualizeCurrentPageLines,
  visualizeCurrentPageParagraphs,
  clearVisualizationAnnotations,
} from "react/utils/extractionVisualizer";

await visualizeCurrentPageColumns();
await clearVisualizationAnnotations();
```

---

## Future Enhancements

### Planned Features

1. **Table Detection**: Identify and extract tabular data
2. **Figure/Caption Extraction**: Link figures with captions
3. **Reference Parsing**: Extract bibliography entries
4. **Citation Detection**: Find in-text citations
5. **Equation Recognition**: Detect and preserve math notation
6. **Multi-language Support**: Handle RTL languages

### Contributing

When adding features:

1. **Add types first** in `types.ts`
2. **Create focused module** for the new functionality
3. **Write tests** under `tests/unit/pdf/` (and the sentence-pipeline fixture suite under `tests/unit/pdf/sentenceFixtures` where applicable); use the Dev Tools menu actions for live spot-checks
4. **Add visualization** for debugging
5. **Document in this README**
6. **Update USAGE.md** if it affects the public API

---

## Resources

- **MuPDF Documentation**: https://mupdf.com/docs/
- **MuPDF.js GitHub**: https://github.com/ArtifexSoftware/mupdf.js
- **PDF Coordinate Systems**: https://stackoverflow.com/questions/11742537/
- **Zotero Plugin Development**: https://www.zotero.org/support/dev/

---

## Troubleshooting

### WASM Initialization Errors

**Symptom**: `$libmupdf_load_font_file is not a function`  
**Fix**: Already handled with a stub in the worker's MuPDF API wrapper (`worker/mupdfApi.ts`).

### Memory Issues

**Symptom**: Browser crashes on large PDFs  
**Fix**: Process in chunks using `pageIndices` (or `pageRange`):

```typescript
for (let i = 0; i < pageCount; i += 10) {
  const chunk = await extractor.extract(pdfData, {
    pageIndices: Array.from({ length: 10 }, (_, j) => i + j),
    settings: { useLineDetection: true },
  });
  // Process chunk
}
```

### Incorrect Text Order

**Symptom**: Multi-column text is interleaved  
**Fix**: Check column detection; may need to adjust `ColumnDetector` parameters

---

## Glossary

- **Bbox**: Bounding box, the rectangular region occupied by text
- **Span**: A sequence of characters with uniform styling
- **Line**: A horizontal sequence of spans
- **Block**: A rectangular region of text (usually a paragraph)
- **Column**: A vertical region containing text blocks in reading order
- **Item**: A semantic unit (paragraph, heading, list item)
- **Structured Text**: PDF text with positional and style metadata
- **Reading Order**: The sequence text should be read (crucial for multi-column)
- **Style Profile**: Document-wide analysis of typography
- **Margin Zone**: Region near page edges where headers/footers appear
- **Smart Removal**: Frequency-based detection of repeating elements
- **OCR**: Optical Character Recognition (for scanned PDFs)
- **QuadPoint**: A quadrilateral defining a text region (8 floats: ul, ur, ll, lr corners)
- **Text Role**: Semantic classification of text (heading, body, caption, footnote)
- **Relevance Score**: Computed ranking value based on match context and text role

---

## License

This PDF extraction service is part of the Beaver Zotero plugin.
