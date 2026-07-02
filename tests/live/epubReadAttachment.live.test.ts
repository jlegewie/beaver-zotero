/**
 * MCP `read_attachment` EPUB live suite (`/beaver/test/read-attachment`).
 *
 * Covers the EPUB branch of the MCP `read_attachment` tool handler, which
 * groups extracted EPUB items by their stamped page number:
 *   - read header reports the extracted page count and wraps requested pages in
 *     `<pageN>` tags
 *   - page-window slicing via `start_page`/`end_page` (1-based ordinals)
 *   - markdown rendering: section headers become `#` heading lines
 *   - out-of-range start page → MCP error naming the extracted page count
 *   - text attachments (content_kind `text`) are rejected as an unsupported
 *     document format
 *
 * PDF behavior of the same tool is covered in `documentCache.live.test.ts`.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Fixture attachments seeded (NON_PDF — a multi-section EPUB with heading
 *     markup, TEXT_ATTACHMENT).
 *
 * Run with: `npm run test:live -- epubReadAttachment`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    invalidateCache,
    isMcpToolError,
    readAttachment,
    type ReadAttachmentResult,
} from '../helpers/cacheInspector';
import { fetchDocument } from '../helpers/zoteroHttpClient';
import { NON_PDF, TEXT_ATTACHMENT, type AttachmentFixture } from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

// First read may extract on a cold cache; subsequent reads are cache-served.
const EXTRACT_TIMEOUT = 90_000;

function attachmentId(fix: AttachmentFixture): string {
    return `${fix.library_id}-${fix.zotero_key}`;
}

/** Narrow a read_attachment result to its success string, failing otherwise. */
function expectText(result: ReadAttachmentResult): string {
    if (isMcpToolError(result)) {
        throw new Error(`Expected success, got MCP error: ${result.content[0]?.text}`);
    }
    expect(typeof result).toBe('string');
    return result;
}

/** Narrow a read_attachment result to its MCP error message, failing otherwise. */
function expectErrorMessage(result: ReadAttachmentResult): string {
    if (!isMcpToolError(result)) {
        throw new Error(`Expected an MCP error, got success: ${String(result).slice(0, 120)}`);
    }
    return result.content[0]?.text ?? '';
}

/** Page count of the EPUB fixture, resolved once through the document path. */
let pageCountPromise: Promise<number> | null = null;
function getPageCount(): Promise<number> {
    pageCountPromise ??= (async () => {
        const res = await fetchDocument(NON_PDF, { mode: 'markdown' }, { timeout: EXTRACT_TIMEOUT });
        const count = (res.result as any)?.pageCount;
        if (typeof count !== 'number' || count < 1) {
            throw new Error(`EPUB fixture must extract to at least 1 page, got ${count}`);
        }
        return count;
    })();
    return pageCountPromise;
}

describe('MCP read_attachment over an EPUB', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns EPUB pages wrapped in <pageN> tags with an extracted page-count header', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);
        pageCountPromise = null;
        const pageCount = await getPageCount();
        const endPage = Math.min(pageCount, 2);

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: 1,
            end_page: endPage,
        });
        const text = expectText(result);

        expect(text).toContain(`Attachment: ${attachmentId(NON_PDF)}`);
        expect(text).toContain(`Total pages: ${pageCount}`);
        expect(text).toContain(`Showing pages 1-${endPage}`);
        expect(text).toContain('<page1>');
        expect(text).toContain('</page1>');
        expect(text).toContain(`<page${endPage}>`);
    }, EXTRACT_TIMEOUT);

    it('slices to the requested page window', async () => {
        const pageCount = await getPageCount();
        const startPage = Math.min(4, pageCount);
        const endPage = Math.min(startPage + 1, pageCount);

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: startPage,
            end_page: endPage,
        });
        const text = expectText(result);

        expect(text).toContain(`Showing pages ${startPage}-${endPage}`);
        expect(text).toContain(`<page${startPage}>`);
        expect(text).toContain(`<page${endPage}>`);
        if (startPage > 1) expect(text).not.toContain(`<page${startPage - 1}>`);
        if (endPage < pageCount) expect(text).not.toContain(`<page${endPage + 1}>`);
    }, EXTRACT_TIMEOUT);

    it('renders section headers as markdown headings', async () => {
        const pageCount = await getPageCount();

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: 1,
            end_page: pageCount,
        });
        const text = expectText(result);

        // The EPUB fixture contains section_header items, which the tool
        // renders as `#`-prefixed markdown heading lines.
        expect(text).toMatch(/^#{1,6} \S/m);
    }, EXTRACT_TIMEOUT);

    it('reports an out-of-range start page', async () => {
        const pageCount = await getPageCount();

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: pageCount + 100,
        });
        const message = expectErrorMessage(result);
        expect(message).toMatch(/out of range/i);
        expect(message).toContain(`attachment has ${pageCount} pages`);
    }, EXTRACT_TIMEOUT);

    it('rejects a text attachment as an unsupported document format', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(TEXT_ATTACHMENT),
        });
        expect(expectErrorMessage(result)).toBe(
            'Attachment read returned an unsupported document format.',
        );
    }, EXTRACT_TIMEOUT);
});
