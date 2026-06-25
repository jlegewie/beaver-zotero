/**
 * External-file view-images live suite.
 *
 * Exercises the `handleExternalFileViewRequest` path inside
 * `handleZoteroViewImagesRequest` against a running Zotero, accessed via the
 * dev-only `/beaver/test/external-file-view-images` HTTP endpoint.
 *
 * Scenarios covered:
 *   - PDF: renders a page-range from an attached external PDF
 *   - PDF: multi-page range returns the correct image count
 *   - Image: serves an attached PNG as a single viewable image
 *   - EPUB: returns unsupported_type (not a viewable format)
 *   - Text: returns unsupported_type (not a viewable format)
 *   - Unknown key: returns file_missing
 *   - Missing managed copy: returns file_missing after the copy is deleted
 *   - Invalid page range: returns invalid_page_value
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *
 * Run with: `npm run test:live -- externalFileViewImages`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    attachExternalFileForTest,
    deleteExternalFileForTest,
    viewExternalFileImages,
} from '../helpers/zoteroHttpClient';

const FIXTURE_PDF = resolve(__dirname, '../fixtures/pdfs/extract-public/legewie-fagan__p0/source.pdf');
const FIXTURE_EPUB = resolve(__dirname, '../fixtures/epubs/image-only.epub');
// A real PNG from the project docs (tested decodable by Zotero's createImageBitmap).
const FIXTURE_PNG = resolve(__dirname, '../../docs/litqa2-accuracy-preview.png');
const VIEW_OPTS = { timeout: 90_000 } as const;

let available = false;
let tmpDir: string;
const attachedKeys: string[] = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) console.warn('\n⚠  Zotero not available — live tests will be skipped.\n');
    tmpDir = mkdtempSync(join(tmpdir(), 'beaver-view-images-'));
});

afterAll(async () => {
    if (available) {
        for (const key of attachedKeys) {
            await deleteExternalFileForTest(key).catch(() => undefined);
        }
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

async function attach(path: string) {
    const response = await attachExternalFileForTest(path);
    if (!response.ok || !response.record) {
        throw new Error(`attach failed: ${response.reason} ${response.error}`);
    }
    attachedKeys.push(response.record.extKey);
    return response.record;
}

describe('external file view images (live)', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('renders page 1 of an attached external PDF', async () => {
        const record = await attach(FIXTURE_PDF);

        const response = await viewExternalFileImages(record.extKey, { start_page: 1, end_page: 1 }, VIEW_OPTS);
        expect(response.error ?? null).toBeNull();
        expect(response.kind).toBe('pdf');
        expect(response.external_file_key).toBe(record.extKey);
        expect(response.images).toHaveLength(1);
        expect(response.images![0].image_data.length).toBeGreaterThan(0);
        expect(response.images![0].page_number).toBe(1);
        expect(response.total_pages).toBeGreaterThan(0);
    }, 120_000);

    it('clamps page range to document length (single-page fixture + range 1-3 returns 1 image)', async () => {
        const record = await attach(FIXTURE_PDF);

        // The fixture is a single-page PDF; requesting pages 1-3 should clamp to 1 image.
        const response = await viewExternalFileImages(record.extKey, { start_page: 1, end_page: 3 }, VIEW_OPTS);
        expect(response.error ?? null).toBeNull();
        expect(response.kind).toBe('pdf');
        expect(response.total_pages).toBe(1);
        expect(response.images).toHaveLength(response.total_pages!);
        expect(response.images![0].page_number).toBe(1);
    }, 120_000);

    it('serves an attached PNG as a single viewable image', async () => {
        const pngPath = join(tmpDir, 'photo.png');
        copyFileSync(FIXTURE_PNG, pngPath);
        const record = await attach(pngPath);
        expect(record.contentKind).toBe('image');

        const response = await viewExternalFileImages(record.extKey, {}, VIEW_OPTS);
        expect(response.error ?? null).toBeNull();
        expect(response.kind).toBe('image');
        expect(response.external_file_key).toBe(record.extKey);
        expect(response.images).toHaveLength(1);
        expect(response.images![0].image_data.length).toBeGreaterThan(0);
        expect(response.total_pages).toBeNull();
    }, 60_000);

    it('returns unsupported_type for an attached EPUB', async () => {
        const record = await attach(FIXTURE_EPUB);
        expect(record.contentKind).toBe('epub');

        const response = await viewExternalFileImages(record.extKey, {}, VIEW_OPTS);
        expect(response.error_code).toBe('unsupported_type');
        expect(response.error).toContain('read tool');
    }, 30_000);

    it('returns unsupported_type for an attached text file', async () => {
        const textPath = join(tmpDir, 'doc.txt');
        writeFileSync(textPath, 'just some text content');
        const record = await attach(textPath);
        expect(record.contentKind).toBe('text');

        const response = await viewExternalFileImages(record.extKey, {}, VIEW_OPTS);
        expect(response.error_code).toBe('unsupported_type');
        expect(response.error).toContain('read tool');
    }, 30_000);

    it('returns file_missing for an unknown external file key', async () => {
        const response = await viewExternalFileImages('XXXXXXXX', {}, VIEW_OPTS);
        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('not available on this device');
    }, 30_000);

    it('returns file_missing when the managed copy has been deleted', async () => {
        const pdfCopyPath = join(tmpDir, 'deletable.pdf');
        const { copyFileSync } = await import('node:fs');
        copyFileSync(FIXTURE_PDF, pdfCopyPath);
        const record = await attach(pdfCopyPath);

        // Delete the managed copy but keep the registry row.
        await deleteExternalFileForTest(record.extKey, true);

        const response = await viewExternalFileImages(record.extKey, { start_page: 1 }, VIEW_OPTS);
        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('not available on this device');
    }, 60_000);

    it('returns invalid_page_value for an inverted page range', async () => {
        const record = await attach(FIXTURE_PDF);

        const response = await viewExternalFileImages(record.extKey, { start_page: 5, end_page: 2 }, VIEW_OPTS);
        expect(response.error_code).toBe('invalid_page_value');
    }, 30_000);

    it('returns invalid_page_value for a zero start_page', async () => {
        const record = await attach(FIXTURE_PDF);

        const response = await viewExternalFileImages(record.extKey, { start_page: 0 }, VIEW_OPTS);
        expect(response.error_code).toBe('invalid_page_value');
    }, 30_000);
});
