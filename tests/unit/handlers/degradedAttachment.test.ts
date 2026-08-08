/**
 * Unit tests for degradedAttachmentInfo / degradedAttachmentRow
 * (src/services/agentDataProvider/utils.ts) — the stubs the list, search, and
 * metadata handlers fall back to when one record throws while being read.
 *
 * The module has a wide transitive dependency surface these functions never
 * touch, so every unrelated dependency is stubbed out just to make the module
 * importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn() },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

import {
    degradedAttachmentInfo,
    degradedAttachmentRow,
} from '../../../src/services/agentDataProvider/utils';

/**
 * An attachment whose `attachmentFilename` getter throws the way Zotero's does
 * when `PathUtils.filename()` cannot parse the stored path.
 */
function makeMalformedAttachment(overrides: Record<string, unknown> = {}): Zotero.Item {
    return {
        libraryID: 1,
        key: 'BADATT1',
        dateModified: '2024-05-01 12:00:00',
        getDisplayTitle: () => 'Broken PDF',
        get attachmentFilename(): string {
            throw new Error(
                'OperationError: PathUtils.filename: Could not initialize path: '
                + 'NS_ERROR_FILE_UNRECOGNIZED_PATH'
            );
        },
        attachmentPath: '/Volumes/other/paper.pdf',
        ...overrides,
    } as unknown as Zotero.Item;
}

describe('degradedAttachmentInfo', () => {
    let previousZotero: any;

    beforeEach(() => {
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: { userLibraryID: 1 },
            Groups: { getGroupIDFromLibraryID: vi.fn(() => false) },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('identifies the row and recovers what it can without throwing', () => {
        const info = degradedAttachmentInfo(makeMalformedAttachment(), 'u-PARENT12');

        expect(info).toEqual(expect.objectContaining({
            attachment_id: 'u-BADATT1',
            parent_item_id: 'u-PARENT12',
            title: 'Broken PDF',
            // Recovered from attachmentPath, since the getter throws.
            filename: 'paper.pdf',
            content_kind: 'other',
            status: 'unreadable',
        }));
        expect(info.status_reason).toBeTruthy();
    });

    it('defaults is_primary to false for callers that do not know', () => {
        expect(degradedAttachmentInfo(makeMalformedAttachment(), null).is_primary).toBe(false);
    });

    it('preserves is_primary when the caller resolved the best attachment', () => {
        // get_metadata computes this before resolving the attachment; losing it
        // would tell the model the parent item has no primary attachment.
        const info = degradedAttachmentInfo(makeMalformedAttachment(), 'u-PARENT12', true);
        expect(info.is_primary).toBe(true);
    });

    it('survives an item whose title and dateModified also throw', () => {
        // Built literally rather than via makeMalformedAttachment: an object
        // spread would evaluate these getters before the helper ever runs.
        const hostile = {
            libraryID: 1,
            key: 'BADATT1',
            getDisplayTitle: () => {
                throw new Error('unavailable');
            },
            get dateModified(): string {
                throw new Error('unavailable');
            },
            get attachmentFilename(): string {
                throw new Error('NS_ERROR_FILE_UNRECOGNIZED_PATH');
            },
            attachmentPath: undefined,
        } as unknown as Zotero.Item;

        const row = degradedAttachmentRow(hostile, null);
        expect(row).toEqual(expect.objectContaining({
            result_type: 'attachment',
            attachment_id: 'u-BADATT1',
            title: null,
            filename: null,
            date_modified: null,
            status: 'unreadable',
        }));
    });
});

describe('degradedAttachmentRow', () => {
    let previousZotero: any;

    beforeEach(() => {
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: { userLibraryID: 1 },
            Groups: { getGroupIDFromLibraryID: vi.fn(() => false) },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('carries the parent anchor through to the search/list row', () => {
        const parent = {
            item_id: 'u-PARENT12',
            item_type: 'journalArticle',
            title: 'Parent Paper',
            creators: null,
            year: null,
        };

        const row = degradedAttachmentRow(makeMalformedAttachment(), parent as any);

        expect(row).toEqual(expect.objectContaining({
            result_type: 'attachment',
            parent_item_id: 'u-PARENT12',
            parent_title: 'Parent Paper',
            parent_item: parent,
            date_modified: '2024-05-01 12:00:00',
            // list/search rows never resolve the parent's best attachment.
            is_primary: false,
        }));
    });
});
