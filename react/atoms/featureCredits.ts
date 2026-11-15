/**
 * Feature credits: the window's view of the account's tasks and starting a
 * task in the chat input.
 *
 * Whether a task is done comes only from the profile. The server grants a
 * task when a message is sent from its setup card (see `featureCreditRuns`).
 */
import { atom } from 'jotai';
import type { FeatureCreditTask } from '@beaver/agent-core/types/profile';
import { profileWithPlanAtom } from './profile';
import { beaverDefaultModelAtom, updateSelectedModelAtom } from './models';
import { preferencesRevisionAtom } from './preferences';
import { getPref, setPref } from '../../src/utils/prefs';
import { stageActionPillAtom } from './actions';
import {
    currentMessageCollectionsAtom,
    currentMessageFiltersAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    currentReaderAttachmentAtom,
    messageItemDataRevisionAtom,
} from './messageComposition';
import { FEATURE_CREDIT_TASKS, FeatureTaskDefinition, getFeatureCreditTask } from '../constants/featureCreditTasks';
import type { AttachmentSummary } from '../utils/featureCredits';
import { activeFeatureTaskAtom } from './featureCreditRuns';
import { getDisplayNameFromItem } from '../utils/sourceUtils';
import { resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { logger } from '@beaver/agent-core/platform/logger';

/** A server task this client can present, with its definition. */
export interface FeatureCreditEntry {
    task: FeatureCreditTask;
    definition: FeatureTaskDefinition;
}

/** The account's tasks this client knows, in server order; null when the feature is off. */
export const featureCreditEntriesAtom = atom<FeatureCreditEntry[] | null>((get) => {
    const tasks = get(profileWithPlanAtom)?.feature_credits?.tasks;
    if (!Array.isArray(tasks)) return null;
    const entries: FeatureCreditEntry[] = [];
    for (const task of tasks) {
        const definition = getFeatureCreditTask(task.key);
        if (definition) entries.push({ task, definition });
    }
    return entries.length > 0 ? entries : null;
});

/** Credits and counts for the card headers: earned so far and in total. */
export const featureCreditTotalsAtom = atom((get) => {
    const entries = get(featureCreditEntriesAtom) ?? [];
    let earned = 0;
    let total = 0;
    let done = 0;
    for (const { task } of entries) {
        total += task.credits;
        if (task.completed_at) {
            earned += task.credits;
            done++;
        }
    }
    return { earned, total, done, count: entries.length };
});

/** Whether the user closed the home card on this device. */
export const featureCreditsCardDismissedAtom = atom(
    (get) => {
        get(preferencesRevisionAtom);
        return getPref('featureCreditsCardDismissed') === true;
    },
    (_get, _set, dismissed: boolean) => setPref('featureCreditsCardDismissed', dismissed),
);

/**
 * Whether the home card shows: after first run, while a task is open, unless
 * dismissed. The card also waits for a library of a useful size (see
 * `FeatureCreditsCard`).
 */
export const featureCreditsCardVisibleAtom = atom((get) => {
    const profile = get(profileWithPlanAtom);
    if (!profile?.first_run_completed_at) return false;
    if (get(featureCreditsCardDismissedAtom)) return false;
    const entries = get(featureCreditEntriesAtom);
    return !!entries?.some(({ task }) => !task.completed_at);
});

/** Switch the chat input to the Beaver model, as the setup card's link does. */
export const selectBeaverModelAtom = atom(null, (get, set): boolean => {
    const model = get(beaverDefaultModelAtom);
    if (!model) return false;
    set(updateSelectedModelAtom, { ...model, access_mode: 'app_key' });
    return true;
});

/**
 * Start a task: show its setup card and stage its action in the chat input.
 * Attaches nothing; what the chat input already carries stays, except another
 * task's /command, which this one replaces.
 */
export const startFeatureTaskAtom = atom(
    null,
    (get, set, payload: { key: string; targetWindow?: Window; argumentText?: string }): boolean => {
        const definition = getFeatureCreditTask(payload.key);
        if (!definition) return false;
        set(activeFeatureTaskAtom, definition.key);
        const pills = get(currentMessagePillsAtom);
        // The chat input already has this /command: keep it, and only replace
        // its text when an example was picked.
        const staged = pills.some((pill) => pill.actionId === definition.actionId);
        if (staged && payload.argumentText === undefined) return true;
        // Another task's /command, left from a setup the user went back from:
        // removed with its text, so one message does not run both.
        const otherTaskActionIds = new Set(
            FEATURE_CREDIT_TASKS.map((task) => task.actionId).filter((actionId) => actionId !== definition.actionId),
        );
        const replaceActionIds = [...new Set(pills.map((pill) => pill.actionId))]
            .filter((actionId) => otherTaskActionIds.has(actionId));
        return set(stageActionPillAtom, {
            actionId: definition.actionId,
            targetWindow: payload.targetWindow,
            argumentText: payload.argumentText,
            ...(replaceActionIds.length > 0 ? { replaceActionIds } : {}),
        });
    },
);

function collectionItemCount(libraryID: number, key: string): number | null {
    try {
        const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
        if (!collection) return null;
        return collection.getChildItems(false, false).filter((item: Zotero.Item) => item.isRegularItem()).length;
    } catch (error) {
        logger(`featureCredits: could not count collection items: ${String(error)}`, 2);
        return null;
    }
}

/** What the chat input has attached, for the setup card's first step. */
export const featureTaskAttachmentSummaryAtom = atom<AttachmentSummary>((get) => {
    get(messageItemDataRevisionAtom);
    const items = get(currentMessageItemsAtom);
    const reader = get(currentReaderAttachmentAtom);
    const collections = get(currentMessageCollectionsAtom);

    const papers: string[] = [];
    const seen = new Set<string>();
    const add = (item: Zotero.Item) => {
        // An attachment stands for its parent paper.
        const paper = item.isAttachment() && item.parentItem ? item.parentItem : item;
        const key = `${paper.libraryID}-${paper.key}`;
        if (seen.has(key)) return;
        seen.add(key);
        papers.push(getDisplayNameFromItem(paper));
    };
    for (const item of items) add(item);
    if (reader) add(reader);

    const summaries: AttachmentSummary['collections'] = [];
    const seenCollections = new Set<string>();
    const addCollection = (name: string, libraryID: number | null, key: string) => {
        if (libraryID) {
            const id = `${libraryID}-${key}`;
            if (seenCollections.has(id)) return;
            seenCollections.add(id);
        }
        summaries.push({ name, itemCount: libraryID ? collectionItemCount(libraryID, key) : null });
    };
    for (const collection of collections) {
        addCollection(collection.name, resolveLibraryRef(collection) ?? null, collection.zotero_key);
    }
    // A collection dragged into the chat input, or picked under "Filter by
    // Collections", is kept as a filter; it scopes the message the same way.
    for (const collectionID of get(currentMessageFiltersAtom).collectionIds) {
        try {
            const collection = Zotero.Collections.get(collectionID);
            if (collection) addCollection(collection.name, collection.libraryID, collection.key);
        } catch {
            // A filter for a collection deleted since: nothing to show.
        }
    }

    return { papers, collections: summaries };
});
