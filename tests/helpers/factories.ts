/**
 * Shared test factories for creating mock Zotero objects.
 *
 * Inspired by Zotero's `support.js` — provides reusable factory functions
 * so tests don't duplicate mock setup code.
 */

import { vi } from 'vitest';

// =============================================================================
// Zotero Item
// =============================================================================

export interface MockItemOptions {
    id?: number;
    key?: string;
    libraryID?: number;
    itemType?: string;
    fields?: Record<string, string>;
    creators?: Array<{ firstName?: string; lastName?: string; creatorType: string }>;
    tags?: Array<{ tag: string; type?: number }>;
    noteIDs?: number[];
    attachmentIDs?: number[];
    parentID?: number | null;
    parentItem?: any;
    isTopLevelItem?: boolean;
    isAttachment?: boolean;
    isNote?: boolean;
    isRegularItem?: boolean;
    noteHTML?: string;
    attachmentContentType?: string;
    attachmentPath?: string;
}

/**
 * Create a mock Zotero.Item with sensible defaults.
 *
 * ```ts
 * const item = createMockItem({ id: 42, fields: { title: 'My Paper' } });
 * item.getField('title'); // 'My Paper'
 * ```
 */
export function createMockItem(opts: MockItemOptions = {}) {
    const {
        id = 1,
        key = 'ABCD1234',
        libraryID = 1,
        itemType = 'journalArticle',
        fields = {},
        creators = [],
        tags = [],
        noteIDs = [],
        attachmentIDs = [],
        parentID = null,
        parentItem = null,
        isTopLevelItem = parentID === null,
        isAttachment = false,
        isNote = false,
        isRegularItem = !isAttachment && !isNote,
        noteHTML = '',
        attachmentContentType = '',
        attachmentPath = '',
    } = opts;

    return {
        id,
        key,
        libraryID,
        itemType,
        parentID,
        parentItem,
        attachmentContentType,
        attachmentPath,
        getField: vi.fn((field: string) => fields[field] ?? ''),
        setField: vi.fn(),
        getCreators: vi.fn(() => creators),
        getTags: vi.fn(() => tags),
        getNotes: vi.fn(() => noteIDs),
        getAttachments: vi.fn(() => attachmentIDs),
        getCollections: vi.fn(() => []),
        isTopLevelItem: vi.fn(() => isTopLevelItem),
        isAttachment: vi.fn(() => isAttachment),
        isNote: vi.fn(() => isNote),
        isRegularItem: vi.fn(() => isRegularItem),
        getNote: vi.fn(() => noteHTML),
        setNote: vi.fn(),
        saveTx: vi.fn(),
        save: vi.fn(),
        loadDataType: vi.fn(),
        _loaded: { itemData: true },
    };
}

// =============================================================================
// Zotero Note Item
// =============================================================================

export interface MockNoteOptions {
    id?: number;
    key?: string;
    libraryID?: number;
    parentID?: number | null;
    noteHTML?: string;
    /**
     * Title returned by getNoteTitle(). Only note factories expose this method —
     * real Zotero.Item.getNoteTitle throws for non-note items.
     */
    noteTitle?: string;
}

/**
 * Create a mock Zotero note item.
 */
export function createMockNote(opts: MockNoteOptions = {}) {
    const { noteTitle = '(untitled)', ...rest } = opts;
    const base = createMockItem({
        itemType: 'note',
        isNote: true,
        isRegularItem: false,
        ...rest,
    });
    return {
        ...base,
        getNoteTitle: vi.fn(() => noteTitle),
    };
}

// =============================================================================
// Zotero Attachment Item
// =============================================================================

export interface MockAttachmentOptions {
    id?: number;
    key?: string;
    libraryID?: number;
    parentID?: number | null;
    contentType?: string;
    path?: string;
}

/**
 * Create a mock Zotero attachment item.
 */
export function createMockAttachment(opts: MockAttachmentOptions = {}) {
    const { contentType = 'application/pdf', path = '/mock/path/file.pdf', ...rest } = opts;
    return createMockItem({
        itemType: 'attachment',
        isAttachment: true,
        isRegularItem: false,
        attachmentContentType: contentType,
        attachmentPath: path,
        ...rest,
    });
}
