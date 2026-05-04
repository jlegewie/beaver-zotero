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

import { enrichOldStringCitationRefs } from '../../../src/utils/editNoteValidation';
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
