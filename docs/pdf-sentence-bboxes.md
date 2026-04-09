# Sentence-Level Bounding Boxes from MuPDF

Design note for extending `src/services/pdf/` to produce sentence-level
bounding boxes, where a sentence is represented as a list of bboxes (one per
contiguous run of characters on the same line).

## Goal

Given a page of a PDF, produce for each sentence:

```ts
interface SentenceBBox {
    pageIndex: number;
    text: string;
    /** One bbox per line-fragment the sentence occupies */
    bboxes: RawBBox[];
    /** Optional per-fragment detail */
    fragments?: Array<{
        lineIndex: number;
        text: string;
        bbox: RawBBox;
        quad?: QuadPoint;  // useful for rotated selections
    }>;
}
```

A single sentence can span multiple lines (and therefore produce multiple
bboxes); a short sentence may occupy only part of a single line.

Sentence splitting itself is **out of scope** — the pipeline takes a
splitter callback and only worries about resolving sentence text ranges to
coordinates.

## Current state (summary)

- PDF extraction lives in `src/services/pdf/`.
- `MuPDFService.extractRawPage()` calls `page.toStructuredText(...).asJSON()`,
  which emits **blocks → lines** only. The C emitter
  (`fz_print_stext_page_as_json`) never outputs characters, regardless of
  stext option flags.
- Sub-line positional data is already reachable: `StructuredText.walk(walker)`
  (`addon/content/lib/mupdf.mjs:1088-1133`) exposes an `onChar(rune, origin,
  font, size, quad, color)` callback where `quad` is the full per-character
  quadrilateral. `page.search()` already round-trips these quads via
  `MuPDFService.searchPage()`.
- MuPDF does not have a word-level structure at all. Lines contain characters
  directly (`fz_stext_line → fz_stext_char`). Any grouping larger than a char
  and smaller than a line is reconstructed in user code.

## Approaches considered

### A. Split paragraph text into sentences, then `page.search()` each sentence
Use the existing line-level extractor, split the reconstructed text into
sentences, then feed each sentence back through MuPDF search to recover quads.

**Rejected.** The reconstructed text has been normalized, dehyphenated, and
column-stitched. `page.search()` is a literal phrase matcher; it will miss
most multi-line sentences, partially match others, and produce false
positives on short sentences. The match-repair work outweighs any simplicity
gain.

### B. Paragraph bbox + walk chars inside the bbox
Get paragraphs via the current pipeline, split into sentences, then walk
characters inside each paragraph's bbox.

**Rejected.** Three problems:

1. **No performance win.** `walk()` iterates every character on the page
   regardless of what the walker callback filters. Bbox containment in user
   code only discards results after the C↔JS crossings have already happened.
2. **Doesn't solve the mapping problem.** Knowing "this char is inside
   paragraph P" tells you nothing about "this char is position 47 of sentence
   2". You still need a text↔char index map, which is the whole problem.
3. **Fragile for rotated and multi-column layouts.** Axis-aligned containment
   breaks down at column gutters and for slightly rotated text.

### C. Character walk, enriched lines, text↔char offset map *(recommended)*
Walk each page once, capture characters grouped by their source line, feed
those through the existing column / paragraph detector unchanged, and carry
a `textOffset → charIndex` map inside each line and paragraph. Sentence
ranges then resolve trivially to character slices, which in turn resolve to
one bbox per line-fragment.

## Recommended design

### 1. Data shape

New types in `src/services/pdf/types.ts`:

```ts
export interface RawChar {
    /** Single Unicode code point */
    c: string;
    /** 8-float quadrilateral: [ulx,uly,urx,ury,llx,lly,lrx,lry] */
    quad: QuadPoint;
    /** Axis-aligned bbox computed from quad (convenience) */
    bbox: RawBBox;
}

export interface RawLineDetailed extends RawLine {
    /**
     * One RawChar per code point in `text`.
     * INVARIANT: text.length === chars.length, and text[i] === chars[i].c.
     * Any normalization (ligature expansion, whitespace collapse) must apply
     * to both sides or to neither — never one.
     */
    chars: RawChar[];
}

export interface RawBlockDetailed extends Omit<RawBlock, "lines"> {
    lines?: RawLineDetailed[];
}

export interface RawPageDataDetailed extends Omit<RawPageData, "blocks"> {
    blocks: RawBlockDetailed[];
}

export interface SentenceBBox {
    pageIndex: number;
    text: string;
    bboxes: RawBBox[];
    fragments?: Array<{
        lineIndex: number;
        text: string;
        bbox: RawBBox;
        quad?: QuadPoint;
    }>;
}
```

Because `RawLineDetailed extends RawLine`, all downstream processors
(`ColumnDetector`, `ParagraphDetector`, `MarginFilter`, `StyleAnalyzer`)
continue to work without modification — they see the base fields they
already expect and ignore the extra `chars` array.

### 2. Extraction flow

New method on `MuPDFService`, sibling to `extractRawPage`:

```ts
extractRawPageDetailed(
    pageIndex: number,
    opts?: { includeImages?: boolean; accurateBboxes?: boolean }
): RawPageDataDetailed
```

Internally:

```
page = doc.loadPage(pageIndex)
stextOptions = "preserve-whitespace,preserve-ligatures"
              + (accurateBboxes ? ",accurate-bboxes" : "")
              + (includeImages  ? ",preserve-images" : "")
stext = page.toStructuredText(stextOptions)

stext.walk({
    beginTextBlock(bbox) → start a new RawBlockDetailed
    beginLine(bbox, wmode, dir) → start a new RawLineDetailed
    onChar(rune, origin, font, size, quad, color) →
        push RawChar to current line
        append rune to current line.text
    endLine() → finalize
    endTextBlock() → finalize
    onImageBlock(bbox, matrix, image) → if includeImages, push image block
})

stext.destroy()
page.destroy()
```

Guarantee preserved by construction: `line.text` and `line.chars` have the
same length and index into the same characters.

### 3. Existing pipeline stays unchanged

`RawLineDetailed extends RawLine`, so:

- `ColumnDetector` groups detailed lines into columns the same way it groups
  raw lines.
- `ParagraphDetector` groups lines into paragraphs the same way.
- `MarginFilter`, `StyleAnalyzer`, `SearchScorer` see the same fields they
  always saw.

No changes are required in any of those files. The enrichment flows through
because TypeScript's structural subtyping keeps the base contract intact.

### 4. Paragraph ↔ sentence offset map

When the paragraph detector concatenates a paragraph's lines into a single
plain text string, build a parallel offset table:

```ts
interface ParagraphText {
    text: string;
    /**
     * For every character in `text`, where did it come from?
     * - `lineIndex` is relative to the paragraph's lines array.
     * - `charIndex` is the index into that line's `chars` array.
     * - Characters injected between lines (e.g. a separating space) map to
     *   `null` or to the nearest real source, chosen once and applied
     *   consistently so sentence boundaries always land on real chars.
     */
    source: Array<{ lineIndex: number; charIndex: number } | null>;
}
```

Build this alongside text reconstruction:

```
for each line in paragraph.lines:
    for each (i, char) in line.chars:
        text += char.c
        source.push({ lineIndex, charIndex: i })
    if not last line:
        text += " "                     // or "" after dehyphenation
        source.push(null)
```

### 5. Sentence → bboxes

Given sentence offsets `[start, end)` in a paragraph's text:

```ts
function sentenceToBoxes(
    p: ParagraphText,
    lines: RawLineDetailed[],
    start: number,
    end: number
): SentenceBBox {
    // 1. Walk p.source[start..end], collecting runs grouped by lineIndex.
    //    Skip nulls — they are boundary filler, not real chars.
    // 2. For each run (lineIndex, [charStart..charEnd]):
    //      fragmentQuads = lines[lineIndex].chars
    //          .slice(charStart, charEnd + 1)
    //          .map(c => c.quad);
    //      fragmentBBox  = unionQuads(fragmentQuads);
    //      fragmentText  = lines[lineIndex].text.slice(charStart, charEnd + 1);
    // 3. Return { pageIndex, text, bboxes, fragments }.
}
```

Multi-line sentences naturally produce one bbox per line run. A sentence
whose last line is short yields a tight bbox on that last line instead of a
full-width line rectangle.

### 6. Integration points

- **`src/services/pdf/MuPDFService.ts`** — add `extractRawPageDetailed()`;
  add `walk(walker)` to the `MuPDFStructuredText` interface.
- **`src/services/pdf/types.ts`** — add the `RawChar`, `RawLineDetailed`,
  `RawBlockDetailed`, `RawPageDataDetailed`, `SentenceBBox` types.
- **`src/services/pdf/index.ts`** — thread a `detailed?: boolean` option
  through `PDFExtractor.extract` / `extractByLines` so the paragraph
  detector can receive detailed lines.
- **New module `src/services/pdf/SentenceMapper.ts`** — takes a processed
  page with detailed lines plus an injected sentence-splitter callback and
  returns `SentenceBBox[]`.

Nothing in `DocumentAnalyzer`, `StyleAnalyzer`, `MarginFilter`,
`ColumnDetector`, `LineDetector`, or `ParagraphDetector` needs to change.

## Correctness traps

The whole approach depends on `line.text` and `line.chars` staying in
lockstep. The things that break it:

- **Ligatures.** With `preserve-ligatures`, one glyph is one `onChar` call
  but the text form may be a multi-code-point cluster. Without it, a
  ligature can expand into multiple `onChar` calls sharing the same quad.
  Pick one mode and apply it consistently — do not mix stext options across
  the JSON pass and the walk pass.
- **MuPDF-synthesized whitespace.** MuPDF sometimes inserts space characters
  between chars based on position gaps. Those are real `onChar` calls with
  real quads. Do not filter them out of `line.chars`; filtering would
  desync text and chars.
- **Dehyphenation.** The `dehyphenate` stext flag removes trailing `-` at
  line ends in the C layer, so the chars the walker sees are already
  modified. Either enable dehyphenation for *both* passes (JSON + detailed)
  or for *neither*, so text content matches.

One canonical rule: **text and chars are the same sequence, period.** Any
normalization happens as a pure function applied to both sides
simultaneously.

## Performance optimizations

Ranked from highest leverage to lowest. Adopt in order.

1. **On-demand extraction only.** Never run the detailed char walk during
   bulk indexing. Trigger it only when the user actually needs a sentence
   bbox on a specific page (e.g. opening a citation overlay, clicking a
   source link). In a typical session this turns 300-page work into 2-3
   page work; no micro-optimization below is close to as impactful.

2. **LRU cache keyed by `(pdfHash, pageIndex)`.** Cache
   `RawPageDataDetailed` for the most recently requested pages (target ~20).
   Sentence re-lookups on a recently visited page become free.

3. **`walkLight(walker)` monkey-patch on `StructuredText.prototype`.** The
   upstream `walk()` fetches rune + origin + font + size + quad + color per
   character, and allocates a `new Font(ptr)` per character. For sentence
   bboxes only rune + quad are needed. Add a lighter variant that
   (a) inlines the quad read directly from `libmupdf.HEAPF32` instead of
   going through the `fromQuad` helper, (b) fetches only the fields the
   walker requested, and (c) skips the `Font` wrapper allocation entirely.
   Cuts per-char C↔JS crossings from ~7 to ~3 and eliminates per-char GC
   pressure. Expect a 2-4× speedup on character-dense pages. Keep the patch
   in a separate file that extends the prototype at load time rather than
   editing the vendored `mupdf.mjs` in place, so upstream updates remain
   clean.

4. **Share the `StructuredText` across passes.** When the same page needs
   both the cheap `asJSON()` pass and the detailed walk, create the stext
   once, run both methods on it, destroy once. Saves one
   `_wasm_new_stext_page_from_page` call per page.

5. **Font pointer cache for walkers that do need font info.**
   `_wasm_stext_char_get_font` returns a stable pointer that many chars
   share. Cache `Map<ptr, { name, family }>` across the walk so the
   boundary crossing happens once per unique font instead of once per
   character.

6. **Bulk-dump WASM export (endgame).** The theoretical ceiling is a custom
   C helper that serializes an entire page's characters into pre-allocated
   `Float32Array` + `Uint32Array` buffers in a single boundary crossing —
   for example `fz_dump_stext_chars(page, runes, quads, line_ids,
   max_chars)`. JS then reads one `slice()` per page. Boundary crossings
   drop from `O(n_chars × 7)` to `O(1) per page`, for an estimated 10-20×
   speedup over today's `walk()`. Cost: requires patching MuPDF source,
   installing emscripten, and rebuilding both `mupdf-wasm.wasm` and
   `mupdf-wasm.mjs`. Only worth doing after profiling confirms the walk is
   still a hot path once optimizations 1-5 are in place, and only if the
   workload is "walk every page of every document".
