/**
 * Live guard for Beaver's private locator key on note citations.
 *
 * Beaver records the locator token it wrote under a private `beaver` key inside
 * a citation's `data-citation` object (`src/utils/noteCitationLoc.ts`). The whole
 * design rests on Zotero preserving that unknown key: the note editor parses
 * `data-citation` into a ProseMirror atom node and serializes it back out, so a
 * schema that pruned attributes it does not recognize would silently drop every
 * Beaver locator the moment a user opened the note.
 *
 * These tests put a citation carrying the key through a REAL editor round trip
 * and assert the token comes back intact next to Zotero's own `locator` /
 * `label`:
 *
 *   1. Open the note and read the editor's OWN serialization (`editor_html`
 *      from `/beaver/test/note-read`, which calls the editor's `getDataSync()`
 *      unconditionally — the read path's `getDataSync(true)` returns null until
 *      the document changes, so it cannot show an untouched editor's output).
 *   2. Type into the editor so ProseMirror re-serializes a document it has
 *      actually modified.
 *   3. Persist that document and read the note back as the agent sees it: the
 *      stored token still projects as the citation's `loc`.
 *
 * Fixture note: it contains citations only. A `<span class="highlight"
 * data-annotation="…">` is DROPPED on load unless the note wrapper's
 * `data-citation-items` cache holds the item that the annotation's
 * `citationItem.uris` names. Citations have no such dependency.
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver loaded and authenticated.
 *   - library_id 1 marked "searchable" in Beaver preferences.
 *   - A real item at 1-G7TTJKFH (2-page PDF attachment) — the same fixture
 *     `helpers/fixtures.ts` uses.
 *   - The instance must be able to open a note editor window; tests that cannot
 *     get one skip rather than pass vacuously.
 *
 * Run: `npm run test:live -- noteCitationLocKey`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import {
    createNote,
    deleteNote,
    readNote,
    openNoteEditor,
    closeNoteEditor,
    setUnsavedNoteText,
    executeEditNote,
} from './helpers/noteTestClient';
import { SMALL_PDF } from '../helpers/fixtures';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);
// Simplified note output emits portable citation ids ("u-KEY" for the personal
// library); assertions on it must use the same grammar.
const LIBRARY_PREFIX = LIBRARY_ID === 1 ? 'u' : String(LIBRARY_ID);

/** A structural locator — a token no Zotero page locator could represent. */
const STRUCTURAL_LOC = 's56-s59';
/** Zotero's own page locator stored alongside it. */
const PAGE_LOCATOR = '12';

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — note citation locator-key live tests will be skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    for (const { library_id, zotero_key } of createdNotes) {
        // Close before deleting: erasing a note that is open in an editor makes
        // Zotero tear the tab/window down on its own.
        try { await closeNoteEditor(library_id, zotero_key); } catch { /* ignore */ }
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A Zotero citation span carrying Beaver's locator key, exactly as
 * `createCitationHTML` writes it: the private `beaver` meta sits next to
 * Zotero's `locator` / `label` on the citation item.
 */
function citationWithBeaverKey(opts: { key: string; locator: string; loc: string }): string {
    const data = {
        citationItems: [{
            uris: [`http://zotero.org/users/1/items/${opts.key}`],
            locator: opts.locator,
            label: 'page',
            beaver: { v: 1, loc: opts.loc },
        }],
        properties: {},
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(data))}">`
        + `<span class="citation-item">(Author, 2024, p. ${opts.locator})</span></span>`;
}

/** The citation items of the first `data-citation` in `html`. */
function firstCitationItems(html: string): any[] {
    const match = html.match(/data-citation="([^"]*)"/);
    if (!match) throw new Error(`No data-citation found in:\n${html}`);
    const items = JSON.parse(decodeURIComponent(match[1]))?.citationItems;
    if (!Array.isArray(items)) throw new Error(`No citationItems in:\n${match[1]}`);
    return items;
}

/**
 * Assert a citation still carries Beaver's key with `loc` intact and Zotero's
 * own locator fields untouched. `where` names the HTML the citation came from,
 * so a failure says which round trip lost it.
 */
function expectLocatorKeyIntact(html: string, where: string): void {
    const item = firstCitationItems(html)[0];
    expect(item?.beaver, `${where}: Beaver locator key missing from ${JSON.stringify(item)}`)
        .toEqual({ v: 1, loc: STRUCTURAL_LOC });
    expect(item.locator, `${where}: Zotero locator changed`).toBe(PAGE_LOCATOR);
    expect(item.label, `${where}: CSL label changed`).toBe('page');
}

async function seedNote(html: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

/**
 * Seed a note containing one citation with the locator key and open it in an
 * editor window. Returns null when the instance refuses to open one — the
 * caller SKIPS on null rather than passing vacuously.
 */
async function seedAndOpen(text = 'Cited'): Promise<{ library_id: number; zotero_key: string } | null> {
    const citation = citationWithBeaverKey({
        key: SMALL_PDF.zotero_key,
        locator: PAGE_LOCATOR,
        loc: STRUCTURAL_LOC,
    });
    const ref = await seedNote(`<p>${text} ${citation}.</p>`);
    const opened = await openNoteEditor(ref.library_id, ref.zotero_key, true);
    if (opened.in_editor) return ref;
    // Report what the endpoint said: an outright error and "the window opened
    // but no live instance was found" are different problems.
    console.warn(`Zotero opened no note editor window: ${JSON.stringify(opened)} — skipping.`);
    return null;
}

/**
 * Poll `/beaver/test/note-read` until the open editor produces a serialization.
 * The instance attaches before the iframe's ProseMirror view is ready, so the
 * first read after `openNoteEditor` can legitimately come back null.
 */
async function waitForEditorHtml(
    ref: { library_id: number; zotero_key: string },
): Promise<string | null> {
    for (let i = 0; i < 20; i++) {
        const state = await readNote(ref.library_id, ref.zotero_key);
        if (state.editor_html) return state.editor_html;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
}

/**
 * Poll the stored note until it contains `needle`. An open editor re-normalizes
 * and saves the note back after a write, so the DB can take a moment to settle
 * on its final value. Returns the last HTML read either way.
 */
async function waitForSavedHtml(
    ref: { library_id: number; zotero_key: string },
    needle: string,
): Promise<string> {
    let html = '';
    for (let i = 0; i < 20; i++) {
        html = (await readNote(ref.library_id, ref.zotero_key)).saved_html;
        if (html.includes(needle)) return html;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return html;
}

// ---------------------------------------------------------------------------
// The editor's own serialization
// ---------------------------------------------------------------------------

describe('note editor round trip — Beaver locator key', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('keeps the key when the editor serializes a note it just parsed', async (ctx) => {
        const ref = await seedAndOpen();
        if (!ref) {
            ctx.skip();
            return;
        }

        const editorHtml = await waitForEditorHtml(ref);
        expect(editorHtml, 'open editor produced no serialization').not.toBeNull();

        // This HTML came out of ProseMirror's own serializer, so the citation in
        // it is the atom node the schema parsed — not the string we seeded.
        expectLocatorKeyIntact(editorHtml as string, 'editor serialization');
    }, 30000);

    it('keeps the key when the editor re-serializes a document it has modified', async (ctx) => {
        const ref = await seedAndOpen();
        if (!ref) {
            ctx.skip();
            return;
        }
        expect(await waitForEditorHtml(ref), 'open editor produced no serialization').not.toBeNull();

        const marker = 'ROUND TRIP MARKER QXZV';
        const dirtied = await setUnsavedNoteText(ref.library_id, ref.zotero_key, marker);
        expect(dirtied.error, dirtied.error ?? '').toBeUndefined();
        // The harness contract: the editor holds content the DB has not seen, so
        // what follows is genuinely the editor's re-serialization of a changed
        // document and not the stored HTML echoed back.
        expect(dirtied.dirty, JSON.stringify(dirtied)).toBe(true);
        expect(dirtied.saved_changed).toBe(false);

        const state = await readNote(ref.library_id, ref.zotero_key);
        expect(state.live_html).toContain(marker);
        expectLocatorKeyIntact(state.live_html as string, 'live editor HTML');
        // The DB has not moved, and its copy is still the one we seeded.
        expect(state.saved_html).not.toContain(marker);
        expectLocatorKeyIntact(state.saved_html, 'stored HTML');
    }, 30000);

    it('projects the stored token to the agent after the round trip is persisted', async (ctx) => {
        const ref = await seedAndOpen();
        if (!ref) {
            ctx.skip();
            return;
        }
        expect(await waitForEditorHtml(ref), 'open editor produced no serialization').not.toBeNull();

        const marker = 'PERSISTED ROUND TRIP QXZV';
        const dirtied = await setUnsavedNoteText(ref.library_id, ref.zotero_key, marker);
        expect(dirtied.error, dirtied.error ?? '').toBeUndefined();
        expect(dirtied.dirty, JSON.stringify(dirtied)).toBe(true);

        // An edit_note append flushes the live editor into the DB before
        // applying, so the note now stores ProseMirror's serialization.
        const applied = await executeEditNote({
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'append',
            old_string: '',
            new_string: '<p>Appended after the round trip.</p>',
        }, { timeout: 20000 });
        expect(applied.success, applied.error ?? '').toBe(true);

        const savedHtml = await waitForSavedHtml(ref, marker);
        expect(savedHtml).toContain(marker);
        expectLocatorKeyIntact(savedHtml, 'stored HTML after flush');

        // …and the agent still reads the token the citation was written with,
        // rather than the page label it also stores.
        const read = await post<{ success: boolean; error?: string; content?: string }>(
            '/beaver/note/read',
            { note_id: `${ref.library_id}-${ref.zotero_key}` },
        );
        expect(read.success, read.error ?? '').toBe(true);
        expect(read.content).toContain(`id="${LIBRARY_PREFIX}-${SMALL_PDF.zotero_key}"`);
        expect(read.content).toContain(`loc="${STRUCTURAL_LOC}"`);
        expect(read.content).not.toContain(`loc="page${PAGE_LOCATOR}"`);
    }, 40000);
});
