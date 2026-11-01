import { describe, expect, it } from 'vitest';
import {
    createdItemRef,
    isImportItemAgentAction,
    isItemCreatingAgentAction,
    itemActionExternalId,
    toAgentAction,
} from '@beaver/agent-core/agents/agentActionTypes';

const importAction = (overrides: Record<string, any> = {}) => toAgentAction({
    action_type: 'import_item',
    proposed_data: { source: { kind: 'identifier', input: 'doi:10.1/x' } },
    ...overrides,
});

describe('import_item action type guards', () => {
    it('recognizes import_item and create_item as item-creating, nothing else', () => {
        expect(isImportItemAgentAction(importAction())).toBe(true);
        expect(isItemCreatingAgentAction(importAction())).toBe(true);
        expect(isItemCreatingAgentAction(toAgentAction({ action_type: 'create_item', proposed_data: { item: {} } }))).toBe(true);
        const other = toAgentAction({ action_type: 'create_collection', proposed_data: { name: 'x' } });
        expect(isItemCreatingAgentAction(other)).toBe(false);
        expect(isImportItemAgentAction(other)).toBe(false);
    });
});

describe('createdItemRef', () => {
    it('returns the created item reference for an applied import_item', () => {
        const action = importAction({ result_data: { zotero_key: 'ABCD1234', library_id: 1 } });
        expect(createdItemRef(action)).toEqual({ library_id: 1, zotero_key: 'ABCD1234' });
    });

    it('carries the portable library_ref when present', () => {
        const action = importAction({ result_data: { zotero_key: 'ABCD1234', library_id: 7, library_ref: 'g12345' } });
        expect(createdItemRef(action)).toEqual({ library_id: 7, zotero_key: 'ABCD1234', library_ref: 'g12345' });
    });

    it('works for create_item results too', () => {
        const action = toAgentAction({
            action_type: 'create_item',
            proposed_data: { item: {} },
            result_data: { zotero_key: 'KEYKEY12', library_id: 1 },
        });
        expect(createdItemRef(action)).toMatchObject({ library_id: 1, zotero_key: 'KEYKEY12' });
    });

    it('is null for an action without a result or of another type', () => {
        expect(createdItemRef(importAction())).toBeNull();
        const other = toAgentAction({ action_type: 'create_collection', proposed_data: { name: 'x' }, result_data: { collection_id: 'u-ABCD1234' } });
        expect(createdItemRef(other)).toBeNull();
    });

    it('is null when the result has no usable library identity', () => {
        const action = importAction({ result_data: { zotero_key: 'ABCD1234', library_id: 0 } });
        expect(createdItemRef(action)).toBeNull();
    });
});

describe('itemActionExternalId', () => {
    it('reads the search-provider id of an import_item source', () => {
        const action = importAction({
            proposed_data: { source: { kind: 'external', input: 'W123', external_id: 'W123', provider: 'openalex' } },
        });
        expect(itemActionExternalId(action)).toBe('W123');
    });

    it('reads source_id of a legacy create_item', () => {
        const action = toAgentAction({ action_type: 'create_item', proposed_data: { item: { source_id: 'W999' } } });
        expect(itemActionExternalId(action)).toBe('W999');
    });

    it('is undefined without an id or for other action types', () => {
        expect(itemActionExternalId(importAction())).toBeUndefined();
        expect(itemActionExternalId(toAgentAction({ action_type: 'create_collection', proposed_data: {} }))).toBeUndefined();
    });
});

describe('toAgentAction for import_item', () => {
    it('normalizes proposed data: numeric library id, camelCase ref, default arrays', () => {
        const action = toAgentAction({
            action_type: 'import_item',
            proposed_data: {
                libraryId: '12',
                libraryRef: 'g12345',
                source: { kind: 'url', input: 'https://example.org' },
                item: { itemType: 'webpage', title: 'T' },
                tags: ['a', 'b'],
            },
        });
        expect(action.proposed_data).toMatchObject({
            library_id: 12,
            library_ref: 'g12345',
            source: { kind: 'url', input: 'https://example.org' },
            item: { itemType: 'webpage', title: 'T' },
            pdf_candidates: [],
            tags: ['a', 'b'],
        });
    });

    it('leaves library_id undefined for missing or non-numeric values', () => {
        expect(importAction().proposed_data.library_id).toBeUndefined();
        const bad = toAgentAction({ action_type: 'import_item', proposed_data: { library_id: 'abc', source: { kind: 'file', input: 'f' } } });
        expect(bad.proposed_data.library_id).toBeUndefined();
    });

    it('substitutes an empty identifier source when the backend sent none', () => {
        const action = toAgentAction({ action_type: 'import_item', proposed_data: {} });
        expect(action.proposed_data.source).toEqual({ kind: 'identifier', input: '' });
    });

    it('drops a non-array tags value and keeps pdf candidates', () => {
        const action = toAgentAction({
            action_type: 'import_item',
            proposed_data: { source: { kind: 'identifier', input: 'x' }, tags: 'nope', pdf_candidates: [{ url: 'https://x/y.pdf' }] },
        });
        expect(action.proposed_data.tags).toBeUndefined();
        expect(action.proposed_data.pdf_candidates).toEqual([{ url: 'https://x/y.pdf' }]);
    });

    it('normalizes result data from camelCase and defaults the attachment status', () => {
        const action = importAction({
            result_data: { zoteroKey: 'ABCD1234', libraryId: 3, libraryRef: 'g1', fileAttachmentKey: '3-FILEKEY1' },
        });
        expect(action.result_data).toMatchObject({
            zotero_key: 'ABCD1234',
            library_id: 3,
            library_ref: 'g1',
            attachment_status: 'none',
            file_attachment_key: '3-FILEKEY1',
        });
    });

    it('keeps explicit snake_case result fields', () => {
        const action = importAction({
            result_data: {
                zotero_key: 'ABCD1234',
                library_id: 1,
                attachment_status: 'pending',
                attachment_key: '1-PDFKEY12',
                collection_keys: ['COLLKEY1'],
            },
        });
        expect(action.result_data).toMatchObject({
            attachment_status: 'pending',
            attachment_key: '1-PDFKEY12',
            collection_keys: ['COLLKEY1'],
        });
    });
});
