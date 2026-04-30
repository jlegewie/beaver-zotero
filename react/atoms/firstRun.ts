import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { LibrarySuggestionsResponse, SuggestionCard } from '../types/librarySuggestions';
import { MessageAttachment } from '../types/attachments/apiTypes';
import { librarySuggestionsService } from '../../src/services/librarySuggestionsService';
import { accountService } from '../../src/services/accountService';
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
import { newThreadAtom } from './threads';
import { profileWithPlanAtom } from './profile';
import { logger } from '../../src/utils/logger';

export const firstRunSuggestionsAtom = atom<LibrarySuggestionsResponse | null>(null);
export const firstRunSuggestionsLoadingAtom = atom<boolean>(false);
export const firstRunSuggestionsErrorAtom = atom<string | null>(null);

/**
 * Session-only override that forces the sidebar to render the first-run page.
 */
export const firstRunReturnRequestedAtom = atom<boolean>(false);

/**
 * Run id of the agent run started from a first-run card click. Used by
 * AgentRunView to mount the NextStepsPanel on the matching completed run.
 * Session-only — explicitly reset on logout (`logoutAtom` in `auth.ts`).
 */
export const firstRunOriginRunIdAtom = atom<string | null>(null);

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
 * Hydrate first-run suggestions: prefs cache (24h TTL, same install) → network.
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

/**
 * Idempotent stamp of `first_run_completed_at` on the user's profile.
 */
export const markFirstRunCompleteAtom = atom(
    null,
    async (get, set, completionKind?: string) => {
        const profile = get(profileWithPlanAtom);
        if (!profile || profile.first_run_completed_at) return;
        await accountService.completeFirstRun(completionKind);
        set(profileWithPlanAtom, {
            ...profile,
            first_run_completed_at: new Date().toISOString(),
            first_run_completion_kind: completionKind ?? null,
        });
    },
);

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
    async (_get, set, card: SuggestionCard) => {
        // Step 1: stamp first_run_completed_at on the server. If this throws,
        // nothing else runs — caller should catch + surface a toast.
        await set(markFirstRunCompleteAtom, card.kind);

        // Step 2: only after completion succeeds, mutate chat/thread state.
        await set(newThreadAtom, { skipAutoPopulate: true });

        const { items, collections } = await hydrateAttachments(card.attachments);

        if (items.length > 0) {
            set(currentMessageItemsAtom, items);
        }

        if (collections.length > 0) {
            set(currentMessageCollectionsAtom, collections);
        }

        // Generate the run id up front so we can recognize this exact run
        // when the NextStepsPanel needs to mount in AgentRunView.
        const runId = uuidv4();
        set(firstRunOriginRunIdAtom, runId);
        set(firstRunReturnRequestedAtom, false);

        return set(sendWSMessageAtom, card.prompt, runId);
    },
);
