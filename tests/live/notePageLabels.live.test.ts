/**
 * Live tests for note citation page-label ↔ physical-page translation
 * (v0.20 → fix-note-page-labels diff).
 *
 * The branch makes Beaver show the agent *physical* page numbers for citation
 * locators (read path) and store the document's Zotero page *label* back when a
 * locator changes (write path). Translation is driven by page labels cached in
 * `documentCache`, read best-effort via `preloadNotePageLabels`.
 *
 * Covers:
 *   1. read_note simplifier translates a stored page-label locator to its
 *      1-based physical page number when the cited attachment has cached page
 *      labels (cited by attachment key and via the regular parent item).
 *   2. Numeric-looking labels are reverse-mapped to their physical page (the
 *      core bug: label "5" must resolve to its physical page, not be treated
 *      as a 1-based index).
 *   3. Locators with no matching label, and items with no cached labels (cold
 *      cache), pass through unchanged.
 *   4. The simplification cache is keyed by a page-labels fingerprint, so the
 *      same note re-simplifies (does not serve a stale result) after the cached
 *      labels change.
 *   5. edit_note write path: changing an existing citation's physical page
 *      stores the corresponding Zotero page label in the saved note.
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
import { seedPageLabels, invalidateCache } from '../helpers/cacheInspector';
import { createNote, deleteNote, executeEditNote } from './helpers/noteTestClient';
import { SMALL_PDF, PARENT_ITEM } from '../helpers/fixtures';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

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

/** Build a native Zotero `<span class="citation" data-citation="...">` span. */
function rawCitation(opts: { key: string; locator?: string; label?: string }): string {
    const data = {
        citationItems: [{
            uris: [`http://zotero.org/users/1/items/${opts.key}`],
            locator: opts.locator ?? '',
        }],
        properties: {},
    };
    const encoded = encodeURIComponent(JSON.stringify(data));
    const inner = opts.label ?? '(Author, 2024)';
    return `<span class="citation" data-citation="${encoded}"><span class="citation-item">${inner}</span></span>`;
}

// ===========================================================================
// read_note — page-label → physical-page translation
// ===========================================================================

describe('/beaver/note/read — page-label translation', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('translates a stored page-label locator to its physical page number', async () => {
        // The 2-page PDF labels its pages "iii" / "iv" (front matter). The
        // citation stores the label "iv"; the agent should see physical page 2.
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: 'iv', label: '(Author, 2024, p. iv)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain(`id="${LIBRARY_ID}-${SMALL_PDF.zotero_key}"`);
        // Stored label "iv" → physical page 2.
        expect(content).toContain('loc="page2"');
        // The raw label must not leak through untranslated.
        expect(content).not.toContain('loc="pageiv"');
    });

    it('translates when the citation targets the regular parent item (resolved via its child PDF)', async () => {
        // PARENT_ITEM (1-IYI5SMYM) has the 2-page PDF (1-G7TTJKFH) as its child;
        // the label lookup resolves the parent to that attachment.
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: PARENT_ITEM.zotero_key, locator: 'iii', label: '(Author, 2024, p. iii)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain(`id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}"`);
        // Stored label "iii" → physical page 1.
        expect(content).toContain('loc="page1"');
        expect(content).not.toContain('loc="pageiii"');
    });

    it('reverse-maps a numeric-looking label to its physical page (not a 1-based index)', async () => {
        // Labels that look like numbers are the bug this branch fixes: label
        // "5" must map to its physical page (here page 1), never be re-treated
        // as a 1-based page index.
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: '5', 1: '6' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '5', label: '(Author, 2024, p. 5)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        // Label "5" lives on physical page 1.
        expect(content).toContain('loc="page1"');
        expect(content).not.toContain('loc="page5"');
    });

    it('leaves a locator with no matching label unchanged', async () => {
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        // "99" is not one of the document's labels — it must pass through.
        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '99', label: '(Author, 2024, p. 99)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain('loc="page99"');
    });

    it('does not translate when the cited attachment has no cached page labels', async () => {
        // Cold cache: no seeded labels. The stored locator passes through
        // verbatim (prefixed with "page"), the common production path.
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: '2', label: '(Author, 2024, p. 2)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);

        const content = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        expect(content).toContain('loc="page2"');
    });
});

// ===========================================================================
// Simplification cache is keyed by the page-labels fingerprint
// ===========================================================================

describe('/beaver/note/read — page-labels fingerprint busts the simplification cache', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('re-simplifies the same note when the cached page labels change', async () => {
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: 'iv', label: '(Author, 2024, p. iv)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);
        const noteId = `${ref.library_id}-${ref.zotero_key}`;

        // First read (labels present) → translated physical page.
        const withLabels = await readSimplified(noteId);
        expect(withLabels).toContain('loc="page2"');

        // Drop the cached labels and read again. If the simplification cache
        // ignored the page-labels fingerprint, this would wrongly return the
        // cached "page2"; with the fingerprint it re-simplifies untranslated.
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const withoutLabels = await readSimplified(noteId);
        expect(withoutLabels).toContain('loc="pageiv"');
        expect(withoutLabels).not.toContain('loc="page2"');
    });
});

// ===========================================================================
// edit_note — write path stores the Zotero page label
// ===========================================================================

describe('edit_note — physical page edit stores the Zotero page label', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('changing an existing citation page stores the matching label in the saved note', async () => {
        // Seed labels iii/iv. Cite the PDF with the stored label "iv"
        // (physical page 2). The agent edits the physical page 2 → 1, which
        // must be stored back as the page-1 label "iii".
        const seed = await seedPageLabels(SMALL_PDF.library_id, SMALL_PDF.zotero_key, { 0: 'iii', 1: 'iv' });
        expect(seed.seeded, JSON.stringify(seed)).toBe(true);

        const citation = rawCitation({ key: SMALL_PDF.zotero_key, locator: 'iv', label: '(Author, 2024, p. iv)' });
        const ref = await seedNote(`<p>Cited ${citation}.</p>`);
        const noteId = `${ref.library_id}-${ref.zotero_key}`;

        // The agent sees the citation as physical page 2; copy its exact tag.
        const content = await readSimplified(noteId);
        const tagMatch = content.match(new RegExp(`<citation id="${LIBRARY_ID}-${SMALL_PDF.zotero_key}"[^>]*/>`));
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

        // The saved note's native citation must carry the page-1 label "iii".
        const readBack = await post<{ saved_html: string; error?: string }>(
            '/beaver/test/note-read',
            { library_id: ref.library_id, zotero_key: ref.zotero_key },
        );
        expect(readBack.error).toBeFalsy();
        const decoded = decodeURIComponent(readBack.saved_html);
        expect(decoded).toContain('"locator":"iii"');
        expect(decoded).not.toContain('"locator":"iv"');
        expect(decoded).not.toContain('"locator":"1"');
    });
});
