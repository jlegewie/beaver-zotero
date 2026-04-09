import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock noteHtmlSimplifier
vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn((_noteId: string, _rawHtml: string, _libId: number) => ({
        simplified: 'Line one\nLine two\nLine three\nLine four\nLine five',
        metadata: { elements: new Map() },
        isStale: false,
    })),
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    normalizeNoteHtml: vi.fn((html: string) => html),
}));

// Mock logger
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// Mock transitive dependencies pulled in by agentDataProvider
vi.mock('../../../src/services/supabaseClient', () => ({
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
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() },
}));

import { handleReadNoteRequest } from '../../../src/services/agentDataProvider/handleReadNoteRequest';
import { getOrSimplify, getLatestNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import type { WSReadNoteRequest } from '../../../src/services/agentProtocol';


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


// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
    vi.clearAllMocks();

    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Items: {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(makeMockItem()),
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

    it('handles empty note', async () => {
        const item = makeMockItem({ getNote: vi.fn(() => ''), getNoteTitle: vi.fn(() => '') });
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn().mockResolvedValue(item);

        const response = await handleReadNoteRequest(makeRequest());
        expect(response.success).toBe(true);
        expect(response.total_lines).toBe(0);
        expect(response.content).toBe('(empty note)');
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
