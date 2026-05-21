# Beaver Extract Fixture Page Format Migration

## Goal

Migrate extraction regression fixtures away from the custom snapshot page shape and toward storing the public page contracts directly:

- `StructuredPage[]` for structured extraction output.
- `MarkdownPage[]` for markdown extraction output.

One fixture must be able to cover multiple pages for both modes.

## Current Problem

Fixtures currently store `expected.perPage[]` as `ExtractionPageSnapshot`, produced by `projectExtractionSnapshot(...)`. That projection renames and reshapes canonical fields (`order` to `index`, `Rect` arrays to bbox objects, nested sentences to a flat page sentence list, etc.). This makes fixture diffs harder to reason about because the fixture format no longer matches the public extraction schema.

## Proposed Fixture Shape

Introduce a new fixture schema version. Replace or supersede `expected.perPage` with an expected payload that stores canonical pages directly:

```ts
interface ExpectedExtractionFixture {
  structured: {
    pages: StructuredPage[];
  };
  markdown: {
    pages: MarkdownPage[];
  };
}
```

Keep fixture-level metadata such as `schema`, `id`, `pdfSha256`, `config`, `fingerprints`, and `tolerance`. Keep page selection in `config.pageIndices`; expected `pages` should contain exactly those selected pages, in document order.

## Implementation Tasks

1. Add a `MarkdownPage` export if one does not already exist as a named type in the schema module. It should match `MarkdownExtractResult.document.pages[number]`.

2. Update fixture schema/types and validators:
   - Bump `FIXTURE_SCHEMA_VERSION`.
   - Validate `expected.structured.pages` as `StructuredPage[]`.
   - Validate `expected.markdown.pages` as `MarkdownPage[]`.
   - Preserve targeted validation errors with field paths.

3. Update fixture capture/update:
   - Run structured extraction in `mode: "structured"` and store selected `StructuredPage[]`.
   - Run markdown extraction in `mode: "markdown"` using the fixture config’s selected pages/range and store selected `MarkdownPage[]`.
   - Preserve current config semantics and timestamps.

4. Update fixture evaluation/smoke tests:
   - Compare stored `StructuredPage[]` to current structured pages.
   - Compare stored `MarkdownPage[]` to current markdown pages.
   - Keep bbox tolerance for structured page bbox fields.
   - Keep whitespace normalization where appropriate for markdown page text.
   - Keep citation-index assertions for structured output, but assert against the canonical structured page IDs.

5. Remove or narrow `ExtractionPageSnapshot` usage:
   - If no longer needed for fixtures, delete fixture-specific projection fields such as `content`, `itemCount`, `sentenceCount`, `degradedItems`, flattened `sentences`, and fixture bbox objects.
   - If snapshot projection is still useful for debug tooling, move it out of the fixture path and document it as debug-only.

6. Rebaseline fixtures:
   - Update the public fixture corpus first.
   - Update the private extract fixture corpus.
   - OCR fixtures should remain unchanged.

## Acceptance Criteria

- `fixture.json` stores `StructuredPage[]` without renaming fields or flattening nested sentences.
- `fixture.json` also stores selected `MarkdownPage[]`.
- Multi-page fixtures store multiple pages for both modes.
- `npm run test:cli-smoke` passes with public fixtures.
- `BEAVER_EXTRACT_FIXTURES_DIR=/path/to/private npm run test:cli-smoke` passes with private fixtures.
- Fixture diffs refer to canonical field names such as `items[0].order`, `items[0].bbox`, and `items[0].sentences[0].order`.

## Notes

Do not store `citationIndex` inside each fixture unless there is a specific regression value in doing so. It is document-level derived data and should stay asserted by smoke tests from the structured result.
