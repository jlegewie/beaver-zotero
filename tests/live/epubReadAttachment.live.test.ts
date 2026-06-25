/**
 * MCP `read_attachment` EPUB live suite (`/beaver/test/read-attachment`).
 *
 * Covers the EPUB branch of the MCP `read_attachment` tool handler, which
 * converts an extracted EPUB document into per-section markdown "pages":
 *   - whole-document read: header reports the section count as the total page
 *     count and each section is wrapped in `<pageN>` tags
 *   - section-window slicing via `start_page`/`end_page` (1-based ordinals)
 *   - markdown rendering: section headers become `#` heading lines
 *   - out-of-range start section → MCP error naming the section count
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

/** Section count of the EPUB fixture, resolved once through the document path. */
let sectionCountPromise: Promise<number> | null = null;
function getSectionCount(): Promise<number> {
    sectionCountPromise ??= (async () => {
        const res = await fetchDocument(NON_PDF, { mode: 'markdown' }, { timeout: EXTRACT_TIMEOUT });
        const count = (res.result as any)?.sectionCount;
        if (typeof count !== 'number' || count < 4) {
            throw new Error(`EPUB fixture must extract to >= 4 sections, got ${count}`);
        }
        return count;
    })();
    return sectionCountPromise;
}

describe('MCP read_attachment over an EPUB', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns EPUB sections wrapped in <pageN> tags with a section-count header', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);
        sectionCountPromise = null;
        const sectionCount = await getSectionCount();

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: 1,
            end_page: sectionCount,
        });
        const text = expectText(result);

        expect(text).toContain(`Attachment: ${attachmentId(NON_PDF)}`);
        expect(text).toContain(`Total pages: ${sectionCount}`);
        expect(text).toContain(`Showing pages 1-${sectionCount}`);
        expect(text).toContain('<page1>');
        expect(text).toContain('</page1>');
        expect(text).toContain(`<page${sectionCount}>`);
    }, EXTRACT_TIMEOUT);

    it('slices to the requested section window', async () => {
        await getSectionCount();

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: 4,
            end_page: 5,
        });
        const text = expectText(result);

        expect(text).toContain('Showing pages 4-5');
        expect(text).toContain('<page4>');
        expect(text).toContain('<page5>');
        expect(text).not.toContain('<page3>');
        expect(text).not.toContain('<page6>');
    }, EXTRACT_TIMEOUT);

    it('renders section headers as markdown headings', async () => {
        const sectionCount = await getSectionCount();

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: 1,
            end_page: sectionCount,
        });
        const text = expectText(result);

        // The EPUB fixture contains section_header items, which the tool
        // renders as `#`-prefixed markdown heading lines.
        expect(text).toMatch(/^#{1,6} \S/m);
    }, EXTRACT_TIMEOUT);

    it('reports an out-of-range start section', async () => {
        const sectionCount = await getSectionCount();

        const result = await readAttachment({
            attachment_id: attachmentId(NON_PDF),
            start_page: sectionCount + 100,
        });
        const message = expectErrorMessage(result);
        expect(message).toMatch(/out of range/i);
        expect(message).toContain(`attachment has ${sectionCount} pages`);
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
