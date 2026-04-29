import { atom } from 'jotai';
import { LibrarySuggestionsResponse, SuggestionCard } from '../types/librarySuggestions';
import { MessageAttachment } from '../types/attachments/apiTypes';
import { librarySuggestionsService } from '../../src/services/librarySuggestionsService';
import {
    readCachedSuggestions,
    writeCachedSuggestions,
    clearCachedSuggestions,
} from '../utils/librarySuggestionsCache';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
    CollectionReference,
} from './messageComposition';
import { sendWSMessageAtom } from './agentRunAtoms';
import { logger } from '../../src/utils/logger';

export const firstRunSuggestionsAtom = atom<LibrarySuggestionsResponse | null>(null);
export const firstRunSuggestionsLoadingAtom = atom<boolean>(false);
export const firstRunSuggestionsErrorAtom = atom<string | null>(null);

/**
 * Session-only override that forces the sidebar to render the first-run page.
 */
export const firstRunReturnRequestedAtom = atom<boolean>(false);

async function fetchAndPersist(set: any): Promise<void> {
    set(firstRunSuggestionsLoadingAtom, true);
    set(firstRunSuggestionsErrorAtom, null);
    try {
        const response = await librarySuggestionsService.getSuggestions({ purpose: 'first_run' });
        writeCachedSuggestions(response);
        set(firstRunSuggestionsAtom, response);
    } catch (err: any) {
        const message = err?.message ?? String(err);
        logger(`firstRun: getSuggestions failed: ${message}`, 1);
        set(firstRunSuggestionsErrorAtom, message);
        set(firstRunSuggestionsAtom, null);
    } finally {
        set(firstRunSuggestionsLoadingAtom, false);
    }
}

/**
 * Hydrate from prefs cache; on miss/expiry, fetch and persist.
 * Safe to call repeatedly — already-loaded state short-circuits.
 */
export const loadFirstRunSuggestionsAtom = atom(null, async (get, set) => {
    if (get(firstRunSuggestionsLoadingAtom)) return;
    if (get(firstRunSuggestionsAtom)) return;

    const cached = readCachedSuggestions();
    if (cached) {
        set(firstRunSuggestionsAtom, cached);
        set(firstRunSuggestionsErrorAtom, null);
        return;
    }

    await fetchAndPersist(set);
});

/**
 * Force a refetch, bypassing the prefs cache. Used by the dev refresh button.
 */
export const refreshFirstRunSuggestionsAtom = atom(null, async (_get, set) => {
    clearCachedSuggestions();
    set(firstRunSuggestionsAtom, null);
    await fetchAndPersist(set);
});

async function hydrateAttachments(
    attachments: MessageAttachment[] | null | undefined,
): Promise<{ items: Zotero.Item[]; collections: CollectionReference[] }> {
    const items: Zotero.Item[] = [];
    const collections: CollectionReference[] = [];
    if (!attachments) return { items, collections };

    for (const a of attachments) {
        if (a.type === 'collection') {
            const c = await Zotero.Collections.getByLibraryAndKeyAsync(a.library_id, a.zotero_key);
            if (c) {
                collections.push({
                    key: c.key,
                    name: c.name,
                    libraryID: c.libraryID,
                    parentKey: (c as any).parentKey || null,
                });
            }
        } else {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(a.library_id, a.zotero_key);
            if (item) items.push(item as Zotero.Item);
        }
    }

    return { items, collections };
}

/**
 * Hydrate items/collections from a SuggestionCard's attachments and submit
 * the prompt.
 */
export const submitFirstRunCardAtom = atom(
    null,
    async (get, set, card: SuggestionCard) => {
        const { items, collections } = await hydrateAttachments(card.attachments);

        if (items.length > 0) {
            const current = get(currentMessageItemsAtom);
            const existingKeys = new Set(current.map((i) => `${i.libraryID}-${i.key}`));
            const newItems = items.filter((i) => !existingKeys.has(`${i.libraryID}-${i.key}`));
            if (newItems.length > 0) {
                set(currentMessageItemsAtom, [...current, ...newItems]);
            }
        }

        if (collections.length > 0 && get(currentMessageCollectionsAtom).length === 0) {
            set(currentMessageCollectionsAtom, collections);
        }

        set(firstRunReturnRequestedAtom, false);

        return set(sendWSMessageAtom, card.prompt);
    },
);
