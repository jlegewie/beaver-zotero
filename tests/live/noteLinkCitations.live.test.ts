/**
 * Live tests for note & annotation link citations in `/beaver/note/read`
 * (v0.20 → feat-annotations-citations-in-notes diff).
 *
 * The feature lets a note body cite *other notes* and *PDF annotations* via
 * plain `zotero://` anchors:
 *   - `<a href="zotero://select/library/items/<noteKey>">…</a>`            (note)
 *   - `<a href="zotero://open-pdf/<seg>/items/<attachKey>?annotation=K">…` (annotation)
 *
 * On read, `simplifyNoteHtml` rewrites those anchors into unified
 * `<citation id="LIB-KEY"/>` tags and `resolveCitedItems` resolves them into
 * `cited_items` entries — notes carry a `preview`, annotations carry
 * `annotation_text` / `annotation_comment` / `page_label` / `parent_key`.
 *
 * WHY THESE NEED A LIVE RUN (not just the unit suite):
 *   `normalizeNoteHtml` round-trips note HTML through Zotero's *chrome*
 *   HTMLDocument, which silently DROPS `href` attributes whose scheme is
 *   `zotero://` on innerHTML parse. The new shield/restore logic in
 *   `prosemirror/normalize.ts` only matters against that real chrome document
 *   — jsdom (unit tests) preserves the hrefs trivially, so the unit tests
 *   never exercise the bug the shield fixes. These live tests confirm the
 *   anchors survive the real round-trip and become citations end-to-end.
 *
 * Covers:
 *   1. Note `zotero://select` link → `<citation>` tag + note `cited_items`
 *      (item_type 'note', title, preview with the heading stripped).
 *   2. Annotation `zotero://open-pdf?annotation=` link → `<citation>` tag +
 *      annotation `cited_items` (annotation_text/comment, page_label,
 *      parent_key = the host attachment's key).
 *   3. Internal `zotero://beaver/*` links are NOT turned into citations and
 *      survive as plain anchors.
 *   4. A `zotero://select` link to a non-existent key still emits a citation
 *      tag but is filtered out of `cited_items` (unresolved → dropped).
 *   5. Mixed regular-item + note + annotation citations resolve together in
 *      first-seen document order with the correct item_type for each.
 *   6. WRITE path: an `edit_note` that inserts `<citation id="LIB-NOTEKEY"/>`
 *      expands to a `zotero://select` anchor (via `noteCitationExpand`) and
 *      persists it into the saved note HTML — surviving the save-path
 *      normalize round-trip.
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver loaded and authenticated.
 *   - library_id 1 (user library) marked "searchable" in Beaver.
 *   - Fixtures present: 1-IYI5SMYM (regular item, `PARENT_ITEM`) and
 *     1-2YWA8DTZ (PDF attachment with cached geometry, `NORMAL_PDF`).
 *
 * Run: `npx vitest run --config vitest.live.config.ts tests/live/noteLinkCitations.live.test.ts`
 *      (or `npm run test:live -- noteLinkCitations`)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import {
    createNote,
    deleteNote,
    executeEditNote,
    readNote as readSavedNote,
} from './helpers/noteTestClient';
import { NORMAL_PDF, PARENT_ITEM } from '../helpers/fixtures';
import { CoordOrigin } from '../../react/types/citations';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];
const createdItemIds: string[] = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — note/annotation link-citation live tests skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    for (const { library_id, zotero_key } of createdNotes) {
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
    if (createdItemIds.length > 0) {
        try { await post('/beaver/delete-items', { item_ids: [...createdItemIds] }); } catch { /* ignore */ }
        createdItemIds.length = 0;
    }
});

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface CitedItem {
    library_id: number;
    zotero_key: string;
    item_type?: string | null;
    title?: string | null;
    preview?: string | null;
    annotation_text?: string | null;
    annotation_comment?: string | null;
    page_label?: string | null;
    parent_key?: string | null;
}

interface ReadNoteResponse {
    success: boolean;
    error?: string;
    note_id?: string;
    content?: string;
    cited_items?: CitedItem[];
}

interface AnnotationCreateResponse {
    ok: boolean;
    reference?: { library_id: number; zotero_key: string };
    annotation?: {
        zotero_key: string;
        annotationText: string;
        annotationComment: string;
        annotationPageLabel: string;
    };
    error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readNote(noteId: string): Promise<ReadNoteResponse> {
    return post<ReadNoteResponse>('/beaver/note/read', { note_id: noteId });
}

function citedItemId(item: CitedItem): string {
    return `${item.library_id}-${item.zotero_key}`;
}

async function seedNote(html: string, title?: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html, title });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

/** Create a real highlight annotation on a PDF fixture and register it for teardown. */
async function seedHighlightAnnotation(opts: {
    text: string;
    comment?: string;
}): Promise<{ key: string; pageLabel: string; text: string; comment: string }> {
    const res = await post<AnnotationCreateResponse>(
        '/beaver/test/annotation-create',
        {
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
            type: 'highlight',
            input: {
                pageIndex: 0,
                boxes: [{ l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT }],
                text: opts.text,
                color: 'yellow',
                comment: opts.comment ?? '',
            },
        },
        { timeout: 30000 },
    );
    if (!res.ok || !res.reference || !res.annotation) {
        throw new Error(`seedHighlightAnnotation failed: ${res.error ?? 'unknown'}`);
    }
    createdItemIds.push(`${res.reference.library_id}-${res.reference.zotero_key}`);
    return {
        key: res.reference.zotero_key,
        pageLabel: res.annotation.annotationPageLabel,
        text: res.annotation.annotationText,
        comment: res.annotation.annotationComment,
    };
}

/** Build a native Zotero `<span class="citation">` for a regular item. */
function rawCitation(opts: { key: string; libraryUserId?: number; label?: string }): string {
    const data = {
        citationItems: [{
            uris: [`http://zotero.org/users/${opts.libraryUserId ?? 1}/items/${opts.key}`],
            locator: '',
        }],
        properties: {},
    };
    const encoded = encodeURIComponent(JSON.stringify(data));
    const inner = opts.label ?? '(Author, 2024)';
    return `<span class="citation" data-citation="${encoded}"><span class="citation-item">${inner}</span></span>`;
}

// ===========================================================================
// Note link citations
// ===========================================================================

describe('/beaver/note/read — note link citations', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('rewrites a zotero://select note link into a <citation> tag', async () => {
        const target = await seedNote('<p>Body of the cited note about migration patterns.</p>', 'Migration Notes');
        const link = `<a href="zotero://select/library/items/${target.zotero_key}">Note: Migration Notes</a>`;
        const source = await seedNote(`<p>See earlier (${link}) for context.</p>`);

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        // The zotero:// href survived the real chrome-document normalize
        // round-trip (shield/restore) and the simplifier rewrote it.
        expect(res.content).toContain(`<citation id="${LIBRARY_ID}-${target.zotero_key}"`);
        expect(res.content).toMatch(/<citation [^>]*\blabel="Note: Migration Notes"/);
        // The raw anchor must NOT leak into the agent-visible content.
        expect(res.content).not.toContain('zotero://select');
    });

    it('resolves the cited note into cited_items with type, title and preview', async () => {
        const target = await seedNote('<p>Body of the cited note about migration patterns.</p>', 'Migration Notes');
        const link = `<a href="zotero://select/library/items/${target.zotero_key}">Note: Migration Notes</a>`;
        const source = await seedNote(`<p>See earlier (${link}).</p>`);

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const cited = (res.cited_items ?? []).find((c) => citedItemId(c) === `${LIBRARY_ID}-${target.zotero_key}`);
        expect(cited).toBeTruthy();
        expect(cited!.item_type).toBe('note');
        expect(cited!.title).toBe('Migration Notes');
        // Preview is derived from the cited note's body with the heading
        // stripped, so it reflects the body and not the title.
        expect(cited!.preview).toContain('migration patterns');
        expect(cited!.preview).not.toContain('Migration Notes');
    });
});

// ===========================================================================
// Annotation link citations
// ===========================================================================

describe('/beaver/note/read — annotation link citations', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('rewrites a zotero://open-pdf annotation link into a <citation> tag', async () => {
        const annotation = await seedHighlightAnnotation({ text: 'a highlighted passage', comment: 'reviewer note' });
        const link = `<a href="zotero://open-pdf/library/items/${NORMAL_PDF.zotero_key}?annotation=${annotation.key}">Annotation in Source, page ${annotation.pageLabel}</a>`;
        const source = await seedNote(`<p>As highlighted (${link}) here.</p>`);

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        expect(res.content).toContain(`<citation id="${LIBRARY_ID}-${annotation.key}"`);
        expect(res.content).not.toContain('zotero://open-pdf');
    });

    it('resolves the cited annotation into cited_items with annotation fields', async () => {
        const annotation = await seedHighlightAnnotation({ text: 'a highlighted passage', comment: 'reviewer note' });
        const link = `<a href="zotero://open-pdf/library/items/${NORMAL_PDF.zotero_key}?annotation=${annotation.key}">Annotation, page ${annotation.pageLabel}</a>`;
        const source = await seedNote(`<p>As highlighted (${link}).</p>`);

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const cited = (res.cited_items ?? []).find((c) => citedItemId(c) === `${LIBRARY_ID}-${annotation.key}`);
        expect(cited).toBeTruthy();
        expect(cited!.item_type).toBe('annotation');
        expect(cited!.annotation_text).toBe(annotation.text);
        expect(cited!.annotation_comment).toBe(annotation.comment);
        expect(cited!.page_label).toBe(annotation.pageLabel);
        // parent_key is the host PDF *attachment* key (the annotation's direct
        // parent), not the regular bibliographic item.
        expect(cited!.parent_key).toBe(NORMAL_PDF.zotero_key);
        // The title falls back to the annotation snippet.
        expect(cited!.title).toContain(annotation.text);
    });
});

// ===========================================================================
// Internal links & unresolved keys
// ===========================================================================

describe('/beaver/note/read — internal links and unresolved keys', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('does not turn internal zotero://beaver links into citations', async () => {
        const link = '<a href="zotero://beaver/thread/abc123">thread</a>';
        const source = await seedNote(`<p>Internal (${link}) link.</p>`);

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        // The internal link survives normalization but is NOT a citation.
        expect(res.content).not.toMatch(/<citation\b/);
        expect(res.content).toContain('zotero://beaver/thread/abc123');
        expect(res.cited_items).toBeUndefined();
    });

    it('emits a citation tag but drops an unresolved note key from cited_items', async () => {
        // ZZZZZZZZ is a syntactically valid key that does not exist.
        const link = '<a href="zotero://select/library/items/ZZZZZZZZ">Note: Missing</a>';
        const source = await seedNote(`<p>A dangling (${link}) reference.</p>`);

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        // The simplifier does not check existence — the tag is still emitted.
        expect(res.content).toContain('<citation id="1-ZZZZZZZZ"');
        // …but resolveCitedItems drops items that fail to load.
        expect(res.cited_items).toBeUndefined();
    });
});

// ===========================================================================
// Mixed citations
// ===========================================================================

describe('/beaver/note/read — mixed regular/note/annotation citations', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('resolves regular, note and annotation citations in first-seen order', async () => {
        const regular = rawCitation({ key: PARENT_ITEM.zotero_key, label: '(Author, 2024)' });
        const targetNote = await seedNote('<p>Cited note body.</p>', 'Sibling Note');
        const annotation = await seedHighlightAnnotation({ text: 'a key sentence', comment: '' });

        const noteLink = `<a href="zotero://select/library/items/${targetNote.zotero_key}">Note: Sibling Note</a>`;
        const annLink = `<a href="zotero://open-pdf/library/items/${NORMAL_PDF.zotero_key}?annotation=${annotation.key}">Annotation, page ${annotation.pageLabel}</a>`;

        // Document order: regular item, then note, then annotation.
        const source = await seedNote(
            `<p>First ${regular}, then ${noteLink}, finally ${annLink}.</p>`,
        );

        const res = await readNote(`${source.library_id}-${source.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const ids = (res.cited_items ?? []).map(citedItemId);
        expect(ids).toEqual([
            `${LIBRARY_ID}-${PARENT_ITEM.zotero_key}`,
            `${LIBRARY_ID}-${targetNote.zotero_key}`,
            `${LIBRARY_ID}-${annotation.key}`,
        ]);

        const byId = new Map((res.cited_items ?? []).map((c) => [citedItemId(c), c]));
        expect(byId.get(`${LIBRARY_ID}-${PARENT_ITEM.zotero_key}`)!.item_type).not.toBe('note');
        expect(byId.get(`${LIBRARY_ID}-${targetNote.zotero_key}`)!.item_type).toBe('note');
        expect(byId.get(`${LIBRARY_ID}-${annotation.key}`)!.item_type).toBe('annotation');
    });
});

// ===========================================================================
// Write path: edit_note expands a note citation into a zotero:// anchor
// ===========================================================================

describe('edit_note — note citation expands to a zotero:// anchor on save', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('inserts <citation id="LIB-NOTEKEY"/> and saves a zotero://select anchor', async () => {
        const target = await seedNote('<p>target body</p>', 'Cited Target');
        const source = await seedNote('<p>Anchor sentence here.</p>');

        const exec = await executeEditNote({
            library_id: source.library_id,
            zotero_key: source.zotero_key,
            operation: 'str_replace',
            old_string: 'Anchor sentence here.',
            new_string: `Anchor sentence here <citation id="${LIBRARY_ID}-${target.zotero_key}" label="Note: Cited Target"/>.`,
        }, { timeout: 20000 });
        expect(exec.success, exec.error ?? undefined).toBe(true);
        expect(exec.result_data?.occurrences_replaced).toBe(1);

        // The expanded citation persisted as a plain zotero:// anchor — the
        // save-path normalize round-trip preserved the href (the shield path).
        const saved = await readSavedNote(source.library_id, source.zotero_key);
        expect(saved.saved_html).toContain(
            `<a href="zotero://select/library/items/${target.zotero_key}"`,
        );
        expect(saved.saved_html).toContain('Note: Cited Target');
        // It must NOT remain as an unexpanded simplified <citation> tag.
        expect(saved.saved_html).not.toContain('<citation');
    });
});
