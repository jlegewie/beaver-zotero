/**
 * Regression test: the bundled MuPDF worker must NOT include any non-worker-
 * safe symbols. Pulling the `src/services/pdf/index.ts` barrel would drag in
 * `MuPDFService`, `MuPDFWorkerClient`, `getPref` (`Zotero.Prefs`), the
 * webpack-only `react/store`, etc. — any of which crashes the worker at boot
 * because `Zotero` / `window` / `Zotero.Prefs` don't exist in worker scope.
 *
 * The test reads the build output and fails if any forbidden string appears.
 * Skips gracefully if the build hasn't been run (lets `npm test` work in CI
 * without a prior `npm run build:dev`).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_BUNDLE = resolve(
    __dirname,
    '../../../.scaffold/build/addon/content/scripts/mupdf-worker.js',
);

// Strings that prove the wrong module slipped into the bundle. These are
// chosen to be specific enough that they don't appear coincidentally in the
// analyzer code (e.g. `getPref` is the prefs helper name; analyzers don't
// use it). Update this list if the codebase introduces a new
// definitively-non-worker-safe identifier.
const FORBIDDEN_SYMBOLS = [
    'MuPDFService',           // the main-thread MuPDF wrapper
    'getPref',                // Zotero.Prefs accessor in src/utils/prefs.ts
    'Zotero.Prefs',           // direct prefs access
    'useHttpEndpoints',       // webpack-only React hook
    'react/store',            // webpack-only Jotai store
];

describe('mupdf-worker.js bundle', () => {
    const buildExists = existsSync(WORKER_BUNDLE);

    // We deliberately do NOT silently skip when the build is missing —
    // pre-PR-#3 review feedback noted that `skipIf(!buildExists)` made the
    // regression net dev-only. Surface a clear "build first" message so a
    // bare `npm test` run reports the missing prerequisite instead of
    // appearing green.
    //
    // TODO: ideally CI should run `npm run build:dev` before unit tests so
    // this assertion runs unconditionally. Adding the build to the CI
    // pre-step is out of scope here; track via a follow-up.
    if (!buildExists) {
        it.fails(
            'requires a build — run `npm run build:dev` first (worker bundle missing)',
            () => {
                throw new Error(
                    `Worker bundle not found at ${WORKER_BUNDLE}. ` +
                        'Run `npm run build:dev` before this test to verify ' +
                        'that no forbidden symbols leaked into the worker bundle.',
                );
            },
        );
        return;
    }

    it('does not pull in the src/services/pdf/index.ts barrel', () => {
        const source = readFileSync(WORKER_BUNDLE, 'utf-8');
        for (const sym of FORBIDDEN_SYMBOLS) {
            expect(
                source.includes(sym),
                `Worker bundle contains forbidden symbol "${sym}". ` +
                    'A worker file probably imported from "../index" or ' +
                    'something that transitively pulls in MuPDFWorkerClient / ' +
                    'MuPDFService / Zotero.Prefs. Worker files must import ' +
                    'analyzers and types directly:\n' +
                    '  import { StyleAnalyzer } from "../StyleAnalyzer";\n' +
                    '  import type { ExtractionResult } from "../types";\n',
            ).toBe(false);
        }
    });

    it('preserves the chrome:// WASM factory URL (dynamic import survived bundling)', () => {
        const source = readFileSync(WORKER_BUNDLE, 'utf-8');
        expect(source).toContain('chrome://beaver/content/lib/mupdf-wasm.mjs');
        expect(source).toContain('chrome://beaver/content/lib/mupdf-wasm.wasm');
    });
});
