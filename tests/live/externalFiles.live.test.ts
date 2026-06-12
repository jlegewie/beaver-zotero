/**
 * External-file live suite (`ext-<KEY>` ids served from the managed copy).
 *
 * Exercises the external-file branch of the unified document request path
 * against a running Zotero:
 *   - dev-endpoint attach: copy into the managed folder + registry row
 *   - PDF extraction (markdown + structured mode) with sentinel cache ref
 *     (libraryId -1), including the warm cache hit on a second read
 *   - EPUB extraction via the shared EPUB pipeline
 *   - text files read directly from the copy
 *   - image files rejected at document-request time (use view tool instead)
 *   - the "attached on a different computer" file_missing error once the
 *     managed copy is deleted
 *   - unknown ext keys return file_missing
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *
 * Run with: `npm run test:live -- externalFiles`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { getCacheMetadata } from '../helpers/cacheInspector';
import {
    attachExternalFileForTest,
    deleteExternalFileForTest,
    fetchExternalFileDocument,
} from '../helpers/zoteroHttpClient';

// Minimal 1x1 transparent PNG — used to exercise the image content-kind path.
const MINIMAL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=',
    'base64',
);

const FIXTURE_PDF = resolve(__dirname, '../fixtures/pdfs/extract-public/legewie-fagan__p0/source.pdf');
const FIXTURE_EPUB = resolve(__dirname, '../fixtures/epubs/image-only.epub');
const EXTRACT_OPTS = { timeout: 90_000 } as const;

let available = false;
let tmpDir: string;
const attachedKeys: string[] = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
    tmpDir = mkdtempSync(join(tmpdir(), 'beaver-ext-files-'));
});

afterAll(async () => {
    if (available) {
        for (const key of attachedKeys) {
            await deleteExternalFileForTest(key).catch(() => undefined);
        }
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

async function attach(path: string): Promise<{ extKey: string; storedPath: string; filename: string }> {
    const response = await attachExternalFileForTest(path);
    if (!response.ok || !response.record) {
        throw new Error(`attach failed: ${response.reason} ${response.error}`);
    }
    attachedKeys.push(response.record.extKey);
    return response.record;
}

describe('external files (live)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('attaches a PDF and serves it through the document request path', async () => {
        const record = await attach(FIXTURE_PDF);
        expect(record.extKey).toMatch(/^[A-Z0-9]{8}$/);

        const response = await fetchExternalFileDocument(record.extKey, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(response.error ?? null).toBeNull();
        expect(response.external_file_key).toBe(record.extKey);
        expect(response.resolved_attachment ?? null).toBeNull();
        expect(response.content_kind).toBe('pdf');
        expect(response.result?.document.pageCount).toBeGreaterThan(0);

        // The result is cached under the sentinel library id (-1).
        const metadata = await getCacheMetadata(-1, record.extKey);
        expect(metadata?.libraryId).toBe(-1);
        expect(metadata?.zoteroKey).toBe(record.extKey);

        // Second read hits the cache and returns the identical document.
        const second = await fetchExternalFileDocument(record.extKey, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(second.error ?? null).toBeNull();
        expect(second.result?.document.pageCount).toBe(response.result?.document.pageCount);
    }, 120_000);

    it('deduplicates identical content to one key and one copy', async () => {
        const first = await attach(FIXTURE_PDF);
        const second = await attach(FIXTURE_PDF);
        expect(second.extKey).toBe(first.extKey);
        expect(second.storedPath).toBe(first.storedPath);

        // Identical bytes under a different name still reuse the record,
        // refreshed to the latest filename.
        const renamedPath = join(tmpDir, 'renamed-copy.pdf');
        copyFileSync(FIXTURE_PDF, renamedPath);
        const third = await attach(renamedPath);
        expect(third.extKey).toBe(first.extKey);
        expect(third.filename).toBe('renamed-copy.pdf');
    }, 60_000);

    it('reads text files directly from the managed copy', async () => {
        const textPath = join(tmpDir, 'notes.md');
        writeFileSync(textPath, '# Heading\n\nalpha beta gamma\n');
        const record = await attach(textPath);

        const response = await fetchExternalFileDocument(record.extKey, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(response.error ?? null).toBeNull();
        expect(response.content_kind).toBe('text');
        expect(response.external_file_key).toBe(record.extKey);
    }, 60_000);

    it('rejects unsupported file types at attach time', async () => {
        const docxPath = join(tmpDir, 'report.docx');
        writeFileSync(docxPath, 'not really a docx');
        const response = await attachExternalFileForTest(docxPath);
        expect(response.ok).toBe(false);
        expect(response.reason).toBe('unsupported_type');
    }, 30_000);

    it('returns the different-computer error when the copy is missing', async () => {
        const textPath = join(tmpDir, 'ephemeral.txt');
        writeFileSync(textPath, 'short lived');
        const record = await attach(textPath);

        // Delete the managed copy but keep the registry row.
        const win = await deleteExternalFileForTest(record.extKey, true);
        expect(win.ok).toBe(true);

        const response = await fetchExternalFileDocument(record.extKey, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('not available on this device');
    }, 60_000);

    it('returns file_missing for an unknown external file key', async () => {
        const response = await fetchExternalFileDocument('XXXXXXXX', { mode: 'markdown' }, EXTRACT_OPTS);
        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('not available on this device');
    }, 30_000);

    it('returns structured-mode extraction for an attached PDF', async () => {
        const record = await attach(FIXTURE_PDF);

        const response = await fetchExternalFileDocument(record.extKey, { mode: 'structured' }, EXTRACT_OPTS);
        expect(response.error ?? null).toBeNull();
        expect(response.content_kind).toBe('pdf');
        expect(response.external_file_key).toBe(record.extKey);
        expect(response.result?.document.pageCount).toBeGreaterThan(0);
    }, 120_000);

    it('rejects image files at document-request time with unsupported_type', async () => {
        const pngPath = join(tmpDir, 'image.png');
        writeFileSync(pngPath, MINIMAL_PNG);
        const record = await attach(pngPath);
        expect(record.contentKind).toBe('image');

        const response = await fetchExternalFileDocument(record.extKey, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(response.error_code).toBe('unsupported_type');
        expect(response.error).toContain('view tool');
    }, 30_000);

    it('routes an attached EPUB through the EPUB pipeline (image-only fixture returns no_text_layer)', async () => {
        const record = await attach(FIXTURE_EPUB);
        expect(record.contentKind).toBe('epub');

        const response = await fetchExternalFileDocument(record.extKey, { mode: 'markdown' }, EXTRACT_OPTS);
        // The EPUB code path was taken: external_file_key and content_kind are set regardless of outcome.
        expect(response.external_file_key).toBe(record.extKey);
        expect(response.content_kind).toBe('epub');
        // The fixture is image-only, so the extractor returns no_text_layer — that is correct behavior.
        expect(['no_text_layer', null]).toContain(response.error_code ?? null);
    }, 120_000);
});
