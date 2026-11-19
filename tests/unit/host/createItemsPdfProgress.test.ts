import { describe, expect, it } from 'vitest';

import {
    actionCardProgressMessage,
    createdItemsFullText,
    createItemsFullTextSummary,
    fullTextRowLabel,
} from '../../../react/host/zotero/components/agentActionViewHelpers';

describe('actionCardProgressMessage', () => {
    const open = { isCallOpen: true, isAwaitingApproval: false };

    it('shows create_items progress while its items are being added', () => {
        expect(actionCardProgressMessage('create_items', 'Adding items (2 of 5)', { ...open, status: 'awaiting' }))
            .toBe('Adding items (2 of 5)');
    });

    it('keeps create_items progress after its actions settle, while the call waits on PDF fetches', () => {
        expect(actionCardProgressMessage('create_items', 'Fetching PDFs (1 of 4)', { ...open, status: 'applied' }))
            .toBe('Fetching PDFs (1 of 4)');
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
        expect(actionCardProgressMessage('create_items', 'Fetching PDFs (3 of 4)', { ...open, isCallOpen: false, status: 'applied' }))
            .toBeNull();
    });

    it('hides progress while the card waits on the user', () => {
        expect(actionCardProgressMessage('create_items', 'Adding items (0 of 2)', { ...open, isAwaitingApproval: true, status: 'awaiting' }))
            .toBeNull();
    });

    it('shows nothing without a progress note', () => {
        expect(actionCardProgressMessage('create_items', undefined, { ...open, status: 'applied' })).toBeNull();
    });
});

const pdf = { attachment_id: 'u-PDF1', content_kind: 'pdf', status: 'readable', is_primary: true };
const snapshot = { attachment_id: 'u-SNAP1', content_kind: 'snapshot', status: 'readable', is_primary: true };

function created(key: string, attachments?: unknown[]) {
    return { outcome: 'created', item_id: `u-${key}`, title: key, ...(attachments ? { attachments } : {}) };
}

function toolReturn(items: unknown[], extra: Record<string, unknown> = {}) {
    return { part_kind: 'tool-return', tool_name: 'create_items', tool_call_id: 'call-1', content: { items }, ...extra } as any;
}

describe('createdItemsFullText', () => {
    it('reads the full text of each created item from the return', () => {
        const result = toolReturn([
            created('AAAA1111', [pdf]),
            created('BBBB2222', []),
            created('CCCC3333', [{ ...snapshot, is_primary: false }, snapshot]),
            { outcome: 'already_in_library', item_id: 'u-DDDD4444', attachments: [pdf] },
            { outcome: 'failed', input: '10.1/x' },
        ]);
        expect(createdItemsFullText(result)).toEqual([
            { zoteroKey: 'AAAA1111', kind: 'pdf' },
            { zoteroKey: 'BBBB2222', kind: null },
            { zoteroKey: 'CCCC3333', kind: 'snapshot' },
        ]);
    });

    it('takes the key from a group or numeric item id', () => {
        const result = toolReturn([
            { outcome: 'created', item_id: 'g12-GROUPKEY', attachments: [] },
            { outcome: 'created', item_id: '1-LOCALKEY', attachments: [] },
        ]);
        expect(createdItemsFullText(result)?.map((item) => item.zoteroKey)).toEqual(['GROUPKEY', 'LOCALKEY']);
    });

    it('marks an item whose attachments the return does not report', () => {
        expect(createdItemsFullText(toolReturn([created('AAAA1111')]))).toEqual([{ zoteroKey: 'AAAA1111', kind: undefined }]);
    });

    it('has nothing to read without a successful return in the v2 shape', () => {
        expect(createdItemsFullText(undefined)).toBeNull();
        expect(createdItemsFullText({ part_kind: 'retry-prompt', tool_call_id: 'call-1', content: 'x' } as any)).toBeNull();
        expect(createdItemsFullText({ part_kind: 'tool-return', tool_call_id: 'call-1', content: { items_created: {} } } as any)).toBeNull();
    });
});

describe('createItemsFullTextSummary', () => {
    const summary = (items: unknown[], single = false) =>
        createItemsFullTextSummary(createdItemsFullText(toolReturn(items)), single);

    it('counts the created items with full text', () => {
        expect(summary([created('A', [pdf]), created('B', [snapshot]), created('C', [])])).toBe('2 with full text');
        expect(summary([created('A', [pdf]), created('B', [pdf])])).toBe('2 with full text');
    });

    it('says when no created item got full text', () => {
        expect(summary([created('A', []), created('B', [])])).toBe('no full text');
    });

    it('words it for a card titled by its one item', () => {
        expect(summary([created('A', [pdf])], true)).toBe('with full text');
        expect(summary([created('A', [])], true)).toBe('no full text');
    });

    it('says nothing when no item was created', () => {
        expect(summary([{ outcome: 'already_in_library', item_id: 'u-A', attachments: [pdf] }])).toBeNull();
        expect(summary([])).toBeNull();
    });

    it('says nothing when a created item lacks its attachments', () => {
        expect(summary([created('A', [pdf]), created('B')])).toBeNull();
    });

    it('says nothing without a return', () => {
        expect(createItemsFullTextSummary(null, false)).toBeNull();
    });
});

describe('fullTextRowLabel', () => {
    it('names the kind of full text a row got', () => {
        expect(fullTextRowLabel('pdf')).toBe('PDF attached');
        expect(fullTextRowLabel('snapshot')).toBe('Snapshot saved');
        expect(fullTextRowLabel('epub')).toBe('EPUB attached');
        expect(fullTextRowLabel('docx')).toBe('File attached');
        expect(fullTextRowLabel(null)).toBe('No full text');
    });
});
