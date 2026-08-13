/**
 * `expandToRawHtml`'s locator-drift guard.
 *
 * A model that copies a block verbatim also copies the locator it was shown. The
 * expansion layer reads a locator that differs from the note's CURRENT
 * projection as a deliberate page change and rebuilds the citation — correct
 * when the model really did change it, and a silent corruption when the note's
 * page labels moved after the read. `guardLocatorDrift` is the caller saying "I
 * cannot vouch that this content was written against the locators the note has
 * now", and these cases pin what expansion does with that.
 *
 * The three-way behavior these cases span:
 *
 *   guard off, locator differs → rebuild  (the supported "change a page" edit)
 *   guard on,  locator differs → refuse   (ambiguous: intent, or a stale copy)
 *   guard on,  nothing differs → verbatim (drift alone changes nothing)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Module mocks
// =============================================================================
// The real `noteCitationExpand` reaches Zotero through zoteroUtils →
// apiService → supabase; these stubs exist only to let it load, except
// `createCitationHTML`, whose recorded arguments are what the rebuild cases
// assert on.

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(() => 'unavailable'),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn((item: any, page?: string) => `<REBUILT ${item.key} p=${page ?? ''}>`),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

// =============================================================================
// Imports
// =============================================================================

import { expandToRawHtml } from '../../../src/utils/noteCitationExpand';
import { createCitationHTML } from '../../../src/utils/zoteroUtils';
import { logger } from '@beaver/agent-core/platform/logger';
import type { SimplificationMetadata, StoredElement } from '../../../src/utils/noteHtmlSimplifier';

// =============================================================================
// Fixtures
// =============================================================================

// Portable ids, as both the simplifier and the expansion layer emit them for a
// personal-library item. A legacy `1-KEY` here would compare unequal to the
// `u-KEY` expansion computes and make every case look like a retarget.
const ITEM_ID = 'u-ABCD1234';
const OTHER_ITEM_ID = 'u-ZZZZ9999';
const REF = 'c_ABCD1234_0';

/** The raw HTML the simplifier stored for the citation, before any edit. */
const STORED_RAW = '<span class="citation" data-citation="stored">(Author, 2024, p. 3)</span>';

/**
 * Metadata as the simplifier would have produced it for a note whose citation
 * currently projects `loc="page<page>"`.
 */
function metadataFor(page: string | undefined, extra: Partial<StoredElement> = {}): SimplificationMetadata {
    const elements = new Map<string, StoredElement>();
    elements.set(REF, {
        rawHtml: STORED_RAW,
        type: 'citation',
        originalAttrs: {
            item_id: ITEM_ID,
            ...(page ? { loc: `page${page}` } : {}),
        },
        ...extra,
    });
    return { elements } as SimplificationMetadata;
}

/** The simplified tag a model copies out of a `read_note` listing. */
function tag(loc?: string, itemId = ITEM_ID): string {
    return `<citation id="${itemId}"${loc ? ` loc="${loc}"` : ''} ref="${REF}"/>`;
}

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero = {
        Libraries: { userLibraryID: 1 },
        Items: {
            getByLibraryAndKey: vi.fn((libId: number, key: string) => ({
                id: 100,
                key,
                libraryID: libId,
                isAttachment: () => true,
                isNote: () => false,
                isRegularItem: () => true,
            })),
        },
    };
});

// =============================================================================
// guard OFF — today's behavior, unchanged
// =============================================================================

describe('expandToRawHtml without the locator-drift guard', () => {
    it('rebuilds the citation when the model changes only the locator', () => {
        const out = expandToRawHtml(`<p>Claim ${tag('page17')}</p>`, metadataFor('3'), 'new');
        expect(out).toContain('<REBUILT ABCD1234');
        expect(createCitationHTML).toHaveBeenCalledTimes(1);
    });

    it('leaves an unchanged citation byte-identical', () => {
        const out = expandToRawHtml(`<p>Claim ${tag('page3')}</p>`, metadataFor('3'), 'new');
        expect(out).toBe(`<p>Claim ${STORED_RAW}</p>`);
        expect(createCitationHTML).not.toHaveBeenCalled();
    });

    // The frequency of this rebuild is the number that decides whether the
    // capability is worth its risk, so it leaves a trace even when allowed.
    it('logs the locator-only rebuild', () => {
        expandToRawHtml(`<p>Claim ${tag('page17')}</p>`, metadataFor('3'), 'new');
        expect(logger).toHaveBeenCalledWith(
            expect.stringContaining(`locator-only rebuild of ref="${REF}" (3 → 17)`),
            1,
        );
    });
});

// =============================================================================
// guard ON — the drift case
// =============================================================================

describe('expandToRawHtml with the locator-drift guard', () => {
    it('refuses a locator change on an existing citation and names both values', () => {
        let thrown: unknown;
        try {
            expandToRawHtml(
                `<p>Claim ${tag('page3')}</p>`, metadataFor('17'), 'new',
                undefined, undefined, undefined, true,
            );
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(REF);
        expect(message).toContain('loc="page3"');   // what the model carried
        expect(message).toContain('loc="page17"');  // what the note shows now
        expect(message).toContain('read_note');
        // The whole point: nothing was rebuilt.
        expect(createCitationHTML).not.toHaveBeenCalled();
    });

    // The message must quote the locator the caller WROTE. A structural locator
    // parses to the page it resolves to, and quoting that would show the model a
    // locator it never wrote while telling it to copy its own tag verbatim.
    it('quotes a structural locator as written, not as resolved', () => {
        let thrown: unknown;
        try {
            expandToRawHtml(
                `<p>Claim ${tag('s42')}</p>`, metadataFor('17'), 'new',
                undefined, undefined, { 'zotero:u-ABCD1234:s42': '7' }, true,
            );
        } catch (e) {
            thrown = e;
        }
        // Reaching the guard at all means the locator RESOLVED to a page (an
        // unresolved one would read as "no locator" and fall outside it), so
        // this pins both halves: the message quotes `s42`, never the 7.
        expect((thrown as Error).message).toContain('loc="s42"');
        expect((thrown as Error).message).toContain('loc="page17"');
        expect((thrown as Error).message).not.toContain('page7');
    });

    // The sent side is judged on the tag as WRITTEN. A structural locator that
    // resolves to nothing parses to no page, but the caller plainly asked for a
    // locator — rebuilding would drop the note's own page without a word.
    it('refuses a written locator that resolves to nothing', () => {
        expect(() => expandToRawHtml(
            `<p>Claim ${tag('s42')}</p>`, metadataFor('17'), 'new',
            undefined, undefined, undefined, true,
        )).toThrow(/loc="s42"/);
    });

    // Every spelling the citation grammar accepts for a locator has to be seen
    // here, or a tag that carries one reads as carrying none and slips past.
    it.each([
        ['sid', `<citation id="${ITEM_ID}" sid="s42" ref="${REF}"/>`],
        ['legacy page', `<citation id="${ITEM_ID}" page="4" ref="${REF}"/>`],
        ['single quotes', `<citation id="${ITEM_ID}" loc='page4' ref="${REF}"/>`],
    ])('refuses a locator written as %s', (_label, citationTag) => {
        expect(() => expandToRawHtml(
            `<p>Claim ${citationTag}</p>`, metadataFor('17'), 'new',
            undefined, undefined, undefined, true,
        )).toThrow(/loc="page17"/);
    });

    // A locator appearing or disappearing is NOT counterfeitable: the simplifier
    // emits `loc` from the stored citation alone, so presence never moves with
    // the page-label cache. Refusing these would block unambiguous edits.
    it('applies a locator added to a citation that has none', () => {
        const out = expandToRawHtml(
            `<p>Claim ${tag('page3')}</p>`, metadataFor(undefined), 'new',
            undefined, undefined, undefined, true,
        );
        expect(out).toContain('<REBUILT ABCD1234 p=3>');
    });

    it('applies a locator dropped from a citation that has one', () => {
        const out = expandToRawHtml(
            `<p>Claim ${tag()}</p>`, metadataFor('17'), 'new',
            undefined, undefined, undefined, true,
        );
        expect(out).toContain('<REBUILT ABCD1234 p=>');
    });

    // Drift is note-wide, but the guard is not: a block copied verbatim expands
    // to its stored raw HTML and is unaffected, which is what keeps the guard
    // from failing every edit made to a note whose labels happened to resolve.
    it('leaves an unchanged citation alone even while drift is flagged', () => {
        const out = expandToRawHtml(
            `<p>Claim ${tag('page17')}</p>`, metadataFor('17'), 'new',
            undefined, undefined, undefined, true,
        );
        expect(out).toBe(`<p>Claim ${STORED_RAW}</p>`);
    });

    // Item ids are identity and never drift, so a changed id is unambiguously
    // the model retargeting the citation — allowed, drift or no drift.
    it('still applies a change that retargets the citation to another item', () => {
        const out = expandToRawHtml(
            `<p>Claim ${tag('page3', OTHER_ITEM_ID)}</p>`, metadataFor('3'), 'new',
            undefined, undefined, undefined, true,
        );
        expect(out).toContain('<REBUILT ZZZZ9999');
    });

    // A citation with no `ref` is new content, not a copy of anything the model
    // was shown, so drift says nothing about it.
    it('still inserts a brand-new citation', () => {
        const out = expandToRawHtml(
            '<p>New claim <citation id="u-ABCD1234" loc="page9"/></p>', metadataFor('17'), 'new',
            undefined, undefined, undefined, true,
        );
        expect(out).toContain('<REBUILT ABCD1234');
    });

    // Compound citations are immutable by an earlier rule, which the guard must
    // not shadow: they return their stored raw HTML without ever comparing
    // attributes.
    it('returns a compound citation verbatim', () => {
        const elements = new Map<string, StoredElement>();
        elements.set(REF, { rawHtml: STORED_RAW, type: 'compound-citation', isCompound: true });
        const out = expandToRawHtml(
            `<p>Both <citation items="1-AAAA1111:page=3, 1-BBBB2222:page=9" ref="${REF}"/></p>`,
            { elements } as SimplificationMetadata, 'new',
            undefined, undefined, undefined, true,
        );
        expect(out).toBe(`<p>Both ${STORED_RAW}</p>`);
    });

});
