/**
 * BeaverExtract regression-fixture smoke test.
 *
 * Iterates every fixture under `tests/fixtures/pdfs/extract-public/` (and
 * `extract/` when the private corpus is present), re-runs structured-mode
 * extraction with the captured config, projects, and diffs against
 * `expected`. Failures throw the formatted diff block from
 * `formatDiffs(...)` so an agent can pinpoint the offending field.
 *
 * Lives in the smoke tier (`vitest.smoke.config.ts` / `npm run
 * test:cli-smoke`) because real MuPDF + sentencex extraction is slower
 * than the default unit run.
 */
import { describe, it } from "vitest";

import {
    diffExtractionSnapshots,
    formatDiffs,
    projectExtractionSnapshot,
} from "../../src/beaver-extract/debug/extractionSnapshot";
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
                pageIndices: f.fixture.config.pageIndices,
                analysisWindow: resolveAnalysisWindow(f.fixture.config.analysisScope),
                settings: f.fixture.config.settings,
                paragraphSettings: f.fixture.config.paragraphSettings,
                structured: { splitterConfig: f.fixture.config.splitterConfig },
            });
            const actual = projectExtractionSnapshot(result);
            const diffs = diffExtractionSnapshots(f.fixture.expected, actual, {
                bboxAbsPt: f.fixture.tolerance.bboxAbsPt,
            });
            if (diffs.length > 0) {
                throw new Error(formatDiffs(`[${f.scope}] ${f.id}`, diffs));
            }
        });
    }
});
