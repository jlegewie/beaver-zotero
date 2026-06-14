/**
 * Live tests for the client-agnostic citation host's `itemData.resolveItemDisplay`
 * (citation client-host refactor).
 *
 * `CitedSourcesList` renders each cited-source row from self-contained citation
 * v2 metadata, but two row affordances are NOT in that metadata and are resolved
 * live from Zotero via the host:
 *   - the row icon's item type (for mapped external citations + item citations), and
 *   - the "open" / PDF button enabled state (whether the item has a readable
 *     attachment).
 *
 * `resolveItemDisplay` is the single host method backing both. It is invoked
 * here through the dev-only `/beaver/test/resolve-item-display` endpoint, which
 * calls the real `zoteroItemData.resolveItemDisplay` (no reimplementation).
 *
 * Behavior under test (matches `react/host/zotero/itemData.ts`):
 *   - Regular item: `hasReadableAttachment` reflects `getBestAttachment()`.
 *   - Attachment: `hasReadableAttachment` is ALWAYS true (attachment present),
 *     independent of whether its content type is actually extractable.
 *   - `itemType` is the resolved item's Zotero type ('attachment', 'note', or a
 *     regular item type).
 *   - Missing / unresolvable refs return null.
 *   - Works across libraries (user + group).
 *
 * Prerequisites:
 *   - Zotero running with a dev build of Beaver loaded and authenticated.
 *   - The fixtures referenced below seeded in the dev library (see
 *     `tests/helpers/fixtures.ts`), including the group-library items.
 *
 * Run: `npm run test:live -- citationItemDisplay`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { resolveItemDisplay } from '../helpers/cacheInspector';
import { createNote, deleteNote } from './helpers/noteTestClient';
import {
    NORMAL_PDF,
    SMALL_PDF,
    PARENT_ITEM,
    GROUP_LIB_PDF,
    UNREADABLE_ATTACHMENT,
    PARENT_LINKED_URL_ONLY,
    NON_PDF,
} from '../helpers/fixtures';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — citation item-display live tests will be skipped.\n'
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

// ===========================================================================
// Attachments — hasReadableAttachment is true by virtue of being an attachment
// ===========================================================================

describe('/beaver/test/resolve-item-display — attachments', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('reports itemType "attachment" and a readable attachment for a PDF attachment', async () => {
        const display = await resolveItemDisplay(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(display).not.toBeNull();
        expect(display!.itemType).toBe('attachment');
        expect(display!.hasReadableAttachment).toBe(true);
    });

    it('reports the same for an 18-page PDF attachment', async () => {
        const display = await resolveItemDisplay(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        expect(display).not.toBeNull();
        expect(display!.itemType).toBe('attachment');
        expect(display!.hasReadableAttachment).toBe(true);
    });

    it('treats a non-extractable attachment as having a readable attachment (attachment presence, not true readability)', async () => {
        // An octet-stream attachment is not extractable, but the host short-
        // circuits any attachment to hasReadableAttachment=true — the PDF button
        // is gated on attachment presence, not content readability.
        const display = await resolveItemDisplay(
            UNREADABLE_ATTACHMENT.library_id,
            UNREADABLE_ATTACHMENT.zotero_key,
        );
        expect(display).not.toBeNull();
        expect(display!.itemType).toBe('attachment');
        expect(display!.hasReadableAttachment).toBe(true);
    });

    it('reports an attachment in a group library (cross-library)', async () => {
        const display = await resolveItemDisplay(GROUP_LIB_PDF.library_id, GROUP_LIB_PDF.zotero_key);
        expect(display).not.toBeNull();
        expect(display!.itemType).toBe('attachment');
        expect(display!.hasReadableAttachment).toBe(true);
    });
});

// ===========================================================================
// Regular items — hasReadableAttachment reflects getBestAttachment()
// ===========================================================================

describe('/beaver/test/resolve-item-display — regular items', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('reports a non-attachment item type and a readable attachment for a regular item with a PDF child', async () => {
        const display = await resolveItemDisplay(PARENT_ITEM.library_id, PARENT_ITEM.zotero_key);
        expect(display).not.toBeNull();
        // A regular item's type is its bibliographic type, never "attachment".
        expect(display!.itemType).toBeTruthy();
        expect(display!.itemType).not.toBe('attachment');
        expect(display!.itemType).not.toBe('note');
        // Best attachment resolves to the child PDF.
        expect(display!.hasReadableAttachment).toBe(true);
    });

    it('reports a regular item whose only child is a linked URL (no stored file)', async () => {
        // getBestAttachment() decides hasReadableAttachment here; a linked-URL
        // child has no stored file. This documents the host's behavior for the
        // "no openable attachment" case.
        const display = await resolveItemDisplay(
            PARENT_LINKED_URL_ONLY.library_id,
            PARENT_LINKED_URL_ONLY.zotero_key,
        );
        expect(display).not.toBeNull();
        expect(display!.itemType).not.toBe('attachment');
        expect(display!.hasReadableAttachment).toBe(false);
    });
});

// ===========================================================================
// Notes and missing items
// ===========================================================================

describe('/beaver/test/resolve-item-display — notes and missing items', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('reports itemType "note" with no readable attachment for a note item', async () => {
        const res = await createNote({ library_id: LIBRARY_ID, html: '<p>Display-meta note.</p>' });
        expect(res.error, res.error ?? '').toBeFalsy();
        createdNotes.push({ library_id: res.library_id, zotero_key: res.zotero_key });

        const display = await resolveItemDisplay(res.library_id, res.zotero_key);
        expect(display).not.toBeNull();
        expect(display!.itemType).toBe('note');
        // A note is neither a regular item nor an attachment, so the host leaves
        // hasReadableAttachment at its default (false).
        expect(display!.hasReadableAttachment).toBe(false);
    });

    it('returns null for a nonexistent item key', async () => {
        const display = await resolveItemDisplay(LIBRARY_ID, 'DOESNOTEX');
        expect(display).toBeNull();
    });

    it('returns null for a nonexistent (out-of-range) library id', async () => {
        const display = await resolveItemDisplay(999999, NORMAL_PDF.zotero_key);
        expect(display).toBeNull();
    });
});

// ===========================================================================
// EPUB attachment — readable, itemType still "attachment"
// ===========================================================================

describe('/beaver/test/resolve-item-display — non-PDF attachment', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('reports a readable attachment for a top-level EPUB attachment', async () => {
        const display = await resolveItemDisplay(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(display).not.toBeNull();
        expect(display!.itemType).toBe('attachment');
        expect(display!.hasReadableAttachment).toBe(true);
    });
});
