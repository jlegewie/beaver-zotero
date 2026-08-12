import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock noteHtmlSimplifier
vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn((_noteId: string, _rawHtml: string, _libId: number) => ({
        simplified: 'Line one\nLine two\nLine three\nLine four\nLine five',
        metadata: { elements: new Map() },
        isStale: false,
    })),
    normalizeNoteHtml: vi.fn((html: string) => html),
}));

// Mock noteEditorIO. Must export every symbol handleReadNoteRequest imports;
// missing exports surface as `undefined` at module load and cause cryptic
// "x is not a function" failures.
vi.mock('../../../src/utils/noteEditorIO', () => ({
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    getNoteHtmlForRead: vi.fn(async (item: any) => item.getNote()),
    getLiveNoteHtmlCandidates: vi.fn(() => []),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeItemSummary: vi.fn(async (item: any) => ({
        id: `${item.libraryID}-${item.key}`,
        title: item.title || item.key,
    })),
    serializeItemStub: vi.fn((item: any) => ({
        library_id: item.libraryID,
        zotero_key: item.key,
        item_type: item.itemType,
        title: item.title || item.key,
    })),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    prepareAttachmentInfoBatchData: vi.fn(async () => ({ bestAttachmentMap: new Map() })),
    processAttachmentInfoBatch: vi.fn(async () => []),
    toAttachmentSummary: vi.fn((attachment: any) => attachment),
    checkLibraryExcluded: vi.fn(() => null),
}));

// Mock logger
vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

// Mock transitive dependencies pulled in by agentDataProvider
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: {
        auth: { getSession: vi.fn() },
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: '123', localUserKey: 'abc' })),
    createCitationHTML: vi.fn(),
}));

vi.mock('../../../react/atoms/profile', () => ({
    userIdentifierAtom: {},
    searchableLibraryIdsAtom: {},
    syncWithZoteroAtom: {},
}));

vi.mock('../../../react/atoms/auth', () => ({
    userIdAtom: {},
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() },
}));

import { handleReadNoteRequest } from '../../../src/services/agentDataProvider/handleReadNoteRequest';
import { getOrSimplify } from '../../../src/utils/noteHtmlSimplifier';
import { getLatestNoteHtml, getNoteHtmlForRead } from '../../../src/utils/noteEditorIO';
import { checkAddressSnapshot, snapshotNoteId } from '../../../src/utils/noteSnapshot';
import type { WSReadNoteRequest } from '@beaver/agent-core/protocol/agentProtocol';


// =============================================================================
// Helpers
// =============================================================================

function makeRequest(overrides: Partial<WSReadNoteRequest> = {}): WSReadNoteRequest {
    return {
        event: 'read_note_request',
        request_id: 'req-1',
        note_id: '1-ABCD1234',
        ...overrides,
    };
}

function makeMockItem(overrides: any = {}) {
    return {
        isNote: vi.fn(() => true),
        isPDFAttachment: vi.fn(() => false),
        itemType: 'note',
        libraryID: 1,
        key: 'ABCD1234',
        id: 42,
        parentItem: null,
        loadDataType: vi.fn().mockResolvedValue(undefined),
        getNote: vi.fn(() => '<div data-schema-version="9"><p>Content</p></div>'),
        getNoteTitle: vi.fn(() => 'Test Note'),
        ...overrides,
    };
}

function makeMockRegularItem(key: string, overrides: any = {}) {
    return {
        libraryID: 1,
        key,
        title: `Title ${key}`,
        deleted: false,
        isRegularItem: vi.fn(() => true),
        ...overrides,
    };
}

function makeMockCitedNote(key: string, overrides: any = {}) {
    return {
        libraryID: 1,
        key,
        deleted: false,
        itemType: 'note',
        isRegularItem: vi.fn(() => false),
        isNote: vi.fn(() => true),
        isAnnotation: vi.fn(() => false),
        loadDataType: vi.fn().mockResolvedValue(undefined),
        getNote: vi.fn(() => '<p>Project note body</p>'),
        getNoteTitle: vi.fn(() => 'Project note'),
        ...overrides,
    };
}

function makeMockAnnotation(key: string, overrides: any = {}) {
    return {
        libraryID: 1,
        key,
        deleted: false,
        itemType: 'annotation',
        isRegularItem: vi.fn(() => false),
        isNote: vi.fn(() => false),
        isAnnotation: vi.fn(() => true),
        annotationText: 'Highlighted text',
        annotationComment: 'Annotation comment',
        annotationPageLabel: '12',
        parentKey: 'ATTACH12',
        ...overrides,
    };
}


// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();

    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Items: {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(makeMockItem()),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        },
    };
});


// =============================================================================
// Success Cases
// =============================================================================

describe('handleReadNoteRequest — success', () => {
    it('returns success with correct title, total_lines, and content without line numbers', async () => {
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(response.title).toBe('Test Note');
        expect(response.total_lines).toBe(5);
        expect(response.content).toContain('Line one');
        expect(response.content).toContain('Line five');
        expect(response.content).not.toContain('1|');
        expect(response.note_id).toBe('1-ABCD1234');
        expect(response.has_more).toBe(false);
        expect(response.next_offset).toBeUndefined();
        expect(response.lines_returned).toBe('1-5');
    });

    it('includes parent_item_id and parent_title when note has parent', async () => {
        const parentItem = {
            libraryID: 1,
            key: 'PARENT01',
            loadDataType: vi.fn().mockResolvedValue(undefined),
            getField: vi.fn(() => 'Parent Article'),
        };
        const item = makeMockItem({ parentItem });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(response.parent_item_id).toBe('1-PARENT01');
        expect(response.parent_title).toBe('Parent Article');
    });

    it('returns error for empty note', async () => {
        const item = makeMockItem({ getNote: vi.fn(() => ''), getNoteTitle: vi.fn(() => '') });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('is empty');
    });

    it('returns (untitled) for note without title', async () => {
        const item = makeMockItem({ getNoteTitle: vi.fn(() => '') });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(response.title).toBe('(untitled)');
    });
});


// =============================================================================
// Pagination
// =============================================================================

describe('handleReadNoteRequest — pagination', () => {
    it('offset starts at correct line (1-indexed)', async () => {
        const response = await handleReadNoteRequest(makeRequest({ offset: 3 }));
        expect(response.success).toBe(true);
        expect(response.content).toContain('Line three');
        expect(response.content).not.toContain('Line one');
        expect(response.content).not.toContain('Line two');
        expect(response.has_more).toBe(false);
        expect(response.next_offset).toBeUndefined();
        expect(response.lines_returned).toBe('3-5');
    });

    it('limit caps output and sets has_more', async () => {
        const response = await handleReadNoteRequest(makeRequest({ limit: 2 }));
        expect(response.success).toBe(true);
        expect(response.content).toContain('Line one');
        expect(response.content).toContain('Line two');
        expect(response.content).not.toContain('Line three');
        expect(response.has_more).toBe(true);
        expect(response.next_offset).toBe(3);
        expect(response.lines_returned).toBe('1-2');
    });

    it('offset + limit combination', async () => {
        const response = await handleReadNoteRequest(makeRequest({ offset: 2, limit: 2 }));
        expect(response.success).toBe(true);
        expect(response.content).toContain('Line two');
        expect(response.content).toContain('Line three');
        expect(response.content).not.toContain('Line one');
        expect(response.content).not.toContain('Line four');
        expect(response.has_more).toBe(true);
        expect(response.next_offset).toBe(4);
        expect(response.lines_returned).toBe('2-3');
    });

    it('offset beyond total returns empty content', async () => {
        const response = await handleReadNoteRequest(makeRequest({ offset: 100 }));
        expect(response.success).toBe(true);
        expect(response.content).toBe('');
        expect(response.total_lines).toBe(5);
        expect(response.has_more).toBe(false);
        expect(response.next_offset).toBeUndefined();
    });

    it('offset defaults to 1 (reads from beginning)', async () => {
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(response.content).toContain('Line one');
        expect(response.content).not.toContain('1|');
    });

    it('has_more is false at exact boundary', async () => {
        const response = await handleReadNoteRequest(makeRequest({ limit: 5 }));
        expect(response.success).toBe(true);
        expect(response.has_more).toBe(false);
        expect(response.next_offset).toBeUndefined();
        expect(response.lines_returned).toBe('1-5');
    });

    it('lines_returned shows single line for single-line result', async () => {
        const response = await handleReadNoteRequest(makeRequest({ offset: 3, limit: 1 }));
        expect(response.success).toBe(true);
        expect(response.lines_returned).toBe('3');
        expect(response.has_more).toBe(true);
        expect(response.next_offset).toBe(4);
    });
});

// =============================================================================
// Address snapshot
// =============================================================================

// The simplified projection the default getOrSimplify mock returns; the digest
// is defined over exactly this whole-note string, never over a paginated slice.
const WHOLE_NOTE = 'Line one\nLine two\nLine three\nLine four\nLine five';

describe('handleReadNoteRequest — address snapshot', () => {
    // The mock item is note 1-ABCD1234; the digest is bound to that identity.
    const NOTE_ID = snapshotNoteId(1, 'ABCD1234');

    it('emits a token bound to this note and its whole projection', async () => {
        const response = await handleReadNoteRequest(makeRequest());

        expect(response.success).toBe(true);
        expect(response.snapshot).toBeTypeOf('string');
        expect(checkAddressSnapshot(response.snapshot!, NOTE_ID, WHOLE_NOTE))
            .toBe('match');
    });

    it('refuses to verify against a different note with the same content', async () => {
        const response = await handleReadNoteRequest(makeRequest());

        expect(checkAddressSnapshot(response.snapshot!, snapshotNoteId(1, 'OTHER999'), WHOLE_NOTE))
            .toBe('mismatch');
        expect(checkAddressSnapshot(response.snapshot!, snapshotNoteId(2, 'ABCD1234'), WHOLE_NOTE))
            .toBe('mismatch');
    });

    // THE SAFETY RULE. The token covers the WHOLE note, so handing one out
    // after a partial read would license numeric addresses into pages the model
    // never saw. `expect` cannot catch that on its own: over half a note's lines
    // have no visible text and are confirmed only by their tag, and a ranged
    // delete confirms only its endpoints. So a paged read gets content and NO
    // token, and the model must read the note whole before addressing it.
    it('withholds the token from every partial read', async () => {
        for (const args of [
            { offset: 1, limit: 2 },   // first page
            { offset: 3, limit: 2 },   // middle page
            { offset: 2 },             // tail only — still not the whole note
            { limit: 4 },              // head only
        ]) {
            const response = await handleReadNoteRequest(makeRequest(args));
            expect(response.success).toBe(true);
            expect(response.content).toBeTruthy();
            expect(response.snapshot).toBeUndefined();
        }
    });

    it('issues the token when a limit happens to cover the whole note', async () => {
        // Paginated in form, complete in fact — what matters is what was SHOWN.
        const whole = await handleReadNoteRequest(makeRequest());
        const covering = await handleReadNoteRequest(makeRequest({ offset: 1, limit: 5 }));
        const overshoot = await handleReadNoteRequest(makeRequest({ offset: 1, limit: 500 }));

        expect(covering.snapshot).toBe(whole.snapshot);
        expect(overshoot.snapshot).toBe(whole.snapshot);
    });

    it('withholds the token when the offset is beyond the end', async () => {
        const response = await handleReadNoteRequest(makeRequest({ offset: 100 }));

        // An out-of-range read is harmless, not a failed tool call — but it
        // showed nothing, so it certainly licenses nothing.
        expect(response.success).toBe(true);
        expect(response.content).toBe('');
        expect(response.snapshot).toBeUndefined();
    });

    // `offset`/`limit` are typed `number?` on the wire and reach this handler
    // verbatim from the MCP and HTTP entry points, so the backend's `ge=1` bound
    // is not the only line of defence. Sanitizing here is what keeps
    // `lines_returned` and `next_offset` coherent for every input.
    it.each([
        // A present-but-nonsense limit clamps to ONE line, not to zero and not
        // to "no limit": the caller asked to be limited, and a page of zero
        // lines would surface as the "note is empty" error.
        ['negative limit', { limit: -1 }, '1', 2],
        ['zero limit', { limit: 0 }, '1', 2],
        ['fractional limit', { limit: 2.5 }, '1-2', 3],
        ['negative offset', { offset: -3 }, '1-5', undefined],
        ['zero offset', { offset: 0 }, '1-5', undefined],
        ['fractional offset', { offset: 2.5 }, '2-5', undefined],
        ['NaN offset', { offset: NaN }, '1-5', undefined],
        ['NaN limit', { limit: NaN }, '1-5', undefined],
    ])('sanitizes %s into a coherent page', async (_name, args, linesReturned, nextOffset) => {
        const response = await handleReadNoteRequest(makeRequest(args));

        expect(response.success).toBe(true);
        expect(response.error).toBeUndefined();
        expect(response.lines_returned).toBe(linesReturned);
        expect(response.next_offset).toBe(nextOffset);
        // Never a self-referential next page: following next_offset must advance.
        if (response.next_offset !== undefined) {
            expect(response.next_offset).toBeGreaterThan(1);
        }
        // A token iff the sanitized page covered the whole note.
        if (linesReturned === '1-5') {
            expect(checkAddressSnapshot(response.snapshot!, NOTE_ID, WHOLE_NOTE))
            .toBe('match');
        } else {
            expect(response.snapshot).toBeUndefined();
        }
    });

    it('is stable across identical reads and changes when the note content changes', async () => {
        const first = await handleReadNoteRequest(makeRequest());
        const second = await handleReadNoteRequest(makeRequest());
        expect(first.snapshot).toBe(second.snapshot);

        vi.mocked(getOrSimplify).mockReturnValueOnce({
            simplified: 'Line one\nLine two CHANGED\nLine three\nLine four\nLine five',
            metadata: { elements: new Map() },
            isStale: false,
        });
        const afterEdit = await handleReadNoteRequest(makeRequest());

        expect(afterEdit.success).toBe(true);
        expect(afterEdit.snapshot).not.toBe(first.snapshot);
    });
});

describe('handleReadNoteRequest — cited_items extraction', () => {
    it('populates cited_items from unified, compound, and legacy item citations', async () => {
        vi.mocked(getOrSimplify).mockReturnValueOnce({
            simplified: [
                '<p><citation id="1-CITED1" ref="c_CITED1_0"/></p>',
                '<p><citation items="1-A, 1-B:page=4" ref="c_A+B_0"/></p>',
                '<p><citation item_id="1-LEGACY" ref="c_LEGACY_0"/></p>',
            ].join('\n'),
            metadata: { elements: new Map() },
            isStale: false,
        });

        const note = makeMockItem();
        const items = new Map([
            ['1-CITED1', makeMockRegularItem('CITED1')],
            ['1-A', makeMockRegularItem('A')],
            ['1-B', makeMockRegularItem('B')],
            ['1-LEGACY', makeMockRegularItem('LEGACY')],
        ]);
        const getByLibraryAndKeyAsync = vi.fn(async (libraryId: number, key: string) => {
            if (key === 'ABCD1234') return note;
            return items.get(`${libraryId}-${key}`) ?? null;
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = getByLibraryAndKeyAsync;

        const response = await handleReadNoteRequest(makeRequest());

        expect(response.success).toBe(true);
        expect(response.cited_items?.map((item: any) => item.id)).toEqual([
            '1-CITED1',
            '1-A',
            '1-B',
            '1-LEGACY',
        ]);
        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith(
            expect.arrayContaining([...items.values()]),
            ["primaryData", "itemData", "creators", "tags", "collections", "childItems"],
        );
    });

    it('does not populate cited_items from attachment citations', async () => {
        vi.mocked(getOrSimplify).mockReturnValueOnce({
            simplified: '<p><citation att_id="1-ATTACH1" page="3"/></p>',
            metadata: { elements: new Map() },
            isStale: false,
        });

        const note = makeMockItem();
        const getByLibraryAndKeyAsync = vi.fn(async (_libraryId: number, key: string) => {
            return key === 'ABCD1234' ? note : makeMockRegularItem(key);
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = getByLibraryAndKeyAsync;

        const response = await handleReadNoteRequest(makeRequest());

        expect(response.success).toBe(true);
        expect(response.cited_items).toBeUndefined();
        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalledWith(1, 'ATTACH1');
    });

    it('populates cited_items for note and annotation link citations', async () => {
        vi.mocked(getOrSimplify).mockReturnValueOnce({
            simplified: [
                '<p><citation id="1-NOTE9999" ref="c_NOTE9999_0"/></p>',
                '<p><citation id="1-ANNOT999" ref="c_ANNOT999_0"/></p>',
            ].join('\n'),
            metadata: { elements: new Map() },
            isStale: false,
        });

        const note = makeMockItem();
        const citedNote = makeMockCitedNote('NOTE9999');
        const annotation = makeMockAnnotation('ANNOT999');
        const getByLibraryAndKeyAsync = vi.fn(async (_libraryId: number, key: string) => {
            if (key === 'ABCD1234') return note;
            if (key === 'NOTE9999') return citedNote;
            if (key === 'ANNOT999') return annotation;
            return null;
        });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = getByLibraryAndKeyAsync;

        const response = await handleReadNoteRequest(makeRequest());

        expect(response.success).toBe(true);
        expect(response.cited_items).toEqual([
            expect.objectContaining({
                library_id: 1,
                zotero_key: 'NOTE9999',
                item_type: 'note',
                title: 'Project note',
                preview: 'body',
            }),
            expect.objectContaining({
                library_id: 1,
                zotero_key: 'ANNOT999',
                item_type: 'annotation',
                annotation_text: 'Highlighted text',
                annotation_comment: 'Annotation comment',
                page_label: '12',
                parent_key: 'ATTACH12',
            }),
        ]);
        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith([citedNote], ["itemData", "note"]);
        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith([annotation], ["annotation", "annotationDeferred"]);
    });
});


// =============================================================================
// Error Cases
// =============================================================================

describe('handleReadNoteRequest — errors', () => {
    it('rejects invalid note_id format (no dash)', async () => {
        const response = await handleReadNoteRequest(makeRequest({ note_id: 'NODASH' }));
        expect(response.success).toBe(false);
        expect(response.error).toContain('Invalid note_id format');
    });

    it('rejects non-numeric library ID', async () => {
        const response = await handleReadNoteRequest(makeRequest({ note_id: 'abc-KEY' }));
        expect(response.success).toBe(false);
        expect(response.error).toContain('Invalid note_id format');
    });

    it('rejects empty key', async () => {
        const response = await handleReadNoteRequest(makeRequest({ note_id: '1-' }));
        expect(response.success).toBe(false);
        expect(response.error).toContain('Invalid note_id format');
    });

    it('returns error when note not found', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(null);
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('Note not found');
    });

    it('returns error when item is not a note', async () => {
        const item = makeMockItem({ isNote: vi.fn(() => false), itemType: 'journalArticle' });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('not a note');
        expect(response.error).toContain('journalArticle');
    });

    it('handles Zotero API throwing gracefully', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockRejectedValue(new Error('DB error'));
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('DB error');
    });

    it('handles getOrSimplify throwing gracefully', async () => {
        vi.mocked(getOrSimplify).mockImplementationOnce(() => { throw new Error('Simplification failed'); });
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('Simplification failed');
    });
});


// =============================================================================
// Read-only path integration
// =============================================================================
//
// Narrow scope: this only verifies the handler integrates correctly with
// `getNoteHtmlForRead`. The fallback / multi-editor / retry behavior is
// covered against fake `Zotero.Notes._editorInstances` in
// `tests/unit/notes/noteEditorIO.test.ts` — testing it through a mocked
// helper here would not exercise the real fallback.

describe('handleReadNoteRequest — read-only path', () => {
    it('awaits getNoteHtmlForRead and surfaces its return value', async () => {
        // Helper returns content distinct from getNote so we can prove the
        // handler sourced its raw HTML from the helper, not from item.getNote.
        const sentinel = '<div data-schema-version="9"><p>FROM HELPER</p></div>';
        vi.mocked(getNoteHtmlForRead).mockResolvedValueOnce(sentinel);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(getNoteHtmlForRead).toHaveBeenCalledTimes(1);
        // The simplifier mock just returns its preset lines, but the handler
        // must have called it — proving rawHtml made it through.
        expect(getOrSimplify).toHaveBeenCalledTimes(1);
        expect(vi.mocked(getOrSimplify).mock.calls[0][1]).toBe(sentinel);
    });

    it('returns empty_note error when getNoteHtmlForRead resolves empty', async () => {
        vi.mocked(getNoteHtmlForRead).mockResolvedValueOnce('');
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('is empty');
    });

    it('returns empty_note error when helper resolves whitespace-only HTML', async () => {
        vi.mocked(getNoteHtmlForRead).mockResolvedValueOnce('   \n\t');
        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(false);
        expect(response.error).toContain('is empty');
    });

    it('NEVER calls item.setNote from the read path (regression guard)', async () => {
        // The whole point of using getNoteHtmlForRead instead of
        // flushLiveEditorToDB is that the read path must never persist a
        // transient empty live-editor snapshot.
        const setNote = vi.fn();
        const item = makeMockItem({ setNote });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        await handleReadNoteRequest(makeRequest());
        expect(setNote).not.toHaveBeenCalled();
    });
});


// =============================================================================
// Portable note ids
// =============================================================================

describe('handleReadNoteRequest — portable note ids', () => {
    let savedLibraries: any;
    let savedGroups: any;

    beforeEach(() => {
        const Z = (globalThis as any).Zotero;
        savedLibraries = Z.Libraries;
        savedGroups = Z.Groups;
        Z.Libraries = { ...Z.Libraries, userLibraryID: 1 };
        Z.Groups = {
            getLibraryIDFromGroupID: vi.fn((groupID: number) => (groupID === 4321 ? 7 : false)),
            getGroupIDFromLibraryID: vi.fn((libraryID: number) => {
                if (libraryID === 7) return 4321;
                throw new Error('Group not found');
            }),
        };
    });

    afterEach(() => {
        const Z = (globalThis as any).Zotero;
        Z.Libraries = savedLibraries;
        Z.Groups = savedGroups;
    });

    it('resolves a personal-library portable note_id and echoes it back', async () => {
        const response = await handleReadNoteRequest(makeRequest({ note_id: 'u-ABCD1234' }));
        expect(response.success).toBe(true);
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(1, 'ABCD1234');
        expect(response.note_id).toBe('u-ABCD1234');
    });

    it('resolves a group portable note_id via the local group mapping', async () => {
        const item = makeMockItem({ libraryID: 7 });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest({ note_id: 'g4321-ABCD1234' }));
        expect(response.success).toBe(true);
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(7, 'ABCD1234');
    });

    it('reports an unavailable library for an unmapped group ref without a lookup', async () => {
        const response = await handleReadNoteRequest(makeRequest({ note_id: 'g9999-ABCD1234' }));
        expect(response.success).toBe(false);
        expect(response.error).toContain('not available on this computer');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    // The id is built from the RESOLVED item, so both grammars converge on the
    // portable form — the one the address snapshot binds, and the one that has
    // to mean the same note on another device.
    it('keys the simplification cache by the resolved portable id regardless of the requested grammar', async () => {
        await handleReadNoteRequest(makeRequest({ note_id: 'u-ABCD1234' }));
        expect(vi.mocked(getOrSimplify).mock.calls[0][0]).toBe('u-ABCD1234');

        vi.mocked(getOrSimplify).mockClear();
        await handleReadNoteRequest(makeRequest({ note_id: '1-ABCD1234' }));
        expect(vi.mocked(getOrSimplify).mock.calls[0][0]).toBe('u-ABCD1234');
    });

    it('emits a portable parent_item_id when the parent library maps', async () => {
        const parentItem = {
            libraryID: 1,
            key: 'PARENT01',
            loadDataType: vi.fn().mockResolvedValue(undefined),
            getField: vi.fn(() => 'Parent Article'),
        };
        const item = makeMockItem({ parentItem });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(response.parent_item_id).toBe('u-PARENT01');
    });
});
