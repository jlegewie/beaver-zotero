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
    isAttachment?: boolean;
    isNote?: boolean;
    isAnnotation?: boolean;
    isRegularItem?: boolean;
    noteHTML?: string;
    attachmentContentType?: string;
    attachmentFilename?: string;
    attachmentLinkMode?: number;
    attachmentPath?: string;
    deleted?: boolean;
    bestAttachment?: Zotero.Item | false | null;
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
        isAttachment = false,
        isNote = false,
        isAnnotation = false,
        isRegularItem = !isAttachment && !isNote && !isAnnotation,
        noteHTML = '',
        attachmentContentType = '',
        attachmentFilename = '',
        attachmentLinkMode = (globalThis as any).Zotero?.Attachments?.LINK_MODE_IMPORTED_FILE ?? 0,
        attachmentPath = '',
        deleted = false,
        bestAttachment = null,
    } = opts;

    const linkedUrlMode = (globalThis as any).Zotero?.Attachments?.LINK_MODE_LINKED_URL ?? 3;
    const importedUrlMode = (globalThis as any).Zotero?.Attachments?.LINK_MODE_IMPORTED_URL ?? 1;

    return {
        id,
        key,
        libraryID,
        itemType,
        parentID,
        attachmentContentType,
        attachmentFilename,
        attachmentLinkMode,
        attachmentPath,
        deleted,
        getField: vi.fn((field: string) => fields[field] ?? ''),
        setField: vi.fn(),
        getCreators: vi.fn(() => creators),
        getTags: vi.fn(() => tags),
        getNotes: vi.fn(() => noteIDs),
        getAttachments: vi.fn(() => attachmentIDs),
        getBestAttachment: vi.fn(async () => bestAttachment),
        getCollections: vi.fn(() => []),
        isAttachment: vi.fn(() => isAttachment),
        isNote: vi.fn(() => isNote),
        isAnnotation: vi.fn(() => isAnnotation),
        isRegularItem: vi.fn(() => isRegularItem),
        isFileAttachment: vi.fn(() => isAttachment && attachmentLinkMode !== linkedUrlMode),
        isPDFAttachment: vi.fn(() => isAttachment && attachmentLinkMode !== linkedUrlMode && attachmentContentType === 'application/pdf'),
        isEPUBAttachment: vi.fn(() => isAttachment && attachmentLinkMode !== linkedUrlMode && attachmentContentType === 'application/epub+zip'),
        isSnapshotAttachment: vi.fn(() => attachmentLinkMode === importedUrlMode && attachmentContentType === 'text/html'),
        isImageAttachment: vi.fn(() => isAttachment && attachmentLinkMode !== linkedUrlMode && attachmentContentType.startsWith('image/')),
        getNote: vi.fn(() => noteHTML),
        setNote: vi.fn(),
        saveTx: vi.fn(),
        save: vi.fn(),
        loadDataType: vi.fn(),
        loadAllData: vi.fn(),
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
}

/**
 * Create a mock Zotero note item.
 */
export function createMockNote(opts: MockNoteOptions = {}) {
    return createMockItem({
        itemType: 'note',
        isNote: true,
        isRegularItem: false,
        ...opts,
    });
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
    filename?: string;
    linkMode?: number;
    path?: string;
    deleted?: boolean;
}

/**
 * Create a mock Zotero attachment item.
 */
export function createMockAttachment(opts: MockAttachmentOptions = {}) {
    const {
        contentType = 'application/pdf',
        filename = 'file.pdf',
        linkMode = (globalThis as any).Zotero?.Attachments?.LINK_MODE_IMPORTED_FILE ?? 0,
        path = '/mock/path/file.pdf',
        ...rest
    } = opts;
    return createMockItem({
        itemType: 'attachment',
        isAttachment: true,
        isRegularItem: false,
        attachmentContentType: contentType,
        attachmentFilename: filename,
        attachmentLinkMode: linkMode,
        attachmentPath: path,
        ...rest,
    });
}
