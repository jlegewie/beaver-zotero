import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Module mocks
// =============================================================================
// Stub the supabase / agentDataProvider utils transitive deps that the real
// noteCitationExpand module pulls in via zoteroUtils → apiService → supabase.
// These stubs are only here to let the module load in a unit-test harness.

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(() => 'unavailable'),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

// =============================================================================
// Imports
// =============================================================================

import {
    enrichOldStringCitationRefs,
    normalizeOldStringCitations,
    normalizeNewStringCitations,
} from '../../../src/utils/editNoteValidation';
import type { SimplificationMetadata } from '../../../src/utils/noteHtmlSimplifier';

// =============================================================================
// Helpers
// =============================================================================

function buildMetadata(
    entries: Array<{ ref: string; itemId: string; page?: string }>,
): SimplificationMetadata {
    const elements = new Map<string, any>();
    for (const { ref, itemId, page } of entries) {
        elements.set(ref, {
            type: 'citation',
            originalAttrs: { item_id: itemId, ...(page ? { page } : {}) },
        });
    }
    return { elements } as SimplificationMetadata;
}

/** Insert a compound-citation entry into an existing metadata object. */
function addCompound(metadata: SimplificationMetadata, ref: string): void {
    (metadata.elements as Map<string, any>).set(ref, {
        type: 'compound-citation',
        isCompound: true,
    });
}

// Fresh per-test `Zotero.Items` stub so each test controls its own lookups.
type ItemStub = {
    id?: number;
    libraryID: number;
    parentKey?: string;
    isAttachment?: () => boolean;
};

function installZoteroItems(byKey: Map<string, ItemStub>) {
    (globalThis as any).Zotero = (globalThis as any).Zotero ?? {};
    (globalThis as any).Zotero.Items = {
        getByLibraryAndKey: vi.fn((libId: number, key: string) => {
            return byKey.get(`${libId}-${key}`) ?? false;
        }),
    };
}

// Stub for the sync page-label cache read path that
// `translatePageNumberToLabel` uses. Map `attachmentItem.id` → `string[]`
// where index 0 is the label for 1-based page 1.
function installPageLabelCache(labelsByItemId: Map<number, string[]>) {
    (globalThis as any).Zotero = (globalThis as any).Zotero ?? {};
    (globalThis as any).Zotero.Beaver = (globalThis as any).Zotero.Beaver ?? {};
    (globalThis as any).Zotero.Beaver.attachmentFileCache = {
        getPageLabelsSync: vi.fn((itemId: number) => labelsByItemId.get(itemId) ?? null),
    };
}

beforeEach(() => {
    installZoteroItems(new Map());
    installPageLabelCache(new Map());
});

afterEach(() => {
    vi.restoreAllMocks();
});

// =============================================================================
// enrichOldStringCitationRefs — existing item_id branch (regression)
// =============================================================================

describe('enrichOldStringCitationRefs (item_id)', () => {
    it('injects ref when a unique item_id + page match is found in metadata', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA', page: '12' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>Body <citation item_id="1-AAAAAAAA" page="12"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p>Body <citation item_id="1-AAAAAAAA" page="12" ref="c_AAAA_0"/></p>',
        );
    });

    it('skips citations that already carry a ref', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation item_id="1-AAAAAAAA" ref="c_AAAA_0"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('skips when two metadata entries share item_id + page (ambiguous)', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA', page: '5' },
            { ref: 'c_AAAA_1', itemId: '1-AAAAAAAA', page: '5' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation item_id="1-AAAAAAAA" page="5"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('returns null when the citation has no matching metadata entry', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation item_id="1-NOSUCH"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });
});

// =============================================================================
// enrichOldStringCitationRefs — att_id branch (new)
// =============================================================================

describe('enrichOldStringCitationRefs (att_id)', () => {
    it('rewrites att_id to the parent item_id and injects the matching ref', () => {
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" ref="c_PARENT_0"/></p>',
        );
    });

    it('preserves page attribute in the rewritten citation', () => {
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '3' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000" page="3"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="3" ref="c_PARENT_0"/></p>',
        );
    });

    it('translates 1-based page number to the attachment\'s display label', () => {
        // Repro of the reviewer's concern: when buildCitationFromAttId ran at
        // insert time, it converted `page="3"` → the attachment's label
        // "iii" (roman frontmatter). Stored metadata carries the label; the
        // model's follow-up old_string still uses the raw number. Without
        // translation, enrichment would skip and validation would fail.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        installPageLabelCache(new Map([
            // 1-based page 3 → label "iii"
            [42, ['i', 'ii', 'iii', 'iv', 'v']],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: 'iii' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000" page="3"/></p>',
            metadata,
        );
        // The rewritten tag carries the translated label so the downstream
        // matcher aligns with the simplified form.
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="iii" ref="c_PARENT_0"/></p>',
        );
    });

    it('falls back to untranslated page when page-label cache is empty', () => {
        // Defense: translatePageNumberToLabel returns the input unchanged when
        // the attachment's labels are not cached. Enrichment must still work
        // when the model happens to write the label directly.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 99,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        // No page-label cache entry for id 99 — translation returns input.
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '3' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000" page="3"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="3" ref="c_PARENT_0"/></p>',
        );
    });

    it('matches the pre-translation page when metadata stores the raw number', () => {
        // Belt-and-braces fallback: if page-label cache is populated but the
        // metadata still carries the pre-translation number (older notes,
        // attachments without page maps), enrichment should still succeed on
        // the untranslated form.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 7,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        // Cache exists and translates page 3 → "iii", but metadata stores "3".
        installPageLabelCache(new Map([
            [7, ['i', 'ii', 'iii']],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '3' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000" page="3"/></p>',
            metadata,
        );
        // Translated lookup for "iii" misses (metadata has "3"); fallback to
        // the raw "3" matches. The enriched tag carries the page variant that
        // actually matched in metadata ("3"), NOT the translated form —
        // otherwise the downstream `attrsChanged` check in expandToRawHtml
        // would treat the citation as modified and fabricate a new one with
        // locator "iii", which wouldn't match the note's stored "3" locator.
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="3" ref="c_PARENT_0"/></p>',
        );
    });

    it('skips when the attachment does not exist in Zotero', () => {
        // Zotero.Items.getByLibraryAndKey returns falsy (our default install).
        const metadata = buildMetadata([]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-NOSUCHATT"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('skips the malformed "1-1-KEY" shape (hallucinated double-prefix)', () => {
        installZoteroItems(new Map());
        const metadata = buildMetadata([]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-1-YZ7B9BVB"/></p>',
            metadata,
        );
        // The Zotero lookup returns falsy for the made-up "1-YZ7B9BVB" key,
        // enrichment skips, and the original string is unchanged.
        expect(result).toBeNull();
    });

    it('skips when the resolved item is not an attachment', () => {
        installZoteroItems(new Map([
            ['1-ITEMKEYAB', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => false,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ITEMKEYAB"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('skips top-level attachments with no parentKey', () => {
        installZoteroItems(new Map([
            ['1-ORPHANATT', {
                libraryID: 1,
                parentKey: undefined,
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ORPHANATT"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('skips when parent has no matching citation in metadata', () => {
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            // Parent exists but no citation for it in this note.
            { ref: 'c_OTHER_0', itemId: '1-OTHERXYZ' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('skips when two metadata entries share the resolved parent (ambiguous)', () => {
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234' },
            { ref: 'c_PARENT_1', itemId: '1-PARENT1234' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });
});

// =============================================================================
// enrichOldStringCitationRefs — combined + edge cases
// =============================================================================

describe('enrichOldStringCitationRefs (combined)', () => {
    it('enriches both item_id and att_id citations in the same pass', () => {
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT9999',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_ITEM_0', itemId: '1-DIRECTKEY' },
            { ref: 'c_PARENT_0', itemId: '1-PARENT9999' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>A <citation item_id="1-DIRECTKEY"/> '
            + 'and B <citation att_id="1-ATTKEY000"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p>A <citation item_id="1-DIRECTKEY" ref="c_ITEM_0"/> '
            + 'and B <citation item_id="1-PARENT9999" ref="c_PARENT_0"/></p>',
        );
    });

    it('returns null when no citations match (no modifications)', () => {
        installZoteroItems(new Map());
        const metadata = buildMetadata([]);
        const result = enrichOldStringCitationRefs(
            '<p>No citations at all.</p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('returns null on empty input', () => {
        expect(enrichOldStringCitationRefs('', buildMetadata([]))).toBeNull();
    });
});

// =============================================================================
// normalizeOldStringCitations — stale ref repair
// =============================================================================
//
// Motivating failure: when the model issues multiple edit_note calls in a
// single turn, the first succeeds and invalidates the simplification cache.
// The next call re-simplifies and the occurrence-counter refs (c_KEY_N) shift,
// so old_strings copied from the pre-edit read_note reference refs that no
// longer match. Repair rewrites the ref to the current one when (item_id,
// page) still uniquely identifies the citation.

describe('normalizeOldStringCitations (stale ref repair)', () => {
    it('leaves a valid ref untouched', () => {
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '12' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation item_id="1-KEY000AA" page="12" label="(X, p. 12)" ref="c_KEY_0"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('rewrites a ref that no longer exists in metadata', () => {
        // Scenario: earlier edit removed c_KEY_4 from the note; the surviving
        // (item_id=1-KEY, page=2) citation is now c_KEY_1. Repair should pick
        // it up.
        const metadata = buildMetadata([
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '2' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation item_id="1-KEY000AA" page="2" ref="c_KEY_4"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-KEY000AA" page="2" ref="c_KEY_1"/></p>',
        );
    });

    it('rewrites a ref that points to a different citation\'s content', () => {
        // Model's ref exists in metadata but points to a different (item_id,
        // page). The model's declared content wins — we look up by it.
        const metadata = buildMetadata([
            { ref: 'c_AAA_0', itemId: '1-AAAA0000', page: '5' },
            { ref: 'c_BBB_0', itemId: '1-BBBB0000', page: '9' },
        ]);
        const result = normalizeOldStringCitations(
            // Model claims item 1-AAAA0000 page 5, but uses ref c_BBB_0.
            '<p><citation item_id="1-AAAA0000" page="5" ref="c_BBB_0"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-AAAA0000" page="5" ref="c_AAA_0"/></p>',
        );
    });

    it('preserves the label attribute when rewriting the ref', () => {
        const metadata = buildMetadata([
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '16' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation item_id="1-KEY000AA" page="16" label="(Törnberg, 2018, p. 16)" ref="c_KEY_5"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-KEY000AA" page="16" label="(Törnberg, 2018, p. 16)" ref="c_KEY_1"/></p>',
        );
    });

    it('skips a stale ref when (item_id, page) is ambiguous in metadata', () => {
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '7' },
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '7' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation item_id="1-KEY000AA" page="7" ref="c_KEY_9"/></p>',
            metadata,
        );
        // Leave it alone; downstream multi-match + target_before_context kicks in.
        expect(result).toBeNull();
    });

    it('skips a stale ref when no citation matches the declared (item_id, page)', () => {
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '1' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation item_id="1-NOMATCHX" page="1" ref="c_KEY_9"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('repairs only the stale citation when a valid one is adjacent', () => {
        // Regression of the thread failure mode: two edits in one turn, the
        // first removed some citations and shifted others. Mixed valid + stale
        // refs in the same old_string should round-trip the valid one and
        // rewrite the stale one.
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '16' },
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '2' },
        ]);
        const result = normalizeOldStringCitations(
            '<p>'
            + '<citation item_id="1-KEY000AA" page="16" ref="c_KEY_0"/>'
            + '<citation item_id="1-KEY000AA" page="2" ref="c_KEY_4"/>'
            + '</p>',
            metadata,
        );
        expect(result).toBe(
            '<p>'
            + '<citation item_id="1-KEY000AA" page="16" ref="c_KEY_0"/>'
            + '<citation item_id="1-KEY000AA" page="2" ref="c_KEY_1"/>'
            + '</p>',
        );
    });

    it('skips compound citations (items=, no item_id) even with a stale ref', () => {
        const metadata = buildMetadata([]);
        addCompound(metadata, 'c_COMPOUND_0');
        const result = normalizeOldStringCitations(
            '<p><citation items="1-AAAA0000, 1-BBBB0000" label="(A; B)" ref="c_NOSUCH_9"/></p>',
            metadata,
        );
        // Compound citations are immutable and have no singular item_id;
        // repair cannot resolve them, so they are left alone.
        expect(result).toBeNull();
    });

    it('preserves a valid ref on an att_id citation and does not re-resolve by content', () => {
        // Regression: a note cites the same parent twice with mixed page
        // representations — e.g. page="4" stored during a cold-cache insert
        // and page="iv" stored later when labels were available. The model's
        // old_string carries att_id + raw page + the ref for the page="4"
        // citation. Re-resolving via the translated page ("iv") would find
        // the OTHER citation and retarget the edit. Preserve the ref.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        installPageLabelCache(new Map([
            // 1-based page 4 → label "iv" (so translation would point at _1).
            [42, ['i', 'ii', 'iii', 'iv', 'v']],
        ]));
        const metadata = buildMetadata([
            // Valid ref for the citation stored with the raw page "4".
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '4' },
            // Sibling citation stored with the translated label "iv".
            { ref: 'c_PARENT_1', itemId: '1-PARENT1234', page: 'iv' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="4" ref="c_PARENT_0"/></p>',
            metadata,
        );
        // Rewrite att_id → item_id but keep the model's ref; use the stored
        // page form so expandToRawHtml's attrsChanged returns false.
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="4" ref="c_PARENT_0"/></p>',
        );
    });

    it('preserves a valid att_id ref even when the page is missing from the tag', () => {
        // Regression for a second reviewer concern: expandToRawHtml('old')
        // returns stored.rawHtml verbatim for tags that have a ref and no
        // item_id (att_id shape falls in that bucket), regardless of what
        // page — if any — the tag carries. A content-based re-resolution
        // here would retarget to a sibling citation when the same parent is
        // cited multiple times with different pages. Preserve the ref.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            // Two citations of the same parent at different pages.
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '7' },
            { ref: 'c_PARENT_1', itemId: '1-PARENT1234' }, // no page
        ]);
        const result = normalizeOldStringCitations(
            // Model omitted the page but supplied the unpaged citation's ref.
            '<p><citation att_id="1-ATTKEY000" ref="c_PARENT_1"/></p>',
            metadata,
        );
        // Keep ref=c_PARENT_1, drop att_id in favor of item_id, no page attr.
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" ref="c_PARENT_1"/></p>',
        );
    });

    it('escapes the stored locator when rewriting a valid att_id ref', () => {
        // Regression: `originalAttrs.page` is stored raw (unescaped) by the
        // simplifier. Interpolating it directly produces malformed markup
        // (e.g. `page="fn. "A""`), which extractAttr/expandToRawHtml can no
        // longer parse. Escape on emission.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: 'fn. "A"' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation att_id="1-ATTKEY000" ref="c_PARENT_0"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="fn. &quot;A&quot;" ref="c_PARENT_0"/></p>',
        );
    });

    it('escapes the stored locator on the att_id content-lookup fallback', () => {
        // Same regression on the no-ref / drifted-ref att_id path. Content
        // lookup finds a unique match whose stored page contains an ampersand;
        // the emitted tag must HTML-escape it.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: 'p. 1 & 2' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="p. 1 &amp; 2"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="p. 1 &amp; 2" ref="c_PARENT_0"/></p>',
        );
    });

    it('falls through to content lookup when an att_id ref points to a different parent', () => {
        // Defense: if the model supplied a ref whose stored entry belongs to
        // a different parent item (hallucinated or wrongly copied), the
        // preserve-ref short-circuit should NOT fire; the content-lookup
        // fallback then repairs via page.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 99,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            // Citation for the correct parent at page 3.
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '3' },
            // A citation for a different parent the model mistakenly referenced.
            { ref: 'c_OTHER_0', itemId: '1-OTHERPARENT', page: '3' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="3" ref="c_OTHER_0"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="3" ref="c_PARENT_0"/></p>',
        );
    });

    it('repairs att_id citations whose ref has drifted', () => {
        // Rare form: the model combined an att_id with a stale ref. Repair
        // should still resolve att_id → parent item_id and rewrite to the
        // simplifier's canonical form with the current ref.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_1', itemId: '1-PARENT1234', page: '4' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="4" ref="c_PARENT_7"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="4" ref="c_PARENT_1"/></p>',
        );
    });

    it('falls through to content lookup when an att_id ref stores a different page', () => {
        // Regression for P1: the same parent item is cited at two different
        // pages. The model's tag carries page="4" but ref="c_PARENT_1"
        // (which stores page="7"). Without a page-parity guard, the
        // preserve-if-valid branch would silently redirect the edit to the
        // page-7 citation. With the guard, the normalizer falls through to
        // content lookup and rewrites the ref to the unique page-4 citation.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '4' },
            { ref: 'c_PARENT_1', itemId: '1-PARENT1234', page: '7' },
        ]);
        const result = normalizeOldStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="4" ref="c_PARENT_1"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="4" ref="c_PARENT_0"/></p>',
        );
    });

    it('treats a ref whose stored entry is a compound citation as stale', () => {
        // Model tag claims item_id=A with ref that in metadata is a compound
        // citation. Repair rewrites to the unique single-citation ref for that
        // (item_id, page).
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '3' },
        ]);
        addCompound(metadata, 'c_KEY_2');
        const result = normalizeOldStringCitations(
            '<p><citation item_id="1-KEY000AA" page="3" ref="c_KEY_2"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-KEY000AA" page="3" ref="c_KEY_0"/></p>',
        );
    });
});

// =============================================================================
// normalizeNewStringCitations — new_string stale-ref repair (no bare enrichment)
// =============================================================================
//
// When a multi-edit turn shifts refs mid-turn, any citation the model copied
// into new_string to PRESERVE an existing citation would otherwise be rebuilt
// by expandToRawHtml('new', ...) — losing stored.rawHtml and re-translating
// numeric page locators. Repair in new_string mirrors the old_string logic
// with one critical exception: a bare citation (no ref) is a legitimate
// new-citation request and must NOT be enriched into a reference to an
// existing citation.

describe('normalizeNewStringCitations', () => {
    it('leaves a bare citation (no ref) untouched even when metadata has a unique match', () => {
        // Regression protection: in new_string, a bare `<citation item_id=... page=.../>`
        // is how the model asks for a NEW citation. If the same item+page already
        // exists in the note, the normalizer must NOT inject that citation's ref
        // and silently deduplicate — leave it alone and let expandToRawHtml handle it
        // as a new citation.
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '5' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation item_id="1-KEY000AA" page="5"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('leaves a bare att_id citation (no ref) untouched', () => {
        // Same principle for att_id form: bare att_id is the canonical
        // new-citation-from-annotation request.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '5' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="5"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('leaves a valid ref untouched', () => {
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '12' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation item_id="1-KEY000AA" page="12" ref="c_KEY_0"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('repairs a stale ref in new_string when (item_id, page) is unique', () => {
        // The main correctness case: the model copied a citation from the
        // pre-edit read_note into new_string to preserve it. A prior edit this
        // turn shifted the ref. Without repair, expandToRawHtml('new') would
        // rebuild the citation as a brand-new one, re-translating the page.
        const metadata = buildMetadata([
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '8' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation item_id="1-KEY000AA" page="8" ref="c_KEY_5"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-KEY000AA" page="8" ref="c_KEY_1"/></p>',
        );
    });

    it('preserves a valid att_id ref in new_string, rewriting att_id → item_id', () => {
        // Matches the old_string behavior: valid ref for parent is preserved
        // even if the page form differs from the stored form.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: '1-PARENT1234', page: '4' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation att_id="1-ATTKEY000" ref="c_PARENT_0"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="4" ref="c_PARENT_0"/></p>',
        );
    });

    it('repairs only the stale ref when mixed with a valid one and a bare new citation', () => {
        // Realistic new_string: the model keeps one existing citation
        // (valid ref), preserves another whose ref drifted (stale), and
        // inserts a bare new citation. Only the stale one is rewritten.
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '1' },
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '8' },
            { ref: 'c_KEY_2', itemId: '1-KEY000AA', page: '16' },
        ]);
        const result = normalizeNewStringCitations(
            '<p>'
            + '<citation item_id="1-KEY000AA" page="1" ref="c_KEY_0"/>'
            + '<citation item_id="1-KEY000AA" page="8" ref="c_KEY_5"/>'
            + '<citation item_id="1-KEY000AA" page="16"/>'
            + '</p>',
            metadata,
        );
        expect(result).toBe(
            '<p>'
            + '<citation item_id="1-KEY000AA" page="1" ref="c_KEY_0"/>'
            + '<citation item_id="1-KEY000AA" page="8" ref="c_KEY_1"/>'
            + '<citation item_id="1-KEY000AA" page="16"/>'
            + '</p>',
        );
    });

    it('skips a stale ref whose (item_id, page) is ambiguous', () => {
        // Conservative under ambiguity — same as old_string path.
        const metadata = buildMetadata([
            { ref: 'c_KEY_0', itemId: '1-KEY000AA', page: '7' },
            { ref: 'c_KEY_1', itemId: '1-KEY000AA', page: '7' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation item_id="1-KEY000AA" page="7" ref="c_KEY_9"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('preserves a ref + mismatched page so locator edits pass through (P2)', () => {
        // Regression for P2: `item_id + ref + new page` is the supported way
        // to edit an existing citation's locator — expandToRawHtml sees the
        // attrs changed and rebuilds the citation with the new page. If the
        // normalizer repaired the ref via content lookup here (finding the
        // sibling citation that already lives at the new page), it would
        // silently redirect the edit and drop the locator change.
        const metadata = buildMetadata([
            { ref: 'c_EX1_0', itemId: '1-KEY000AA', page: '10' },
            { ref: 'c_EX1_1', itemId: '1-KEY000AA', page: '25' },
        ]);
        const result = normalizeNewStringCitations(
            // Model edits c_EX1_0's locator from 10 → 25. Even though
            // (1-KEY000AA, 25) already exists as c_EX1_1, c_EX1_0 must be
            // preserved so expandToRawHtml rebuilds it with the new page.
            '<p><citation item_id="1-KEY000AA" page="25" ref="c_EX1_0"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('preserves an att_id ref + mismatched page in new_string (locator edit via att_id)', () => {
        // Regression for P2a: same parent cited at two pages (page 4 and
        // page 7). The model writes `<citation att_id=... page="7" ref=c_page4/>`
        // to edit c_page4's locator from 4 → 7. The att_id content-lookup
        // fallback must NOT redirect the edit to c_page7; the ref must pass
        // through so expandToRawHtml rebuilds c_page4 with the new page.
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                id: 42,
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_page4', itemId: '1-PARENT1234', page: '4' },
            { ref: 'c_page7', itemId: '1-PARENT1234', page: '7' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation att_id="1-ATTKEY000" page="7" ref="c_page4"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('still repairs a truly fabricated ref (not in metadata) in new_string', () => {
        // Sibling of the P2 test: the ref doesn't exist in metadata at all
        // (stored === undefined), so there's no locator edit to protect.
        // Content lookup finds the real citation for (item, page) and
        // rewrites the fabricated ref.
        const metadata = buildMetadata([
            { ref: 'c_EX1_0', itemId: '1-KEY000AA', page: '10' },
        ]);
        const result = normalizeNewStringCitations(
            '<p><citation item_id="1-KEY000AA" page="10" ref="c_FABRICATED_9"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-KEY000AA" page="10" ref="c_EX1_0"/></p>',
        );
    });
});
