/**
 * Live tests for the note-citation locator a `read_note` shows the agent.
 *
 * A citation's agent-visible locator is a STORED value: the simplifier projects
 * the token the citation itself carries and never consults the page-label cache.
 * That makes the projection a pure function of the note, so two reads of an
 * unchanged note agree, and a tag copied out of `read_note` matches verbatim in
 * an `edit_note`.
 *
 * Covers:
 *   1. `read_note` projects the stored locator verbatim — cached page labels for
 *      the cited PDF change nothing, whether the citation names the attachment
 *      or its regular parent item.
 *   2. `read_note` never extracts. A cited PDF with no cached extraction stays
 *      uncached after the read.
 *   3. A tag copied from a cold-cache `read_note` matches in `edit_note`.
 *   4. Write path: a citation carrying no Beaver locator key stores an edited
 *      locator exactly as the agent sent it (its locator is already a printed
 *      label, so nothing is translated into it).
 *
 * Seeding: page labels are placed in `documentCache` via the dev-only
 * `/beaver/test/cache-seed-page-labels` endpoint, which wraps the real
 * `DocumentCache.putMetadata` write path (no extraction needed).
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver loaded and authenticated.
 *   - library_id 1 marked "searchable" in Beaver preferences.
 *   - Real items at 1-G7TTJKFH (2-page PDF attachment) whose parent regular
 *     item is 1-IYI5SMYM — same items used by `helpers/fixtures.ts`.
 *
 * Run: `npm run test:live -- notePageLabels`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { seedPageLabels, invalidateCache, getCacheMetadata } from '../helpers/cacheInspector';
import { createNote, deleteNote, executeEditNote } from './helpers/noteTestClient';
import { SMALL_PDF, PARENT_ITEM } from '../helpers/fixtures';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);
// Simplified note output emits portable citation ids ("u-KEY" for the personal
// library); assertions must use the same grammar.
const LIBRARY_PREFIX = LIBRARY_ID === 1 ? 'u' : String(LIBRARY_ID);

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — note page-label live tests will be skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    for (const { library_id, zotero_key } of createdNotes) {
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
    // Always drop the seeded page-label metadata so a later test (or a real
    // extraction) starts from a clean cache for this attachment.
    if (zoteroAvailable) {
        try { await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key); } catch { /* ignore */ }
    }
});

interface ReadNoteResponse {
    success: boolean;
    error?: string;
    content?: string;
}

async function readSimplified(noteId: string): Promise<string> {
    const res = await post<ReadNoteResponse>('/beaver/note/read', { note_id: noteId });
    if (!res.success || !res.content) {
        throw new Error(`read_note failed: ${res.error ?? 'no content'}`);
    }
    return res.content;
}

async function seedNote(html: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

/**
 * Build a native Zotero `<span class="citation" data-citation="...">` span.
 *
 * `cslLabel` sets the citation item's CSL locator `label` field (e.g. "page",
 * "chapter"). The span carries no Beaver locator key, which is what a citation
 * written by hand or by another client looks like.
 */
function rawCitation(opts: { key: string; locator?: string; label?: string; cslLabel?: string }): string {
    const citationItem: Record<string, unknown> = {
        uris: [`http://zotero.org/users/1/items/${opts.key}`],
        locator: opts.locator ?? '',
    };
    if (opts.cslLabel !== undefined) citationItem.label = opts.cslLabel;
    const data = { citationItems: [citationItem], properties: {} };
    const encoded = encodeURIComponent(JSON.stringify(data));
    const inner = opts.label ?? '(Author, 2024)';
    return `<span class="citation" data-citation="${encoded}"><span class="citation-item">${inner}</span></span>`;
}

// ===========================================================================
// read_note — the stored locator is projected verbatim
// ===========================================================================

describe('/beaver/note/read — stored locators project verbatim', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('shows the stored label even when the cited PDF has cached page labels', async () => {
        // The 2-page PDF labels its pages "iii" / "iv". The citation stores the
        // label "iv"; the agent must see that label, not the physical page it
        // sits on.
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: 'iv', label: '(Author, 2024, p. iv)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain(`id="${LIBRARY_PREFIX}-${SMALL_PDF.zotero_key}"`);
        expect(content).toContain('loc="pageiv"');
        expect(content).not.toContain('loc="page2"');
    });

    it('shows the stored locator when the citation targets the regular parent item', async () => {
        // PARENT_ITEM (1-IYI5SMYM) has the 2-page PDF (1-G7TTJKFH) as its child.
        // Resolving the parent to that attachment would be the only way to reach
        // the seeded labels, and the projection does not do it.
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: PARENT_ITEM.zotero_key, locator: 'iii', label: '(Author, 2024, p. iii)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain(`id="${LIBRARY_PREFIX}-${PARENT_ITEM.zotero_key}"`);
        expect(content).toContain('loc="pageiii"');
        expect(content).not.toContain('loc="page1"');
    });

    it('leaves a numeric-looking locator alone when a label of the same name exists', async () => {
        // Label "5" sits on physical page 1. A projection that reverse-mapped
        // labels would turn the stored "5" into "1"; the stored token wins.
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: '5', 1: '6' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '5', label: '(Author, 2024, p. 5)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain('loc="page5"');
        expect(content).not.toContain('loc="page1"');
    });

    it('leaves a locator that matches no label unchanged', async () => {
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '99', label: '(Author, 2024, p. 99)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain('loc="page99"');
    });

    it('keeps read_note and edit_note matching on a cold page-label cache', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: 'iv', label: '(Author, 2024, p. iv)' });
        const ref = await seedNote(`<p>Cited cold ${citation}.</p>`);
        const noteId = `${ref.library_id}-${ref.zotero_key}`;

        const content = await readSimplified(noteId);
        expect(content).toContain(`id="${LIBRARY_PREFIX}-${SMALL_PDF.zotero_key}"`);

        const exec = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: content,
            new_string: content.replace('Cited cold', 'Cold-cache edit applied'),
        }, { timeout: 30000 });

        expect(exec.success, exec.error ?? '').toBe(true);
        expect(exec.error_code).not.toBe('old_string_not_found');
    });
});

// ===========================================================================
// read_note never extracts
//
// Reading a note must not be able to start a full PDF extraction. The locator a
// citation projects comes off the citation itself, so there is nothing in the
// read path that a cached extraction could inform — and a note citing several
// uncached PDFs would otherwise pay one extraction each, sequentially, on every
// read, validate and execute.
// ===========================================================================

describe('/beaver/note/read — does not extract cited attachments', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('leaves the cited PDF uncached when the citation has a page locator', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key)).toBeNull();

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '2', label: '(Author, 2024, p. 2)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        await readSimplified(`${ref.library_id}-${ref.zotero_key}`);

        const record = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(record, 'read_note extracted the cited PDF').toBeNull();
    });

    it('leaves the child PDF uncached when the citation targets the regular parent item', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key)).toBeNull();

        const citation = rawCitation({ key: PARENT_ITEM.zotero_key, locator: '1', label: '(Author, 2024, p. 1)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        await readSimplified(`${ref.library_id}-${ref.zotero_key}`);

        const record = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(record, 'read_note extracted the parent item\'s child PDF').toBeNull();
    });
});

// ===========================================================================
// edit_note — a note-space locator is stored as sent
// ===========================================================================

describe('edit_note — a citation without a Beaver locator key stores what it is sent', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('stores an edited locator verbatim instead of translating it to a page label', async () => {
        // Seed labels iii/iv, then cite the PDF with the plain locator "2". The
        // citation carries no Beaver locator key, so its locator is read as a
        // printed label already: an edit to "1" is stored as "1", NOT resolved
        // through the seeded labels to the page-1 label "iii".
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '2', label: '(Author, 2024, p. 2)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);
        const noteId = `${ref.library_id}-${ref.zotero_key}`;

        const content = await readSimplified(noteId);
        const tagMatch = content.match(new RegExp(`<citation id="${LIBRARY_PREFIX}-${SMALL_PDF.zotero_key}"[^>]*/>`));
        expect(tagMatch, `no citation tag in:\n${content}`).not.toBeNull();
        const oldTag = tagMatch![0];
        expect(oldTag).toContain('loc="page2"');
        const newTag = oldTag.replace('loc="page2"', 'loc="page1"');

        const exec = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: oldTag,
            new_string: newTag,
        }, { timeout: 20000 });
        expect(exec.success, exec.error ?? '').toBe(true);

        const readBack = await post<{ saved_html: string; error?: string }>(
            '/beaver/test/note-read',
            { library_id: ref.library_id, zotero_key: ref.zotero_key },
        );
        expect(readBack.error).toBeFalsy();
        const decoded = decodeURIComponent(readBack.saved_html);
        expect(decoded).toContain('"locator":"1"');
        expect(decoded).not.toContain('"locator":"iii"');
        expect(decoded).not.toContain('"locator":"2"');
    });
});
