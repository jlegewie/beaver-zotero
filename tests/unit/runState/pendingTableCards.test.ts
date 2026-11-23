import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from 'jotai/vanilla';
import { describe, expect, it } from 'vitest';
import type { WSTableCardRequest } from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    addPendingTableCardAtom,
    clearAllPendingTableCardsAtom,
    pendingTableCardsAtom,
    removePendingTableCardAtom,
    removePendingTableCardForToolCallAtom,
    tableCardDraftsAtom,
} from '@beaver/agent-core/run-state/pendingTableCards';
import { initialTableCardDraft } from '@beaver/agent-core/run-state/tableCardDraft';

const request: WSTableCardRequest = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/artifacts/table-cards/create-items.json'), 'utf8'),
).request;

function withDraft() {
    const store = createStore();
    store.set(addPendingTableCardAtom, request);
    store.set(tableCardDraftsAtom, new Map([[request.card_id, { ...initialTableCardDraft(request), title: 'Edited' }]]));
    return store;
}

describe('pending table cards and their drafts', () => {
    it('drops the draft with the card once the answer is sent (or the stale notice arrives)', () => {
        const store = withDraft();
        store.set(removePendingTableCardAtom, request.card_id);
        expect(store.get(pendingTableCardsAtom).size).toBe(0);
        expect(store.get(tableCardDraftsAtom).size).toBe(0);
    });

    it('drops the draft when create_table returns without an answer (the card timed out)', () => {
        const store = withDraft();
        store.set(removePendingTableCardForToolCallAtom, request.toolcall_id);
        expect(store.get(pendingTableCardsAtom).size).toBe(0);
        expect(store.get(tableCardDraftsAtom).size).toBe(0);
    });

    it('keeps a draft whose card is still pending when another call returns', () => {
        const store = withDraft();
        store.set(removePendingTableCardForToolCallAtom, 'another-call');
        expect(store.get(tableCardDraftsAtom).get(request.card_id)?.title).toBe('Edited');
    });

    it('drops every draft when the run ends', () => {
        const store = withDraft();
        store.set(clearAllPendingTableCardsAtom);
        expect(store.get(pendingTableCardsAtom).size).toBe(0);
        expect(store.get(tableCardDraftsAtom).size).toBe(0);
    });
});
