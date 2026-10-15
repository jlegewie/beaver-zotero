import { describe, it, expect, vi } from 'vitest';
import { Action } from '@beaver/agent-core/types/actions';

// Stub the leaf modules with import-time side effects (see categoryGroups.test.ts).
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: () => true,
    isAgentSupportedItem: () => true,
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => 'Mock Item' }));

import { computeActionGroups, getActiveTarget, type ActionContext } from '../../../react/utils/actionVisibility';

function unloadedDataError(): Error {
    const error = new Error("Item data not loaded and field 'title' not set for item 3/46GA3WJK");
    error.name = 'UnloadedDataException';
    return error;
}

/** An attachment from a library that has not been opened: only primary data is loaded. */
function unloadedAttachment(): Zotero.Item {
    return {
        libraryID: 3,
        key: '46GA3WJK',
        isRegularItem: () => false,
        isAttachment: () => true,
        isNote: () => false,
        getItemTypeIconName: () => 'attachmentPDF',
        getDisplayTitle: () => { throw unloadedDataError(); },
    } as unknown as Zotero.Item;
}

const ACTIONS: Action[] = [{ id: 'summarize', title: 'Summarize', text: 'prompt', targets: ['attachment'] }];

function context(overrides: Partial<ActionContext['zotero']>, manualItems: Zotero.Item[]): ActionContext {
    return {
        zotero: {
            type: 'library',
            readerAttachment: null,
            noteItem: null,
            selectedItems: [],
            libraryView: { selectedCollections: [], selectedRowCount: 0 },
            ...overrides,
        } as unknown as ActionContext['zotero'],
        manualItems,
    };
}

describe('action group labels for items whose data is not loaded', () => {
    it('labels an attached item generically instead of throwing', () => {
        const groups = computeActionGroups(ACTIONS, context({}, [unloadedAttachment()]));
        expect(groups.find(g => g.id === 'manual')?.label).toBe('Attachment (attached)');
    });

    it('labels the reader attachment generically instead of throwing', () => {
        const groups = computeActionGroups(ACTIONS, context({ type: 'reader', readerAttachment: unloadedAttachment() } as any, []));
        expect(groups.find(g => g.id === 'reader')?.label).toBe('Attachment');
    });

    it('gives the active target a generic label instead of throwing', () => {
        expect(getActiveTarget(context({}, [unloadedAttachment()]))?.label).toBe('Attachment');
    });
});
