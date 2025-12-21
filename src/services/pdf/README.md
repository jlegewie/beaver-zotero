# PDF Extraction Service

Local PDF text extraction using MuPDF WASM. This module provides structured text extraction with style analysis and document preprocessing.

> **Note:** This is a foundational structure. Types, functions, and functionality will evolve as the extraction pipeline is built out.

## Architecture

```
src/services/pdf/
├── index.ts           # Main entry point (PDFExtractor class)
├── types.ts           # All interfaces and type definitions
├── MuPDFService.ts    # Low-level WASM bridge
├── DocumentAnalyzer.ts# Document-wide analysis
├── StyleAnalyzer.ts   # Font/typography analysis
├── PageExtractor.ts   # Page-level text processing
└── README.md
```

## Files

| File | Purpose |
|------|---------|
| **`index.ts`** | Main `PDFExtractor` class and convenience functions. Orchestrates the extraction pipeline. |
| **`types.ts`** | Type definitions: `ExtractionSettings`, `ProcessedPage`, `ExtractionResult`, error types. |
| **`MuPDFService.ts`** | Singleton wrapper around MuPDF WASM. Handles init, caching, and raw data extraction. |
| **`DocumentAnalyzer.ts`** | Document-level analysis: text layer detection (`hasNoTextLayer`), header/footer detection (TODO). |
| **`StyleAnalyzer.ts`** | Collects font statistics across pages. Identifies body vs heading fonts. |
| **`PageExtractor.ts`** | Processes raw blocks into clean text. Filters headers/footers, classifies semantic roles. |

## Usage

```typescript
import { PDFExtractor, extractFromZoteroItem } from '../services/pdf';

// From raw PDF data
const extractor = new PDFExtractor();
const result = await extractor.extract(pdfData, { 
    pages: [0, 1, 2],           // Optional: specific pages
    removeRepeatedElements: true // Filter headers/footers
});
console.log(result.fullText);

// From Zotero item (convenience)
const result = await extractFromZoteroItem(item);
```

## Pipeline Flow

1. **Open** → `MuPDFService.open(pdfData)`
2. **Analyze** → `DocumentAnalyzer.analyze()` (text layer check, repeated elements)
3. **Profile** → `StyleAnalyzer.buildProfile()` (font statistics)
4. **Extract** → `PageExtractor.extractPage()` for each page
5. **Combine** → Join page content into `fullText`

## WASM Assets

The MuPDF WASM files live in `addon/content/`:
- `lib/mupdf-wasm.wasm` - Compiled WASM binary
- `lib/mupdf-wasm.mjs` - WASM loader
- `modules/mupdf-loader.js` - High-level loader with caching

## TODO

- [ ] Header/footer detection via cross-page pattern matching
- [ ] Style-based heading detection
- [ ] Line joining and hyphenation handling
- [ ] Table detection
- [ ] Multi-column layout support

