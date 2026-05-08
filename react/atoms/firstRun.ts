import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { LibrarySuggestionsResponse, SuggestionCard } from '../types/librarySuggestions';
import { MessageAttachment, isCollectionAttachment } from '../types/attachments/apiTypes';
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
import { isWebSearchAllowedAtom, isWebSearchEnabledAtom } from './ui';
import { beaverDefaultModelAtom, updateSelectedModelAtom } from './models';
import { ChargingPermissions } from '../../src/services/agentProtocol';
import { logger } from '../../src/utils/logger';

export const firstRunSuggestionsAtom = atom<LibrarySuggestionsResponse | null>(null);
export const firstRunSuggestionsLoadingAtom = atom<boolean>(false);
export const firstRunSuggestionsErrorAtom = atom<string | null>(null);


/** Max number of suggestion cards rendered on FirstRunPage */
export const MAX_VISIBLE_FIRST_RUN_CARDS = 5;

/**
 * Hand-authored fallback cards used when the backend fails or returns fewer
 * than 3 cards. Prompts must work without item/collection attachments — they
 * mirror the `targetType: 'global'` builtins in `react/types/builtinActions.ts`.
 */
const FALLBACK_FIRST_RUN_CARDS: SuggestionCard[] = [
    {
        kind: 'discover_research',
        slot_index: 0,
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
 * When true, the suggestions page is opened in "returning user" mode (no
 * first-run framing, no completion stamp on dismiss). Set together with
 * `firstRunReturnRequestedAtom` from entry points like the user-account
 * menu so existing users can browse library-aware ideas.
 */
export const firstRunSuggestionsModeAtom = atom<boolean>(false);

/**
 * Session-only set of run ids whose NextStepsPanel the user has dismissed.
 */
export const firstRunNextStepsDismissedAtom = atom<Set<string>>(new Set<string>());

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
 * call. FirstRunPage uses this to render the empty-library discovery flow
 * (research-interest textarea) instead of suggestion cards. Cleared once
 * the library has items and we fetch normally.
 */
export const firstRunLibraryEmptyAtom = atom<boolean>(false);

/**
 * Session-only textarea state for the empty-library discovery flow on
 * FirstRunPage. Persisted across renders but not across sessions, so the
 * field clears if the user dismisses and returns later.
 */
export const emptyLibraryDiscoverInputAtom = atom<string>('');

/**
 * In-flight flag for the empty-library discovery submission. Disables the
 * button + textarea while the network call to mark first-run complete and
 * the WS dispatch are running.
 */
export const emptyLibraryDiscoverSubmittingAtom = atom<boolean>(false);

/**
 * Maximum length of the research-interest textarea. Mirrors a typical
 * single-paragraph description; long enough for "computational models of
 * adaptation in coastal communities under climate stress" without becoming
 * a free-form essay.
 */
export const EMPTY_LIBRARY_DISCOVER_MAX_LENGTH = 500;

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

    // Empty library: skip the backend entirely and render the discovery
    // textarea. The notifier-driven libraryHasItemsAtom flips to true when
    // the user adds their first item; FirstRunPage re-invokes this loader
    // on that change.
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

        // Generate the run id up front so we can address this exact run later
        // (e.g. NextStepsPanel dismissal). The "first-run card" identity is
        // carried on `user_prompt.origin` so consumers don't need a parallel
        // session atom to recognize it.
        const runId = uuidv4();
        set(firstRunReturnRequestedAtom, false);
        // Intentionally do NOT clear firstRunSuggestionsModeAtom here:
        // it must survive the round-trip so that BackToSuggestions reopens
        // the page in the same mode the card was launched from. The footer
        // "Cancel" path and logout reset this flag.

        // Carry topic + collection on origin so NextStepsPanel follow-up
        // templates can reference them without a second suggestions lookup.
        const collectionAttachment = card.attachments?.find(isCollectionAttachment);
        const collectionName = collectionAttachment?.name ?? null;

        return set(
            sendWSMessageAtom,
            card.prompt,
            runId,
            permissionsOverride,
            {
                kind: 'first_run_card',
                card_kind: card.kind,
                topic_label: card.topic_label ?? null,
                collection_name: collectionName,
            },
        );
    },
);

const FIRST_RUN_DISCOVER_PERMISSIONS_OVERRIDE: Partial<ChargingPermissions> = {
    confirm_extraction_costs: false,
    confirm_external_search_costs: false,
};

/**
 * Build the discovery prompt sent on behalf of an empty-library user. The
 * user's interest is treated as the topic; the prompt asks for an external
 * search so the run produces a starter set of papers the existing
 * `discover_research` follow-ups can act on (saving to a new collection
 * imports the items into Zotero — the natural next step for an empty
 * library).
 */
function buildEmptyLibraryDiscoverPrompt(interest: string): string {
    const trimmed = interest.trim();
    return (
        `My research interest: ${trimmed}\n\n` +
        `Use external search to find recent, highly-cited papers in this area. ` +
        `Prefer the last 5 years and seminal work that anyone starting in this area should know. ` +
        `Return up to 10 papers, each with title, first author, year, citation count, ` +
        `and a one-sentence description of why it matters.`
    );
}

/**
 * Empty-library discovery submission. Mirrors `submitFirstRunCardAtom` but
 * sources the prompt from the user's research-interest textarea, enables
 * web search for the run, and tags the origin as a `discover_research` card
 * so NextStepsPanel surfaces the "save top results to a new collection"
 * follow-up — that's the path that imports items into the empty library.
 */
export const submitEmptyLibraryDiscoverAtom = atom(
    null,
    async (get, set) => {
        const interest = get(emptyLibraryDiscoverInputAtom).trim();
        if (interest.length === 0) return;
        if (get(emptyLibraryDiscoverSubmittingAtom)) return;

        set(emptyLibraryDiscoverSubmittingAtom, true);
        try {
            const isSuggestionsMode = get(firstRunSuggestionsModeAtom);

            // The empty-library discovery prompt explicitly requires external
            // search. Returning users may have selected a BYOK/custom model
            // after onboarding, so switch to an included Beaver model before
            // stamping completion or starting the run.
            if (!get(isWebSearchAllowedAtom)) {
                const beaverDefaultModel = get(beaverDefaultModelAtom);
                if (!beaverDefaultModel) {
                    logger(
                        'firstRun: empty-library discovery blocked because web search is unavailable',
                        1,
                    );
                    return;
                }
                set(updateSelectedModelAtom, {
                    ...beaverDefaultModel,
                    access_mode: 'app_key',
                });
            }

            set(isWebSearchEnabledAtom, true);

            if (!isSuggestionsMode) {
                await set(markFirstRunCompleteAtom, 'empty_library_discover');
            }

            await set(newThreadAtom, { skipAutoPopulate: true });

            const runId = uuidv4();
            set(firstRunReturnRequestedAtom, false);

            const prompt = buildEmptyLibraryDiscoverPrompt(interest);

            await set(
                sendWSMessageAtom,
                prompt,
                runId,
                FIRST_RUN_DISCOVER_PERMISSIONS_OVERRIDE,
                {
                    kind: 'first_run_card',
                    card_kind: 'discover_research',
                    topic_label: interest,
                    collection_name: null,
                    empty_library: true,
                },
            );

            set(emptyLibraryDiscoverInputAtom, '');
        } finally {
            set(emptyLibraryDiscoverSubmittingAtom, false);
        }
    },
);
