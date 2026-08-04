import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Module mocks
// =============================================================================
// Stub the supabase / agentDataProvider utils transitive deps that the real
// noteCitationExpand module pulls in via zoteroUtils → apiService → supabase.
// These stubs are only here to let the module load in a unit-test harness.

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(() => 'unavailable'),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

// =============================================================================
// Imports
// =============================================================================

import {
    checkNewCitationItemsExist,
    enrichOldStringCitationRefs,
    detectPartialSimplifiedTag,
    buildCitationRefHint,
    buildExpansionErrorMessage,
} from '../../../src/utils/editNoteValidation';
import { expandToRawHtml } from '../../../src/utils/noteCitationExpand';
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
            // Mirrors Zotero's getIDFromLibraryAndKey: a falsy library id
            // throws rather than returning false.
            if (!libId) throw new Error('Library ID not provided');
            return byKey.get(`${libId}-${key}`) ?? false;
        }),
    };
}

// Explicit page-label map (attachment item ID → 0-based page index → label)
// threaded into enrichOldStringCitationRefs. Index 0 is the label for 1-based
// page 1. Populated by installPageLabelCache.
let pageLabels: Record<number, Record<number, string>> = {};
function installPageLabelCache(labelsByItemId: Map<number, string[]>) {
    pageLabels = {};
    for (const [itemId, labels] of labelsByItemId) {
        pageLabels[itemId] = { ...labels };
    }
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

    it('injects ref when a unique unified id + loc match is found in metadata', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA', page: '12' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>Body <citation id="1-AAAAAAAA" loc="page12"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p>Body <citation id="1-AAAAAAAA" loc="page12" ref="c_AAAA_0"/></p>',
        );
    });

    it('does not enrich paragraph-located citations as unpaged item citations', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>Body <citation id="1-AAAAAAAA" loc="p3"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('does not enrich sentence-located citations as unpaged item citations', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: '1-AAAAAAAA' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>Body <citation id="1-AAAAAAAA" sid="s3"/></p>',
            metadata,
        );
        expect(result).toBeNull();
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

    it('rewrites unified id attachment citations to the parent item ref', () => {
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
            '<p><citation id="1-ATTKEY000" loc="page3"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="1-PARENT1234" page="3" ref="c_PARENT_0"/></p>',
        );
    });

    it('does not treat p-prefixed paragraph locators as page locators in old_string', () => {
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
            '<p><citation id="1-ATTKEY000" loc="p3"/></p>',
            metadata,
        );
        expect(result).toBeNull();
    });

    it('does not enrich paragraph-located attachment citations as unpaged parent citations', () => {
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
            '<p><citation id="1-ATTKEY000" loc="p3"/></p>',
            metadata,
        );
        expect(result).toBeNull();
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
            pageLabels,
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
            pageLabels,
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
            pageLabels,
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
            pageLabels,
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
// enrichOldStringCitationRefs — portable ids (dual-form parsing)
// =============================================================================
// The rest of this file leaves `Zotero.Libraries.userLibraryID` unmocked, so
// `modelObjectId`/`modelObjectIdFromReference` never compute a portable ref
// there and fall back to the legacy numeric form untouched — exercising the
// fallback path. This block mocks a real personal-library mapping to prove
// old_string ids in EITHER form (legacy numeric or portable) still match
// metadata built with the portable form `simplifyNoteHtml` now emits.

describe('enrichOldStringCitationRefs (portable ids)', () => {
    beforeEach(() => {
        (globalThis as any).Zotero.Libraries = { userLibraryID: 1 };
    });

    afterEach(() => {
        delete (globalThis as any).Zotero.Libraries;
    });

    it('matches portable metadata against a legacy numeric item_id in old_string', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: 'u-AAAAAAAA', page: '12' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>Body <citation item_id="1-AAAAAAAA" page="12"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p>Body <citation item_id="1-AAAAAAAA" page="12" ref="c_AAAA_0"/></p>',
        );
    });

    it('matches portable metadata against a portable unified id in old_string', () => {
        const metadata = buildMetadata([
            { ref: 'c_AAAA_0', itemId: 'u-AAAAAAAA', page: '12' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p>Body <citation id="u-AAAAAAAA" loc="page12"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p>Body <citation id="u-AAAAAAAA" loc="page12" ref="c_AAAA_0"/></p>',
        );
    });

    it('rewrites att_id to the portable parent item_id when a portable ref is computable', () => {
        installZoteroItems(new Map([
            ['1-ATTKEY000', {
                libraryID: 1,
                parentKey: 'PARENT1234',
                isAttachment: () => true,
            }],
        ]));
        const metadata = buildMetadata([
            { ref: 'c_PARENT_0', itemId: 'u-PARENT1234' },
        ]);
        const result = enrichOldStringCitationRefs(
            '<p><citation att_id="1-ATTKEY000"/></p>',
            metadata,
        );
        expect(result).toBe(
            '<p><citation item_id="u-PARENT1234" ref="c_PARENT_0"/></p>',
        );
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
// detectPartialSimplifiedTag
// =============================================================================

describe('detectPartialSimplifiedTag', () => {
    it('returns null for a complete self-closing citation tag', () => {
        const result = detectPartialSimplifiedTag(
            '<p>foo <citation item_id="1-AAA" page="3"/> bar</p>',
        );
        expect(result).toBeNull();
    });

    it('detects an unclosed citation opener at end of string', () => {
        const result = detectPartialSimplifiedTag('<citation item_id="1-AAA"');
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('citation');
        expect(result?.snippet).toContain('<citation item_id="1-AAA"');
    });

    it('detects a citation opener closed with > instead of />', () => {
        const result = detectPartialSimplifiedTag('<citation item_id="1-AAA">');
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('citation');
        expect(result?.snippet).toContain('<citation item_id="1-AAA">');
    });

    it('detects a bare <annotation opener', () => {
        const result = detectPartialSimplifiedTag('<annotation');
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('annotation');
    });

    it('detects an annotation opener without a closing annotation tag', () => {
        const result = detectPartialSimplifiedTag('<annotation id="a_1">');
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('annotation');
        expect(result?.snippet).toContain('<annotation id="a_1">');
    });

    it('detects a self-closing annotation tag as partial', () => {
        const result = detectPartialSimplifiedTag('<annotation id="a_1"/>');
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('annotation');
    });

    it('returns null for a complete annotation pair', () => {
        const result = detectPartialSimplifiedTag('<annotation id="a_1">quoted text</annotation>');
        expect(result).toBeNull();
    });

    it('does not treat annotation-image tags as annotation partials', () => {
        const result = detectPartialSimplifiedTag('<annotation-image id="ai_1"/>');
        expect(result).toBeNull();
    });

    it('returns null when a complete tag precedes a complete tag (no partials)', () => {
        const result = detectPartialSimplifiedTag(
            '<citation item_id="1-AAA" ref="c_0"/><citation item_id="1-BBB" ref="c_1"/>',
        );
        expect(result).toBeNull();
    });

    it('detects the partial when one complete tag precedes one partial tag', () => {
        const result = detectPartialSimplifiedTag(
            '<citation item_id="1-AAA" ref="c_0"/> and <citation item_id="1-BBB"',
        );
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('citation');
        expect(result?.snippet).toContain('1-BBB');
    });

    it('treats a newline before close as partial (model truncated mid-tag)', () => {
        const result = detectPartialSimplifiedTag(
            '<citation item_id="1-AAA"\n<p>continued</p>',
        );
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('citation');
    });

    it('returns null for normal prose containing < characters (e.g., math)', () => {
        const result = detectPartialSimplifiedTag(
            '<p>where x < 5 and y > 10, see also <em>note</em></p>',
        );
        expect(result).toBeNull();
    });

    it('returns null on empty input', () => {
        expect(detectPartialSimplifiedTag('')).toBeNull();
    });

    it('returns null when neither citation nor annotation opener is present', () => {
        expect(detectPartialSimplifiedTag('<p><strong>bold</strong></p>')).toBeNull();
    });

    it('snippet is bounded to 60 chars from the opener', () => {
        const longAttrs = 'item_id="1-AAA" data-very-long-attribute-value="' + 'x'.repeat(200);
        const result = detectPartialSimplifiedTag(`<citation ${longAttrs}`);
        expect(result).not.toBeNull();
        expect(result!.snippet.length).toBeLessThanOrEqual(60);
    });
});

// =============================================================================
// checkNewCitationItemsExist — unavailable-library refs
// =============================================================================

describe('checkNewCitationItemsExist (portable ids)', () => {
    beforeEach(() => {
        (globalThis as any).Zotero.Libraries = { userLibraryID: 1 };
        (globalThis as any).Zotero.Groups = {
            getLibraryIDFromGroupID: vi.fn(() => false),
            getGroupIDFromLibraryID: vi.fn(() => {
                throw new Error('Group not found');
            }),
        };
    });

    it('reports an unavailable library distinctly, without a Zotero lookup', () => {
        const error = checkNewCitationItemsExist(
            'New text <citation id="g999-ABCD1234"/>.',
            buildMetadata([]),
        );

        expect(error).toContain('not available on this computer');
        expect(error).toContain('g999-ABCD1234');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalled();
    });

    it('reports a genuinely missing item in an available library as nonexistent', () => {
        const error = checkNewCitationItemsExist(
            'New text <citation id="u-MISSING1"/>.',
            buildMetadata([]),
        );

        expect(error).toContain('does not exist');
    });

    it('accepts a new citation whose item exists', () => {
        installZoteroItems(new Map([['1-ABCD1234', { libraryID: 1 }]]));
        const error = checkNewCitationItemsExist(
            'New text <citation id="u-ABCD1234"/>.',
            buildMetadata([]),
        );

        expect(error).toBeNull();
    });

    it('rejects a citation into an excluded library without a Zotero lookup', async () => {
        const { checkLibraryExcluded } = await import('../../../src/services/agentDataProvider/utils');
        vi.mocked(checkLibraryExcluded).mockReturnValueOnce({
            message: 'The library "Private" is excluded from Beaver, so Beaver cannot read or modify its items.',
        });
        installZoteroItems(new Map([['1-ABCD1234', { libraryID: 1 }]]));

        const error = checkNewCitationItemsExist(
            'New text <citation id="u-ABCD1234"/>.',
            buildMetadata([]),
        );

        // The gate must fire before the existence lookup so the response can't
        // reveal whether the item exists in the excluded library.
        expect(error).toContain('excluded from Beaver');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalled();
    });
});

// =============================================================================
// buildCitationRefHint
// =============================================================================

/** Build a simplified note paragraph carrying one citation tag. */
function para(text: string, ref?: string): string {
    const tag = ref ? ` <citation id="u-ABCD1234" ref="${ref}"/>` : '';
    return `<p>${text}${tag}</p>`;
}

describe('buildCitationRefHint', () => {
    it('returns null when the note has no citations', () => {
        expect(buildCitationRefHint('<p>Plain prose only.</p>', 'anything')).toBeNull();
    });

    it('lists every tag when the note has few, and names the ref as copyable', () => {
        const note = [para('First point', 'c_ABCD1234_0'), para('Second point', 'c_ABCD1234_1')].join('\n');

        const hint = buildCitationRefHint(note, 'First point');

        expect(hint).toContain('All 2 citation tags in the note:');
        expect(hint).toContain('<citation id="u-ABCD1234" ref="c_ABCD1234_0"/>');
        expect(hint).toContain('<citation id="u-ABCD1234" ref="c_ABCD1234_1"/>');
        expect(hint).toContain('Copy one of these verbatim');
    });

    it('uses singular phrasing for a lone citation', () => {
        const hint = buildCitationRefHint(para('Only point', 'c_ABCD1234_0'), 'Only point');

        expect(hint).toContain("The note's only citation tag:");
    });

    /** Six paragraphs, one citation each, distinct topics per paragraph. */
    const sixParaNote = [
        para('Alpha discussion of migration patterns', 'c_ABCD1234_0'),
        para('Beta discussion of trade balances', 'c_ABCD1234_1'),
        para('Gamma discussion of urban housing', 'c_ABCD1234_2'),
        para('Delta discussion of labor unions', 'c_ABCD1234_3'),
        para('Epsilon discussion of tax policy', 'c_ABCD1234_4'),
        para('Zeta discussion of school choice', 'c_ABCD1234_5'),
    ].join('\n');

    it('caps the list and picks the citations nearest to old_string', () => {
        const hint = buildCitationRefHint(sixParaNote, 'Zeta discussion of school choice', 2);

        expect(hint).toContain('The 2 citation tags in the note closest to your old_string (of 6 total):');
        expect(hint).toContain('ref="c_ABCD1234_5"');
        expect(hint).toContain('ref="c_ABCD1234_4"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
    });

    it('anchors on a mid-note region rather than defaulting to an end of the note', () => {
        const hint = buildCitationRefHint(sixParaNote, 'Gamma discussion of urban housing', 3) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_1"');
        expect(hint).toContain('ref="c_ABCD1234_2"');
        expect(hint).toContain('ref="c_ABCD1234_3"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
        expect(hint).not.toContain('ref="c_ABCD1234_5"');
    });

    it('falls back to the head of the note when old_string has no scoreable words', () => {
        const note = [
            para('Alpha', 'c_ABCD1234_0'),
            para('Beta', 'c_ABCD1234_1'),
            para('Gamma', 'c_ABCD1234_2'),
        ].join('\n');

        const hint = buildCitationRefHint(note, '</p>', 2);

        expect(hint).toContain('ref="c_ABCD1234_0"');
        expect(hint).toContain('ref="c_ABCD1234_1"');
        expect(hint).not.toContain('ref="c_ABCD1234_2"');
    });

    it('lists picked tags in document order, not nearest-first order', () => {
        // Nearest-first ranks _5 ahead of _4; the rendered block must undo that
        // so the tags read in the same order as the note itself.
        const hint = buildCitationRefHint(sixParaNote, 'Zeta discussion of school choice', 2) ?? '';

        expect(hint.indexOf('c_ABCD1234_4')).toBeLessThan(hint.indexOf('c_ABCD1234_5'));
    });

    /**
     * One paragraph carrying six citations, so the whole note is a single line.
     * Canonical note HTML only breaks lines at block boundaries, so a note like
     * this gives the anchor no line to choose — it has to resolve an offset
     * inside the line.
     */
    const oneLineNote = '<p>'
        + [
            'Alpha discussion of migration patterns',
            'Beta discussion of trade balances',
            'Gamma discussion of urban housing',
            'Delta discussion of labor unions',
            'Epsilon discussion of tax policy',
            'Zeta discussion of school choice',
        ]
            .map((text, i) => `${text} <citation id="u-ABCD1234" ref="c_ABCD1234_${i}"/>`)
            .join('. ')
        + '</p>';

    it('anchors inside the line for a newline-free note targeting a later section', () => {
        expect(oneLineNote).not.toContain('\n');

        const hint = buildCitationRefHint(oneLineNote, 'Zeta discussion of school choice', 2) ?? '';

        expect(hint).toContain('The 2 citation tags in the note closest to your old_string (of 6 total):');
        expect(hint).toContain('ref="c_ABCD1234_5"');
        expect(hint).toContain('ref="c_ABCD1234_4"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
    });

    it('anchors mid-line for a newline-free note targeting a middle section', () => {
        const hint = buildCitationRefHint(oneLineNote, 'Gamma discussion of urban housing', 3) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_1"');
        expect(hint).toContain('ref="c_ABCD1234_2"');
        expect(hint).toContain('ref="c_ABCD1234_3"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
        expect(hint).not.toContain('ref="c_ABCD1234_5"');
    });

    /**
     * One paragraph whose sections share most of their wording, so the words
     * that identify the target section are a minority of the phrase's words.
     */
    const repeatedPhraseNote = '<p>'
        + ['migration', 'trade balances', 'urban housing', 'labor unions', 'tax policy', 'school choice']
            .map((topic, i) => `Discussion of ${topic} and evidence <citation id="u-ABCD1234" ref="c_ABCD1234_${i}"/>`)
            .join('. ')
        + '</p>';

    it('anchors on the identifying words, not on shared phrase words repeated earlier', () => {
        // 'discussion', 'and' and 'evidence' occur in every section; only
        // 'school' and 'choice' identify the target one.
        const hint = buildCitationRefHint(repeatedPhraseNote, 'Discussion of school choice and evidence', 2) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_5"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
        expect(hint).not.toContain('ref="c_ABCD1234_1"');
    });

    it('anchors on a middle section whose identifying words repeat elsewhere', () => {
        const hint = buildCitationRefHint(repeatedPhraseNote, 'Discussion of urban housing and evidence', 3) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_2"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
        expect(hint).not.toContain('ref="c_ABCD1234_5"');
    });

    it('anchors on a single identifying word among otherwise identical sections', () => {
        // Every word but the topic is shared by all six sections, so one word
        // carries the entire signal.
        const sections = ['migration', 'trade', 'housing', 'labor', 'taxes', 'schooling'].map(
            (topic) => `The results of the study on ${topic} were consistent with the theory`,
        );
        const note = '<p>'
            + sections.map((s, i) => `${s} <citation id="u-ABCD1234" ref="c_ABCD1234_${i}"/>`).join('. ')
            + '</p>';

        const hint = buildCitationRefHint(note, sections[5], 2) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_5"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
    });

    it('does not let a word repeated across a line outscore the line that matches most', () => {
        // 'discussion' recurs in every paragraph, so scoring occurrences rather
        // than distinct words would let any paragraph beat the real target.
        const hint = buildCitationRefHint(sixParaNote, 'discussion discussion discussion school choice', 2) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_5"');
        expect(hint).not.toContain('ref="c_ABCD1234_0"');
    });

    it('scores prose only, never tag names or attribute values', () => {
        // old_string is entirely markup vocabulary present in every tag; none of
        // it may score, so this has to fall back to the head of the note.
        const hint = buildCitationRefHint(sixParaNote, 'citation ref ABCD1234', 2) ?? '';

        expect(hint).toContain('ref="c_ABCD1234_0"');
        expect(hint).toContain('ref="c_ABCD1234_1"');
        expect(hint).not.toContain('ref="c_ABCD1234_5"');
    });

    it('does not run past a tag whose attribute value contains escaped angle brackets', () => {
        const note = `<p>Text <citation id="u-ABCD1234" label="a &gt; b" ref="c_ABCD1234_0"/> more</p>`;

        const hint = buildCitationRefHint(note, 'Text');

        expect(hint).toContain('<citation id="u-ABCD1234" label="a &gt; b" ref="c_ABCD1234_0"/>');
        expect(hint).not.toContain('more</p>');
    });
});

// =============================================================================
// buildExpansionErrorMessage
// =============================================================================

describe('buildExpansionErrorMessage', () => {
    const note = [
        para('Migration patterns shifted', 'c_ABCD1234_0'),
        para('Trade balances followed', 'c_ABCD1234_1'),
    ].join('\n');

    /** Run the real expansion so the tests exercise the thrown error, not a stub. */
    function expandOldString(oldString: string, refsInNote: string[]): unknown {
        const metadata = buildMetadata(
            refsInNote.map((ref) => ({ ref, itemId: 'u-ABCD1234' })),
        );
        try {
            expandToRawHtml(oldString, metadata, 'old');
            return null;
        } catch (e) {
            return e;
        }
    }

    it('appends the note\'s real tags when old_string names a ref the note lacks', () => {
        const error = expandOldString(
            '<citation id="u-ABCD1234" ref="c_ABCD1234_4"/>',
            ['c_ABCD1234_0', 'c_ABCD1234_1'],
        );

        const message = buildExpansionErrorMessage(error, note, '<citation id="u-ABCD1234" ref="c_ABCD1234_4"/>');

        expect(message).toContain('ref="c_ABCD1234_4"');
        expect(message).toContain('All 2 citation tags in the note:');
        expect(message).toContain('ref="c_ABCD1234_0"');
    });

    it('keeps the "old_string" mention the backend branches on for re-read escalation', () => {
        const error = expandOldString(
            '<citation id="u-ABCD1234" ref="c_ABCD1234_4"/>',
            ['c_ABCD1234_0'],
        );

        const message = buildExpansionErrorMessage(error, note, 'x');

        expect(message).toContain('old_string');
    });

    it('tags the unresolvable-identity throw too (citation in old_string with no ref)', () => {
        const error = expandOldString('<citation id="u-ZZZZ9999"/>', ['c_ABCD1234_0']);

        const message = buildExpansionErrorMessage(error, note, '<citation id="u-ZZZZ9999"/>');

        expect(message).toContain('was not found in the note');
        expect(message).toContain('All 2 citation tags in the note:');
    });

    it('passes a non-citation expansion failure through unchanged', () => {
        const error = new Error('Something else broke');

        expect(buildExpansionErrorMessage(error, note, 'x')).toBe('Something else broke');
    });

    it('leaves the citation-ref error unchanged when the note has no citations', () => {
        const error = expandOldString(
            '<citation id="u-ABCD1234" ref="c_ABCD1234_4"/>',
            ['c_ABCD1234_0'],
        );
        const baseMessage = (error as Error).message;

        expect(buildExpansionErrorMessage(error, '<p>No citations here.</p>', 'x')).toBe(baseMessage);
    });

    it('stringifies a non-Error throw', () => {
        expect(buildExpansionErrorMessage('boom', note, 'x')).toBe('boom');
    });

    it('falls back to the plain message when hint construction throws', () => {
        const error = expandOldString(
            '<citation id="u-ABCD1234" ref="c_ABCD1234_4"/>',
            ['c_ABCD1234_0'],
        );
        const baseMessage = (error as Error).message;
        // A throwing `simplified` stands in for any defect inside hint
        // construction. The caller has already committed to reporting
        // expansion_failed, so escaping here would downgrade a precise error
        // into an opaque one.
        const hostile = { split() { throw new Error('boom'); } } as unknown as string;

        expect(buildExpansionErrorMessage(error, hostile, 'x')).toBe(baseMessage);
    });
});
