/**
 * Focused unit tests for getDeferredToolPreference and hasFullLibraryAccess
 * (src/services/agentDataProvider/utils.ts) — the seam every deferred tool
 * asks whether it may apply on its own.
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that these functions never touch, so every unrelated
 * dependency is stubbed out just to make the module importable in isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
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
    deferredToolPreferencesAtom: Symbol('deferredToolPreferencesAtom'),
}));
vi.mock('../../../react/atoms/libraryPermission', () => ({
    hasFullLibraryAccessAtom: Symbol('hasFullLibraryAccessAtom'),
}));
vi.mock('../../../react/atoms/runApprovalPolicy', () => ({
    runApprovalPolicyAtom: Symbol('runApprovalPolicyAtom'),
    isActionApprovedForCurrentRun: vi.fn(() => false),
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
    isLibraryAccessReadyAtom: Symbol('isLibraryAccessReadyAtom'),
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

import { store } from '../../../react/store';
import { hasFullLibraryAccessAtom } from '../../../react/atoms/libraryPermission';
import { deferredToolPreferencesAtom } from '../../../react/atoms/deferredToolPreferences';
import {
    getDeferredToolPreference,
    hasFullLibraryAccess,
} from '../../../src/services/agentDataProvider/utils';

/** The stored preferences a user configured in Settings. */
const STORED = {
    toolToGroup: {
        edit_metadata: 'metadata_edits',
        edit_note: 'note_edits',
        delete_annotations: 'annotation_deletion',
    },
    groupPreferences: {
        metadata_edits: 'always_ask',
        note_edits: 'continue_without_applying',
    },
};

function setFullAccess(enabled: boolean) {
    vi.mocked(store.get).mockImplementation((atom: any) => {
        if (atom === hasFullLibraryAccessAtom) return enabled;
        if (atom === deferredToolPreferencesAtom) return STORED;
        return undefined;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('getDeferredToolPreference', () => {
    it('reads the stored preference while the composer asks permission', () => {
        setFullAccess(false);

        expect(getDeferredToolPreference('edit_metadata')).toBe('always_ask');
        expect(getDeferredToolPreference('edit_note')).toBe('continue_without_applying');
    });

    it('falls back to always_ask for a group with no stored preference', () => {
        setFullAccess(false);

        expect(getDeferredToolPreference('delete_annotations')).toBe('always_ask');
    });

    it('applies every tool under full access, stored preference and all', () => {
        setFullAccess(true);

        expect(getDeferredToolPreference('edit_metadata')).toBe('always_apply');
        // The stored choice not to be interrupted is overridden too: the user
        // has since asked for changes to be applied.
        expect(getDeferredToolPreference('edit_note')).toBe('always_apply');
    });

    it('covers the groups that have no Preferences row under full access', () => {
        setFullAccess(true);

        expect(getDeferredToolPreference('delete_annotations')).toBe('always_apply');
        expect(getDeferredToolPreference('destructive_note_rewrite')).toBe('always_apply');
    });

    it('asks when the store cannot be read', () => {
        vi.mocked(store.get).mockImplementation(() => {
            throw new Error('store unavailable');
        });

        expect(getDeferredToolPreference('edit_metadata')).toBe('always_ask');
    });
});

describe('hasFullLibraryAccess', () => {
    it('reports the composer mode', () => {
        setFullAccess(true);
        expect(hasFullLibraryAccess()).toBe(true);

        setFullAccess(false);
        expect(hasFullLibraryAccess()).toBe(false);
    });

    it('reports no grant when the store cannot be read', () => {
        vi.mocked(store.get).mockImplementation(() => {
            throw new Error('store unavailable');
        });

        expect(hasFullLibraryAccess()).toBe(false);
    });
});
