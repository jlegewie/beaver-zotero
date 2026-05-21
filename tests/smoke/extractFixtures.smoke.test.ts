/**
 * BeaverExtract regression-fixture smoke test.
 *
 * Iterates every fixture under `tests/fixtures/pdfs/extract-public/` (and
 * `extract/` when the private corpus is present), re-runs structured-mode
 * extraction with the captured config and diffs canonical structured and
 * markdown pages against `expected`. Failures throw the formatted diff block from
 * `formatDiffs(...)` so an agent can pinpoint the offending field.
 *
 * Lives in the smoke tier (`vitest.smoke.config.ts` / `npm run
 * test:cli-smoke`) because real MuPDF + sentencex extraction is slower
 * than the default unit run.
 */
import { describe, expect, it } from "vitest";

import {
    diffMarkdownPages,
    diffStructuredPages,
    formatDiffs,
    type SnapshotDiff,
} from "../../src/beaver-extract/cli/fixture/pageDiff";
import { extractPdf } from "../../src/beaver-extract/node/api";
import { resolveAnalysisWindow } from "../../src/beaver-extract/cli/fixture/analysisScope";
import {
    loadExtractFixtures,
    privateRoot,
    publicRoot,
    readSharedPdf,
} from "../helpers/extractFixtureLoader";

// `loadExtractFixtures(publicRoot())` THROWS on a missing or empty public
// root — every machine and CI must have at least one public fixture.
// The private root is best-effort.
const fixtures = [
    ...loadExtractFixtures(publicRoot()),
    ...loadExtractFixtures(privateRoot(), { skipIfMissing: true }),
];

describe("BeaverExtract fixtures (smoke)", () => {
    for (const f of fixtures) {
        it(`[${f.scope}] ${f.id}`, async () => {
            const pdfBytes = readSharedPdf(f.root, f.fixture.pdfSha256);
            const result = await extractPdf({
                pdfData: pdfBytes,
                mode: "structured",
                analysisWindow: resolveAnalysisWindow(f.fixture.config.analysisScope),
                settings: f.fixture.config.settings,
                paragraphSettings: f.fixture.config.paragraphSettings,
                structured: { splitterConfig: f.fixture.config.splitterConfig },
            });
            if (result.mode !== "structured") {
                throw new Error("expected structured result");
            }
            const selected = new Set(f.fixture.config.pageIndices);
            const structuredPages = result.document.pages
                .filter((p) => selected.has(p.index))
                .sort((a, b) => a.index - b.index);
            const markdown = await extractPdf({
                pdfData: pdfBytes,
                mode: "markdown",
                analysisWindow: resolveAnalysisWindow(f.fixture.config.analysisScope),
                pageIndices: f.fixture.config.pageIndices,
                settings: f.fixture.config.settings,
                paragraphSettings: f.fixture.config.paragraphSettings,
            });
            if (markdown.mode !== "markdown") {
                throw new Error("expected markdown result");
            }
            const markdownPages = markdown.document.pages
                .filter((p) => selected.has(p.index))
                .sort((a, b) => a.index - b.index);
            const diffs: SnapshotDiff[] = [
                ...diffStructuredPages(
                    f.fixture.expected.structured.pages,
                    structuredPages,
                    { bboxAbsPt: f.fixture.tolerance.bboxAbsPt },
                ).map((d) => ({ ...d, path: `structured.${d.path}` })),
                ...diffMarkdownPages(
                    f.fixture.expected.markdown.pages,
                    markdownPages,
                    {},
                ).map((d) => ({ ...d, path: `markdown.${d.path}` })),
            ];
            if (diffs.length > 0) {
                throw new Error(formatDiffs(`[${f.scope}] ${f.id}`, diffs));
            }
            for (const page of result.document.pages.filter((p) => selected.has(p.index))) {
                for (const item of page.items) {
                    expect(result.document.citationIndex[item.id]).toMatchObject({
                        id: item.id,
                        kind: "item",
                        pageIndex: page.index,
                        itemId: item.id,
                    });
                    if (!("sentences" in item) || !item.sentences) continue;
                    for (const sentence of item.sentences) {
                        expect(result.document.citationIndex[sentence.id]).toMatchObject({
                            id: sentence.id,
                            kind: "sentence",
                            pageIndex: page.index,
                            itemId: item.id,
                            sentenceId: sentence.id,
                        });
                    }
                }
            }
        });
    }
});
