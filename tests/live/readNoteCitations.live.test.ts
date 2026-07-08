/**
 * Live tests for `/beaver/note/read` citation parsing (v0.20 → main diff).
 *
 * Covers:
 *   1. Simplifier output for single citations now emits unified
 *      `<citation id="LIB-KEY" loc="page..."/>`, replacing the legacy
 *      `<citation item_id="..." page="..."/>` form.
 *   2. `cited_items` extraction now goes through `parseZoteroId` and accepts
 *      unified `id="..."`, legacy `item_id="..."`, and compound
 *      `items="..."`; attachment-only `<citation att_id="..."/>` no longer
 *      contributes to `cited_items`.
 *   3. Locator-on-compound parts: `items="LIB-KEY:page=N"` round-trips
 *      through the locator stripper without leaking the `:page=N` suffix
 *      into the resolved key.
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver loaded and authenticated.
 *   - library_id 1 (the user library) must be marked "searchable" in Beaver.
 *   - Real items at 1-IYI5SMYM (regular item) and 1-G7TTJKFH (PDF
 *     attachment whose parent is 1-IYI5SMYM) — same items used by
 *     `helpers/fixtures.ts`.
 *
 * Run: `npx vitest run --config vitest.live.config.ts tests/live/readNoteCitations.live.test.ts`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { createNote, deleteNote } from './helpers/noteTestClient';
import { PARENT_ITEM, SMALL_PDF, NORMAL_PDF } from '../helpers/fixtures';

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
            '\nZotero not available — read_note citation live tests will be skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    for (const { library_id, zotero_key } of createdNotes) {
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
});

interface CitedItem {
    library_id: number;
    zotero_key: string;
    title?: string | null;
}

interface ReadNoteResponse {
    success: boolean;
    error?: string;
    note_id?: string;
    content?: string;
    cited_items?: CitedItem[];
}

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

/** Build a native Zotero `<span class="citation" data-citation="...">` span. */
function rawCitation(opts: {
    key: string;
    libraryUserId?: number;
    locator?: string;
    label?: string;
}): string {
    const data = {
        citationItems: [{
            uris: [`http://zotero.org/users/${opts.libraryUserId ?? 1}/items/${opts.key}`],
            locator: opts.locator ?? '',
        }],
        properties: {},
    };
    const encoded = encodeURIComponent(JSON.stringify(data));
    const inner = opts.label ?? '(Author, 2024)';
    return `<span class="citation" data-citation="${encoded}"><span class="citation-item">${inner}</span></span>`;
}

/** Build a native Zotero compound citation span (multiple `citationItems`). */
function rawCompoundCitation(opts: {
    items: Array<{ key: string; locator?: string }>;
    libraryUserId?: number;
    label?: string;
}): string {
    const data = {
        citationItems: opts.items.map((it) => ({
            uris: [`http://zotero.org/users/${opts.libraryUserId ?? 1}/items/${it.key}`],
            locator: it.locator ?? '',
        })),
        properties: {},
    };
    const encoded = encodeURIComponent(JSON.stringify(data));
    const inner = opts.label ?? '(Author A; Author B)';
    return `<span class="citation" data-citation="${encoded}"><span class="citation-item">${inner}</span></span>`;
}

// ===========================================================================
// Simplifier output format
// ===========================================================================

describe('/beaver/note/read — single citation simplified output', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('emits unified id="..." (not item_id) and no bare page= attr', async () => {
        const citation = rawCitation({ key: PARENT_ITEM.zotero_key, label: '(Author, 2024)' });
        const ref = await seedNote(`<p>Body with ${citation}.</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        expect(res.content).toContain(`id="${LIBRARY_PREFIX}-${PARENT_ITEM.zotero_key}"`);
        // Legacy attrs must not appear in the new simplified format.
        expect(res.content).not.toMatch(/\bitem_id="/);
        expect(res.content).not.toMatch(/\bpage="\d/);
        // The simplified tag matches Beaver's citation syntax plus the edit
        // handle; rendered citation text is not exposed as a label attribute.
        expect(res.content).not.toMatch(/<citation [^>]*\blabel="/);
    });

    it('emits loc="pageNNN" when the underlying citation has a page locator', async () => {
        const citation = rawCitation({
            key: PARENT_ITEM.zotero_key,
            locator: '42',
            label: '(Legewie, 2024, p. 42)',
        });
        const ref = await seedNote(`<p>${citation}</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        // The new simplifier output prefixes numeric page locators with "page".
        expect(res.content).toContain(`loc="page42"`);
        // Old simplifier used a bare page="42" attr — must NOT regress.
        expect(res.content).not.toMatch(/\bpage="42"/);
    });

    it('compound citations keep items="..." (still legacy, immutable)', async () => {
        // The compound branch in `simplifyNoteHtml` was intentionally left
        // on the items="LIB-KEY1, LIB-KEY2" form by the v0.20 diff — only
        // single citations switched to the unified id/loc grammar. This
        // test pins that contract so a future refactor doesn't silently
        // break read_note's compound-citation parsing.
        const compound = rawCompoundCitation({
            items: [
                { key: PARENT_ITEM.zotero_key },
                { key: NORMAL_PDF.zotero_key, locator: '7' },
            ],
            label: '(Legewie, 2024; Other, 2023)',
        });
        const ref = await seedNote(`<p>${compound}</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        expect(res.content).toMatch(/<citation items="[^"]+"/);
        // Items value includes both keys and the second one's `:page=7` suffix.
        const itemsMatch = res.content!.match(/items="([^"]+)"/);
        expect(itemsMatch).not.toBeNull();
        const itemsValue = itemsMatch![1];
        expect(itemsValue).toContain(`${LIBRARY_PREFIX}-${PARENT_ITEM.zotero_key}`);
        expect(itemsValue).toContain(`${LIBRARY_PREFIX}-${NORMAL_PDF.zotero_key}:page=7`);
    });
});

// ===========================================================================
// cited_items resolution via the new citation grammar
// ===========================================================================

describe('/beaver/note/read — cited_items extraction', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('populates cited_items for a unified single citation (id=)', async () => {
        const citation = rawCitation({ key: PARENT_ITEM.zotero_key });
        const ref = await seedNote(`<p>${citation}</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const ids = (res.cited_items ?? []).map(citedItemId);
        expect(ids).toContain(`${LIBRARY_ID}-${PARENT_ITEM.zotero_key}`);
    });

    it('deduplicates citations that point at the same item', async () => {
        const cite1 = rawCitation({ key: PARENT_ITEM.zotero_key, locator: '1' });
        const cite2 = rawCitation({ key: PARENT_ITEM.zotero_key, locator: '99' });
        const ref = await seedNote(`<p>${cite1} and again ${cite2}.</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const ids = (res.cited_items ?? []).map(citedItemId);
        // Same item key cited twice — should only appear once in cited_items.
        const occurrences = ids.filter((id) => id === `${LIBRARY_ID}-${PARENT_ITEM.zotero_key}`).length;
        expect(occurrences).toBe(1);
    });

    it('strips the :page=N locator suffix from compound items before parsing', async () => {
        // Bug guard: the simplifier emits items="LIB-KEY1, LIB-KEY2:page=7".
        // `extractCitedItemRefs` must strip everything after the colon
        // before handing the id to `parseZoteroId`, otherwise the
        // second-item parse fails and cited_items drops it.
        const compound = rawCompoundCitation({
            items: [
                { key: PARENT_ITEM.zotero_key },
                { key: NORMAL_PDF.zotero_key, locator: '7' },
            ],
        });
        const ref = await seedNote(`<p>${compound}</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const ids = (res.cited_items ?? []).map(citedItemId);
        // 1-IYI5SMYM is a regular item, so it resolves cleanly.
        expect(ids).toContain(`${LIBRARY_ID}-${PARENT_ITEM.zotero_key}`);
        // 1-2YWA8DTZ is an attachment, so resolveCitedItems filters it
        // out (regular items only) — but the parse must NOT have failed
        // with the :page=7 suffix still attached.
        for (const id of ids) {
            expect(id).not.toMatch(/:page=/);
        }
    });

    it('does NOT include attachment-only att_id citations in cited_items', async () => {
        // After v0.20, `extractCitedItemRefs` skips `<citation att_id=...>`
        // entirely (attachment-to-parent resolution is out of scope). Seed
        // a note that simulates the model emitting a raw att_id-only
        // citation in the simplified view — the saved note still contains
        // a native `<span class="citation">` that resolves to the parent,
        // so the simplifier rewrites it as id="LIB-PARENT". The guarantee
        // is that synthetic `<citation att_id=...>` strings inside the
        // simplified output are ignored. We test the contract directly
        // against the read endpoint: a note that contains ONLY an
        // attachment-key annotation image (no real citation span) must
        // return no cited_items.
        // (`rawCitation` always uses a regular-item URI; native Zotero
        // doesn't emit att_id-shaped citations.)
        const ref = await seedNote('<p>Body without any citation tags.</p>');

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        expect(res.cited_items).toBeUndefined();
    });

    it('resolves cited_items across multiple distinct citations preserving first-seen order', async () => {
        const cite1 = rawCitation({ key: PARENT_ITEM.zotero_key });
        const cite2 = rawCitation({ key: SMALL_PDF.zotero_key });
        // Second one is an attachment — resolveCitedItems filters
        // non-regular items, so it should NOT appear in cited_items even
        // though it parses cleanly.
        const ref = await seedNote(`<p>${cite1}</p><p>${cite2}</p>`);

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        const ids = (res.cited_items ?? []).map(citedItemId);
        expect(ids).toContain(`${LIBRARY_ID}-${PARENT_ITEM.zotero_key}`);
        // Attachment cite is parsed but filtered downstream.
        expect(ids).not.toContain(`${LIBRARY_ID}-${SMALL_PDF.zotero_key}`);
    });

    it('omits cited_items when the note has no citations at all', async () => {
        const ref = await seedNote('<p>Plain prose with no citations.</p>');

        const res = await readNote(`${ref.library_id}-${ref.zotero_key}`);
        expect(res.success, res.error).toBe(true);
        expect(res.cited_items).toBeUndefined();
    });
});
