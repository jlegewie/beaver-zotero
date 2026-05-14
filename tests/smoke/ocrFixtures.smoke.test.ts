/**
 * OCR-detection regression-fixture smoke test.
 *
 * Iterates every `ocr.json` under `tests/fixtures/pdfs/extract-public/`
 * and (best-effort) `extract/`, re-runs `analyzeOCRNeeds` with the
 * captured `config.options`, projects, and diffs against `expected`.
 * Failures throw the formatted diff block from `formatOcrDiffs(...)`.
 *
 * Lives in the smoke tier (`vitest.smoke.config.ts` / `npm run
 * test:cli-smoke`) because it depends on real MuPDF WASM.
 */
import { describe, it } from "vitest";

import {
    diffOcrSnapshots,
    formatOcrDiffs,
    mergeEffectiveOptions,
    projectOcrSnapshot,
} from "../../src/beaver-extract/debug/ocrSnapshot";
import { analyzeOCRNeeds } from "../../src/beaver-extract/node/api";
import {
    loadOcrFixtures,
    privateRoot,
    publicRoot,
    readSharedPdf,
} from "../helpers/ocrFixtureLoader";

// `loadOcrFixtures(publicRoot())` THROWS on a missing or empty public
// corpus — CI must always exercise the committed public OCR fixtures.
// The private root is best-effort.
const fixtures = [
    ...loadOcrFixtures(publicRoot()),
    ...loadOcrFixtures(privateRoot(), { skipIfMissing: true }),
];

describe("OCR detection fixtures (smoke)", () => {
    for (const f of fixtures) {
        it(`[${f.scope}] ${f.id}`, async () => {
            const pdfBytes = readSharedPdf(f.root, f.fixture.pdfSha256);
            const result = await analyzeOCRNeeds(pdfBytes, f.fixture.config.options);
            const snapshot = projectOcrSnapshot(result);
            const effectiveOptions = mergeEffectiveOptions(f.fixture.config.options);
            const diffs = diffOcrSnapshots(
                f.fixture,
                { snapshot, effectiveOptions },
                {
                    issueRatioAbs: f.fixture.tolerance.issueRatioAbs,
                    textLengthAbs: f.fixture.tolerance.textLengthAbs,
                },
            );
            if (diffs.length > 0) {
                throw new Error(formatOcrDiffs(`[${f.scope}] ${f.id}`, diffs));
            }
        });
    }
});
