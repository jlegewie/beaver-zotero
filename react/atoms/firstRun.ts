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
import { profileWithPlanAtom, isDeviceAuthorizedAtom, isDatabaseSyncSupportedAtom } from './profile';
import { libraryHasItemsAtom } from './zoteroContext';
import { ChargingPermissions } from '../../src/services/agentProtocol';
import { logger } from '../../src/utils/logger';

export const firstRunSuggestionsAtom = atom<LibrarySuggestionsResponse | null>(null);
export const firstRunSuggestionsLoadingAtom = atom<boolean>(false);
export const firstRunSuggestionsErrorAtom = atom<string | null>(null);

/**
 * Hand-authored fallback cards used when the backend fails or returns fewer
 * than 3 cards. Prompts must work without item/collection attachments — they
 * mirror the `targetType: 'global'` builtins in `react/types/builtinActions.ts`.
 */
const FALLBACK_FIRST_RUN_CARDS: SuggestionCard[] = [
    {
        kind: 'discover_research',
        slot_index: 0,
        is_emphasized: false,
        title: "What's new in my research areas?",
        description: 'Find recent papers in the topics you are working on.',
        description_segments: [
            { text: 'Find ', emphasized: false },
            { text: 'recent papers', emphasized: true },
            { text: ' in the topics you are working on.', emphasized: false },
        ],
        prompt: "Look at my recent additions to identify what I'm currently working on. Search for notable recent papers in these areas, prioritizing highly-cited and relevant results. Return up to 10 papers. Indicate which ones I already have.",
        attachments: null,
    },
    {
        kind: 'organize_library',
        slot_index: 1,
        is_emphasized: false,
        title: 'Organize my recent additions',
        description: 'Tag and file the items you added in the last 7 days.',
        description_segments: [
            { text: 'Tag and file the items you added in the ', emphasized: false },
            { text: 'last 7 days', emphasized: true },
            { text: '.', emphasized: false },
        ],
        prompt: "Look at items I've added in the last 7 days. For each one, assign appropriate tags and add them to the appropriate collection. If no existing collection fits, suggest creating a new one.",
        attachments: null,
    },
    {
        kind: 'organize_tags',
        slot_index: 2,
        is_emphasized: false,
        title: 'Tag all untagged items',
        description: 'Assign consistent subject tags to items that have none.',
        description_segments: [
            { text: 'Assign consistent ', emphasized: false },
            { text: 'subject tags', emphasized: true },
            { text: ' to items that have none.', emphasized: false },
        ],
        prompt: 'Find all items in my library that have no tags. Analyze each one and assign appropriate subject tags. Use existing tags from my library when they fit. Be consistent: similar papers should get similar tags.',
        attachments: null,
    },
];

/**
 * Top up the cards array to at least 3 entries by appending fallbacks whose
 * `kind` isn't already represented. Used for both the empty/error path and
 * the sparse-response (1–2 cards) path.
 */
export function padWithFallbackCards(cards: SuggestionCard[]): SuggestionCard[] {
    if (cards.length >= 3) return cards;
    const usedKinds = new Set(cards.map((c) => c.kind));
    const padding = FALLBACK_FIRST_RUN_CARDS.filter((c) => !usedKinds.has(c.kind));
    return [...cards, ...padding].slice(0, Math.max(3, cards.length));
}

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

/**
 * Single source of truth for "should the FirstRunPage be the visible page".
 */
export const isFirstRunVisibleAtom = atom((get) => {
    const firstRunReturnRequested = get(firstRunReturnRequestedAtom);
    if (firstRunReturnRequested) return true;
    const profile = get(profileWithPlanAtom);
    const isDeviceAuthorized = get(isDeviceAuthorizedAtom);
    const isDatabaseSyncSupported = get(isDatabaseSyncSupportedAtom);
    return (
        !!profile?.has_authorized_free_access &&
        !isDatabaseSyncSupported &&
        isDeviceAuthorized &&
        !profile?.first_run_completed_at
    );
});

/**
 * Set when the first-run loader sees an empty library and skips the backend
 * call. FirstRunPage uses this to render non-clickable info cards instead of
 * suggestion cards. Cleared once the library has items and we fetch normally.
 */
export const firstRunLibraryEmptyAtom = atom<boolean>(false);

/**
 * Hand-authored cards shown when the user's library is empty on first run.
 * Non-clickable — they explain what Beaver can do once items are added.
 */
export const EMPTY_LIBRARY_FIRST_RUN_CARDS: SuggestionCard[] = [
    {
        kind: 'discover_research',
        slot_index: 0,
        is_emphasized: false,
        title: 'Discover research in any field',
        description: 'Ask Beaver to find recent, highly-cited papers on any topic you are exploring.',
        description_segments: [
            { text: 'Ask Beaver to find ', emphasized: false },
            { text: 'recent, highly-cited papers', emphasized: true },
            { text: ' on any topic you are exploring.', emphasized: false },
        ],
        prompt: '',
        attachments: null,
    },
    {
        kind: 'literature_review',
        slot_index: 1,
        is_emphasized: false,
        title: 'Explore a research question',
        description: 'Describe what you are working on — Beaver surfaces key papers and themes.',
        description_segments: [
            { text: 'Describe what you are working on — Beaver surfaces ', emphasized: false },
            { text: 'key papers and themes', emphasized: true },
            { text: '.', emphasized: false },
        ],
        prompt: '',
        attachments: null,
    },
    {
        kind: 'reading_assistant',
        slot_index: 2,
        is_emphasized: false,
        title: 'Save items, then dive deeper',
        description: 'Use the Zotero connector to add papers. Beaver helps you read, compare, and organize.',
        description_segments: [
            { text: 'Use the Zotero connector to add papers. Beaver helps you ', emphasized: false },
            { text: 'read, compare, and organize', emphasized: true },
            { text: '.', emphasized: false },
        ],
        prompt: '',
        attachments: null,
    },
];

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
 * Hydrate first-run suggestions: empty-library short-circuit → prefs cache
 * (24h TTL, same install) → network.
 */
export const loadFirstRunSuggestionsAtom = atom(null, async (get, set) => {
    if (get(firstRunSuggestionsLoadingAtom)) return;
    if (get(firstRunSuggestionsAtom)) return;

    const libraryHasItems = get(libraryHasItemsAtom);

    // The library item probe is still pending. FirstRunPage keeps the existing
    // loading surface visible until this resolves.
    if (libraryHasItems === null) {
        set(firstRunLibraryEmptyAtom, false);
        return;
    }

    // Empty library: skip the backend entirely and render static info cards.
    // The notifier-driven libraryHasItemsAtom flips to true when the user adds
    // their first item; FirstRunPage re-invokes this loader on that change.
    if (!libraryHasItems) {
        set(firstRunLibraryEmptyAtom, true);
        return;
    }
    set(firstRunLibraryEmptyAtom, false);

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
export const refreshFirstRunSuggestionsAtom = atom(null, async (get, set) => {
    const libraryHasItems = get(libraryHasItemsAtom);
    if (libraryHasItems === null) {
        set(firstRunLibraryEmptyAtom, false);
        return;
    }
    if (!libraryHasItems) {
        set(firstRunLibraryEmptyAtom, true);
        return;
    }

    clearCachedSuggestions();
    set(firstRunSuggestionsAtom, null);
    set(firstRunLibraryEmptyAtom, false);
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
 * the prompt. `permissionsOverride` is forwarded to the agent run so the
 * first-run flow can opt out of confirmation prompts.
 */
export const submitFirstRunCardAtom = atom(
    null,
    async (
        _get,
        set,
        params: { card: SuggestionCard; permissionsOverride?: Partial<ChargingPermissions> },
    ) => {
        const { card, permissionsOverride } = params;

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

        return set(sendWSMessageAtom, card.prompt, runId, permissionsOverride);
    },
);
