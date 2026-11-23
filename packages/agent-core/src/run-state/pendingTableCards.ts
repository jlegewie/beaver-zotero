/**
 * Pending table cards (`create_table`).
 *
 * A table card blocks the run while the user reviews and edits a proposed
 * table. Like a batch approval it is answered through its own event pair
 * (`table_card_request` / `table_card_response`) correlated by `card_id`, and
 * the tool return retires it: `create_table` always returns, on an answer or
 * on the backend's own timeout, and `table_card_stale` covers an answer that
 * arrives too late. There is no client-side expiry timer.
 */

import { atom } from 'jotai/vanilla';
import type { WSTableCardRequest } from '../protocol/tableCardProtocol';
import type { TableCardDraft } from './tableCardDraft';

/** The request as the backend sent it; the edits live in `tableCardDraftsAtom`. */
export type PendingTableCard = WSTableCardRequest;

/** Pending table cards keyed by card id. At most one is live per run. */
export const pendingTableCardsAtom = atom<Map<string, PendingTableCard>>(new Map());

/**
 * The card's edits so far, keyed by card id. Held in the renderer's store
 * rather than in the component, so switching between the library and reader
 * sidebars, or closing and reopening Beaver, keeps them.
 */
export const tableCardDraftsAtom = atom<Map<string, TableCardDraft>>(new Map());

export const addPendingTableCardAtom = atom(null, (get, set, request: WSTableCardRequest) => {
    const next = new Map(get(pendingTableCardsAtom));
    next.set(request.card_id, request);
    set(pendingTableCardsAtom, next);
});

export const removePendingTableCardAtom = atom(null, (get, set, cardId: string) => {
    const current = get(pendingTableCardsAtom);
    if (!current.has(cardId)) return;
    const next = new Map(current);
    next.delete(cardId);
    set(pendingTableCardsAtom, next);
    const drafts = get(tableCardDraftsAtom);
    if (drafts.has(cardId)) {
        const remaining = new Map(drafts);
        remaining.delete(cardId);
        set(tableCardDraftsAtom, remaining);
    }
});

/** Retire the card a returning tool call owned. */
export const removePendingTableCardForToolCallAtom = atom(null, (get, set, toolcallId: string) => {
    for (const [cardId, card] of get(pendingTableCardsAtom)) {
        if (card.toolcall_id === toolcallId) {
            set(removePendingTableCardAtom, cardId);
            return;
        }
    }
});

export const clearAllPendingTableCardsAtom = atom(null, (get, set) => {
    if (get(pendingTableCardsAtom).size) set(pendingTableCardsAtom, new Map());
    if (get(tableCardDraftsAtom).size) set(tableCardDraftsAtom, new Map());
});
