/**
 * Slow MuPDF + Node API smoke. Loads the real fixture PDF, runs the
 * three v1 commands the CLI is built around (info, structured extract,
 * analyze-layout), and asserts shape only.
 *
 * Deliberately not in `npm test` — the WASM init + per-page extract is
 * environment-sensitive and slower than the rest of the unit tier.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
    analyzeLayout,
    extractPdf,
    getMetadata,
    getPageCount,
} from '../../src/services/pdf/node/api';
import { SMOKE_PDF, smokePdfExists } from './_helpers';

describe.runIf(smokePdfExists())('Node API (smoke)', () => {
    it('reports page count + metadata for the smoke fixture', async () => {
        const bytes = new Uint8Array(await readFile(SMOKE_PDF));
        const [{ count }, metadata] = await Promise.all([
            getPageCount(bytes),
            getMetadata(bytes),
        ]);
        expect(count).toBeGreaterThan(0);
        expect(metadata.pageCount).toBe(count);
        expect(typeof metadata.title === 'string' || metadata.title === undefined).toBe(true);
    });

    it('runs structured extraction on page 0 and emits at least one page', async () => {
        const bytes = new Uint8Array(await readFile(SMOKE_PDF));
        const result = await extractPdf({
            pdfData: bytes,
            mode: 'structured',
            pageIndices: [0],
        });
        expect(result.pages).toHaveLength(1);
        expect(result.pages[0].index).toBe(0);
        expect(result.pages[0].width).toBeGreaterThan(0);
        expect(result.pages[0].height).toBeGreaterThan(0);
        // Structured mode populates DocItems plus a flattened sentence view.
        expect(Array.isArray(result.pages[0].sentences)).toBe(true);
        expect(Array.isArray(result.pages[0].items)).toBe(true);
    });

    it('runs analyzeLayout on page 0 and reports at least one analysis page', async () => {
        const bytes = new Uint8Array(await readFile(SMOKE_PDF));
        const result = await analyzeLayout({
            pdfData: bytes,
            pageIndices: [0],
        });
        expect(result.analysisPageIndices.length).toBeGreaterThan(0);
        expect(result.analysisPageIndices).toContain(0);
        // `Map`/`Set` fields are present and structurally correct.
        expect(result.analysis.styleProfile.styleCounts).toBeInstanceOf(Map);
        expect(result.analysis.marginRemoval.removalsByPage).toBeInstanceOf(Map);
        expect(result.analysis.marginRemoval.textsToRemove).toBeInstanceOf(Set);
    });
});
