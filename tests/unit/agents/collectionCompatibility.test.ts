import { readCollectionActionData } from '@beaver/agent-core/identity/collectionActionData';
import { describe, expect, it } from 'vitest';
import { extractListCollectionsData } from '@beaver/agent-core/run-state/toolResultTypes';
import { toAgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { batchOutcomeTarget, batchItemGroupFor } from '@beaver/agent-core/run-state/batchProgress';
import { messageAttachmentIdentity, normalizeCollectionAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { collectionReferenceKey } from '@beaver/agent-core/types/zotero';

describe('collection wire compatibility', () => {
    it('reads future ID-only rows and historical scoped keys together', () => {
        const data = extractListCollectionsData({ library_id: 1, total_count: 3, collections: [
            { collection_key: 'SAMEKEY1', name: 'Personal' },
            { collection_id: 'g12345-SAMEKEY1', name: 'Group', parent_collection_id: 'g12345-PARENT12' },
            { collection_key: 'g23456-SAMEKEY1', name: 'Other group' },
        ] });
        expect(data?.collections.map(collectionReferenceKey)).toEqual(['1-SAMEKEY1', 'g12345-SAMEKEY1', 'g23456-SAMEKEY1']);
        expect(data?.collections[1]).toMatchObject({ library_ref: 'g12345', zotero_key: 'SAMEKEY1', name: 'Group' });
    });
    it('keeps approval and result identities during history decoding', () => {
        const decoded = toAgentAction({ action_type: 'create_collection', proposed_data: {
            library_ref: 'g12345', parent_collection_id: 'g12345-PARENT12', name: 'New',
        }, result_data: { collection_id: 'g12345-SAMEKEY1' } });
        expect(decoded.proposed_data.parent_key).toBe('g12345-PARENT12');
        expect(decoded.result_data).toMatchObject({ collection_key: 'g12345-SAMEKEY1', library_ref: 'g12345' });
        expect(toAgentAction({ action_type: 'create_item', proposed_data: { item: {}, collection_ids: ['g12345-SAMEKEY1'] } })
            .proposed_data.collection_ids).toEqual(['g12345-SAMEKEY1']);
    });
    it('hydrates portable attachments and keeps identical keys in different libraries separate', () => {
        const raw: any = { type: 'collection', collection_id: 'g12345-SAMEKEY1', name: 'Group', parent_key: null };
        const hydrated = normalizeCollectionAttachment(raw);
        expect(hydrated).toMatchObject({ zotero_key: 'SAMEKEY1', library_ref: 'g12345' });
        expect(messageAttachmentIdentity(hydrated)).toBe('collection:g12345-SAMEKEY1');
        expect(messageAttachmentIdentity({ ...hydrated, collection_id: 'u-SAMEKEY1' })).toBe('collection:u-SAMEKEY1');
    });
    it('uses qualified batch destinations without conflating same-key outcome groups', () => {
        const row = { label: 'Inbox', count: 1, reference: 'g12345-SAMEKEY1' };
        const block: any = { kind: 'destination', rows: [row] };
        expect(batchOutcomeTarget('sort', block, row, 'u')).toMatchObject({ key: 'g12345-SAMEKEY1', libraryRef: 'g12345' });
        const record: any = { groups: [
            { kind: 'destination', label: 'Inbox', reference: 'u-SAMEKEY1', item_ids: ['u-ITEMKEY1'] },
            { kind: 'destination', label: 'Inbox', reference: 'g12345-SAMEKEY1', item_ids: ['g12345-ITEMKEY1'] },
        ] };
        expect(batchItemGroupFor(record, block, row)?.item_ids).toEqual(['g12345-ITEMKEY1']);
    });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionListResultView } from '../../../react/components/agentRuns/toolResultViews/CollectionListResultView';
it('renders both legacy and portable-only collection rows by their display names', () => {
    const html = renderToStaticMarkup(React.createElement(CollectionListResultView, { view: {
        kind: 'collection_list', tool_name: 'list_collections', total_count: 2,
        collections: [{ library_id: 1, collection_key: 'SAMEKEY1', name: 'Personal inbox' },
            { collection_id: 'g12345-SAMEKEY1', name: 'Group inbox' }],
    } as any }));
    expect(html).toContain('Personal inbox');
    expect(html).toContain('Group inbox');
    expect(html).not.toContain('g12345-SAMEKEY1');
});
it('reconciles legacy batch keys only with an explicitly known library', () => {
    const record: any = { groups: [{ kind: 'destination', label: 'Inbox', reference: 'SAMEKEY1', item_ids: ['g12345-ITEMKEY1'] }] };
    const block: any = { kind: 'destination' };
    const row = { label: 'Inbox', reference: 'g12345-SAMEKEY1' };
    expect(batchItemGroupFor(record, block, row)).toBeNull();
    expect(batchItemGroupFor(record, block, row, 'g12345')?.item_ids).toEqual(['g12345-ITEMKEY1']);
    expect(batchItemGroupFor(record, block, row, 'u')).toBeNull();
});

it('uses explicit null portable parents over stale native parents in proposals and undo snapshots', () => {
    const data = { collection_id: 'g12345-SAMEKEY1', new_parent_collection_id: null, new_parent_key: 'STALEKEY' };
    expect(readCollectionActionData(data)).toMatchObject({ collection_key: 'g12345-SAMEKEY1', new_parent_key: null });
    const decoded = toAgentAction({ action_type: 'manage_collections', proposed_data: { ...data, action: 'move' },
        result_data: { old_parent_collection_id: null, old_parent_key: 'STALEKEY' } });
    expect(decoded.proposed_data.new_parent_key).toBeNull();
    expect(decoded.result_data?.old_parent_key).toBeNull();
    expect(readCollectionActionData(decoded.proposed_data)).toEqual(decoded.proposed_data);
});

it('retains a native collection key when the portable collection ID is null', () => {
    const decoded = readCollectionActionData({ collection_id: null, collection_key: 'SAMEKEY1',
        new_parent_collection_id: null, new_parent_key: 'PARENT12' });
    expect(decoded.collection_key).toBe('SAMEKEY1');
    expect(decoded.new_parent_key).toBeNull();
});

it.each([
    ['collection_id', 'collection_key'],
    ['parent_collection_id', 'parent_key'],
    ['new_parent_collection_id', 'new_parent_key'],
    ['old_parent_collection_id', 'old_parent_key'],
])('preserves the native key when %s is a legacy numeric ID', (portable, native) => {
    const decoded = readCollectionActionData({ [portable]: 42, [native]: 'SAMEKEY1' });
    expect(decoded[native]).toBe('SAMEKEY1');
    expect(decoded[portable]).toBe(42);
});
