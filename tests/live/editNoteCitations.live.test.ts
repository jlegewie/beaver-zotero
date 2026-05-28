/**
 * Live tests for edit_note citation handling against the unified citation
 * grammar (v0.20 → main diff).
 *
 * Covers:
 *   1. `validateNewString` rejects new compound citations with the updated
 *      message mentioning `<citation id="..."/>` (not `item_id="..."`).
 *   2. `checkNewCitationItemsExist` and `expandToRawHtml` accept unified
 *      `<citation id="LIB-KEY"/>` and `<citation id="LIB-KEY" loc="pageN"/>`
 *      tags in new_string.
 *   3. Missing-identity error message uses the new wording (mentions
 *      `id="..."` plus the legacy `item_id`/`att_id` aliases).
 *   4. `enrichOldStringCitationRefs` handles unified `id="LIB-KEY"` in
 *      old_string and rewrites it to the underlying ref/item_id so existing
 *      citations can be edited by the new attribute name.
 *   5. The simplifier's new locator format (`loc="page42"`) round-trips
 *      through expand → save → read so the page locator survives.
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver and authenticated.
 *   - library_id 1 marked "searchable" in Beaver preferences.
 *   - Real items at 1-IYI5SMYM (regular item) — same as `helpers/fixtures.ts`.
 *
 * Run: `npx vitest run --config vitest.live.config.ts tests/live/editNoteCitations.live.test.ts`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import {
    createNote,
    deleteNote,
    validateEditNote,
    executeEditNote,
    type EditNoteActionData,
} from './helpers/noteTestClient';
import { PARENT_ITEM, NORMAL_PDF } from '../helpers/fixtures';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — edit_note citation live tests will be skipped.\n'
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

async function seedNote(html: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

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

/** Build a native Zotero citation span — used to seed pre-existing citations. */
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

// =========================================================================
// validateNewString — error message updates
// =========================================================================

describe('edit_note validate — new_string error messages', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('rejects a new compound citation with the updated message mentioning <citation id="..."/>', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            new_string:
                `Body with new compound <citation items="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}, ${LIBRARY_ID}-${NORMAL_PDF.zotero_key}" label="(A; B)"/>.`,
        });

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_new_string');
        expect(res.error).toMatch(/Cannot create new compound citations/);
        // New wording: mention unified `id="..."` instead of `item_id="..."`.
        expect(res.error).toMatch(/<citation id="\.\.\."/);
        expect(res.error).not.toMatch(/<citation item_id="\.\.\."/);
    });

    it('rejects a new citation with no identity using the updated "id" wording', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            new_string: 'Body with bare <citation label="bare"/>.',
        });

        expect(res.valid).toBe(false);
        // The error originates in `expandToRawHtml`, surfaced as
        // `expansion_failed` (NOT `invalid_new_string`).
        expect(res.error).toMatch(/Citation must have an "id" attribute/);
        expect(res.error).toMatch(/Legacy "item_id" \/ "att_id" are also accepted/);
    });

    it('rejects an unresolvable external_id with the updated message mentioning id="LIB-KEY"', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            // external_id that isn't in this thread's mapping cache
            new_string: 'Body with <citation external_id="W-not-in-thread" label="External"/>.',
        });

        expect(res.valid).toBe(false);
        expect(res.error).toMatch(/external_id="W-not-in-thread"/);
        // New wording: hint mentions `id="LIB-KEY"`, not `item_id="LIB-KEY"`.
        expect(res.error).toMatch(/id="LIB-KEY"/);
    });
});

// =========================================================================
// Unified id="..." accepted as new citation
// =========================================================================

describe('edit_note validate — unified id="" attribute', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('accepts a new <citation id="LIB-KEY"/> for an existing item', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            new_string: `Body with <citation id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}" label="(Legewie, 2024)"/>.`,
        });

        expect(res.valid, res.error ?? '').toBe(true);
        expect(res.error_code).toBeFalsy();
    });

    it('rejects a new <citation id="LIB-DOESNOTEXIST"/> citing a nonexistent item', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            new_string: `Body with <citation id="${LIBRARY_ID}-DOESNOTEX" label="(?)"/>.`,
        });

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('citation_item_not_found');
        // The error mentions which attribute label was used — for unified
        // tags `checkNewCitationItemsExist` prints `id=`.
        expect(res.error).toMatch(/id="\d+-DOESNOTEX"/);
    });
});

// =========================================================================
// loc="pageN" round-trip
// =========================================================================

describe('edit_note execute — loc="pageN" locator round-trip', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('inserts a new citation with loc="page42" and saves a native citation span with locator 42', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            new_string: `Body cited <citation id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}" loc="page42" label="(Legewie, 2024, p. 42)"/>.`,
        };

        const res = await executeEditNote(actionData, { timeout: 20000 });
        expect(res.success, res.error ?? '').toBe(true);

        // Read the saved note back via the dev test endpoint to confirm
        // the raw HTML carries the native Zotero locator.
        const readBack = await post<{ saved_html: string; error?: string }>(
            '/beaver/test/note-read',
            { library_id: ref.library_id, zotero_key: ref.zotero_key },
        );
        expect(readBack.error).toBeFalsy();
        // Raw saved HTML has a `data-citation="..."` with `"locator":"42"`
        // somewhere in the encoded JSON.
        const decoded = decodeURIComponent(readBack.saved_html);
        expect(decoded).toMatch(/"locator":"42"/);
    });

    it('round-trips loc="page42" back through /beaver/note/read with the new attribute name', async () => {
        const ref = await seedNote('<p>Body to edit.</p>');

        const actionData: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: 'Body to edit.',
            new_string: `Body cited <citation id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}" loc="page42" label="(Legewie, 2024, p. 42)"/>.`,
        };

        const exec = await executeEditNote(actionData, { timeout: 20000 });
        expect(exec.success, exec.error ?? '').toBe(true);

        const simplified = await readSimplified(`${ref.library_id}-${ref.zotero_key}`);
        // The simplifier re-emits in the new format: id="..." loc="pageN".
        expect(simplified).toContain(`id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}"`);
        expect(simplified).toContain('loc="page42"');
        // No regression to the legacy page="42" / item_id= form.
        expect(simplified).not.toMatch(/\bpage="42"/);
        expect(simplified).not.toMatch(/\bitem_id="/);
    });
});

// =========================================================================
// enrichOldStringCitationRefs — unified id= in old_string
// =========================================================================

describe('edit_note validate — enrichOldStringCitationRefs handles unified id=', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('matches an existing single citation referenced by id="" (no ref attr) in old_string', async () => {
        // Seed a note with a native single citation. The simplifier emits it
        // as `<citation id="LIB-KEY" label="..." ref="..."/>`.
        const native = rawCitation({ key: PARENT_ITEM.zotero_key, label: '(Legewie, 2024)' });
        const ref = await seedNote(`<p>Existing ${native} here.</p>`);

        // The agent recalls the citation by its `id` attribute but does not
        // include the simplifier-injected `ref` (or label). Enrichment must
        // find the unique citation matching this id+page combination and
        // inject the ref so the matcher succeeds.
        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: `<citation id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}"/>`,
            new_string: 'REPLACED',
        });

        // The enrichment must succeed: a unique match exists for this item id
        // with no page locator.
        expect(res.valid, res.error ?? '').toBe(true);
    });

    it('matches an existing single citation referenced by item_id="" (legacy, no ref attr)', async () => {
        const native = rawCitation({ key: PARENT_ITEM.zotero_key, label: '(Legewie, 2024)' });
        const ref = await seedNote(`<p>Existing ${native} here.</p>`);

        // Legacy `item_id=` still works for old_string enrichment.
        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: `<citation item_id="${LIBRARY_ID}-${PARENT_ITEM.zotero_key}"/>`,
            new_string: 'REPLACED',
        });

        expect(res.valid, res.error ?? '').toBe(true);
    });
});

// =========================================================================
// Partial-tag detector — message mentions new tag shape
// =========================================================================

describe('edit_note validate — partial citation detector', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('partial citation in old_string triggers the actionable hint with new tag shape', async () => {
        const ref = await seedNote('<p>Body with <strong>marker</strong>.</p>');

        const res = await validateEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            // Unclosed opener — not a complete <citation .../>.
            old_string: '<citation id="1-PART',
            new_string: 'NEW',
        });

        expect(res.valid).toBe(false);
        // Updated hint mentions `<citation id="..." loc="page..."/>`.
        expect(res.error).toMatch(/<citation id="\.\.\." loc="page\.\.\."\/>/);
        // Old hint mentioned `<citation item_id="..." page="..."/>`.
        expect(res.error).not.toMatch(/<citation item_id="\.\.\." page="\.\.\."\/>/);
    });
});
