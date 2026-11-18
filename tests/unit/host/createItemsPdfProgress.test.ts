import { describe, expect, it } from 'vitest';

import {
    actionCardProgressMessage,
    createItemsPdfSummary,
} from '../../../react/host/zotero/components/agentActionViewHelpers';

describe('actionCardProgressMessage', () => {
    const open = { isCallOpen: true, isAwaitingApproval: false };

    it('shows create_items progress while its items are being added', () => {
        expect(actionCardProgressMessage('create_items', 'Adding items · 2 of 5', { ...open, status: 'awaiting' }))
            .toBe('Adding items · 2 of 5');
    });

    it('keeps create_items progress after its actions settle, while the call waits on PDF fetches', () => {
        expect(actionCardProgressMessage('create_items', 'Fetching PDFs · 1 of 4', { ...open, status: 'applied' }))
            .toBe('Fetching PDFs · 1 of 4');
        expect(actionCardProgressMessage('create_items', 'Fetching PDF', { ...open, status: 'error' }))
            .toBe('Fetching PDF');
    });

    it('hides the progress of other tools once their action settles', () => {
        expect(actionCardProgressMessage('edit_metadata', 'Zotero is still applying this change…', { ...open, status: 'applied' }))
            .toBeNull();
        expect(actionCardProgressMessage('edit_metadata', 'Zotero is still applying this change…', { ...open, status: 'awaiting' }))
            .toBe('Zotero is still applying this change…');
    });

    it('hides progress once the call returned or the run ended', () => {
        expect(actionCardProgressMessage('create_items', 'Fetching PDFs · 3 of 4', { ...open, isCallOpen: false, status: 'applied' }))
            .toBeNull();
    });

    it('hides progress while the card waits on the user', () => {
        expect(actionCardProgressMessage('create_items', 'Adding items · 0 of 2', { ...open, isAwaitingApproval: true, status: 'awaiting' }))
            .toBeNull();
    });

    it('shows nothing without a progress note', () => {
        expect(actionCardProgressMessage('create_items', undefined, { ...open, status: 'applied' })).toBeNull();
    });
});

describe('createItemsPdfSummary', () => {
    describe('several items', () => {
        it('counts the items that got a PDF', () => {
            expect(createItemsPdfSummary(['available', 'available', 'failed'], false)).toBe('2 with PDF');
            expect(createItemsPdfSummary(['available', 'available', 'available'], false)).toBe('3 with PDF');
        });

        it('says when no PDF was found', () => {
            expect(createItemsPdfSummary(['failed', 'failed', 'none'], false)).toBe('no PDFs found');
        });

        it('names fetches still running', () => {
            expect(createItemsPdfSummary(['available', 'fetching', 'fetching'], false)).toBe('1 with PDF · 2 fetching');
            expect(createItemsPdfSummary(['fetching', 'failed'], false)).toBe('fetching 1 PDF');
            expect(createItemsPdfSummary(['fetching', 'fetching'], false)).toBe('fetching 2 PDFs');
        });

        it('stays quiet when no item had a PDF or a fetch', () => {
            expect(createItemsPdfSummary(['none', 'none'], false)).toBeNull();
            expect(createItemsPdfSummary([], false)).toBeNull();
        });
    });

    describe('one item', () => {
        it('says whether it got a PDF', () => {
            expect(createItemsPdfSummary(['available'], true)).toBe('with PDF');
            expect(createItemsPdfSummary(['failed'], true)).toBe('no PDF found');
            expect(createItemsPdfSummary(['fetching'], true)).toBe('fetching PDF');
        });

        it('stays quiet without a fetch', () => {
            expect(createItemsPdfSummary(['none'], true)).toBeNull();
        });
    });
});
