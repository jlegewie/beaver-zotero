/**
 * "Where should we start?" — a static, local-only first-action launcher.
 */
import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { ActionTargetType } from '../types/actions';
import { SignalItem } from '../types/librarySuggestions';
import { getActiveItems, getRecentItems, toSignalItem } from '../../src/utils/librarySignals';
import { libraryItemCountAtom, SMALL_LIBRARY_THRESHOLD } from './zoteroContext';
import { currentReaderAttachmentAtom, currentMessageItemsAtom } from './messageComposition';
import { actionsAtom, markActionUsedAtom } from './actions';
import { markFirstRunCompleteAtom, firstRunReturnRequestedAtom } from './firstRun';
import { newThreadAtom } from './threads';
import { sendWSMessageAtom } from './agentRunAtoms';
import { isWebSearchAllowedAtom, isWebSearchEnabledAtom } from './ui';
import { beaverDefaultModelAtom, updateSelectedModelAtom } from './models';
import { resolvePromptVariables } from '../utils/promptVariables';
import { ensurePromptActionTokens, getActionCommand } from '../utils/slashCommands';
import { PromptAction } from '../agents/types';
import { ChargingPermissions } from '../../src/services/agentProtocol';
import { logger } from '../../src/utils/logger';

// Built-in action ids the launcher maps to.
const START_PROJECT = 'builtin-start-project';
const COLOR_CODE = 'builtin-color-code';
const TIDY_UP = 'builtin-tidy-up';
const DISCOVER = 'builtin-whats-new';

// Topic-input options reveal an inline topic textarea and wait for the user to
// type before the run can start.
const TOPIC_ACTIONS = new Set([START_PROJECT, DISCOVER]);

// Options whose prompts can use external topic search. Launching one enables
// web search, switching to an included Beaver model when needed.
const WEB_SEARCH_ACTIONS = new Set([START_PROJECT, DISCOVER]);

// Launcher actions should start without cost-confirmation UI.
const WHERE_TO_START_PERMISSIONS_OVERRIDE: Partial<ChargingPermissions> = {
    confirm_extraction_costs: false,
    confirm_external_search_costs: false,
};

/**
 * Completion categories emitted for launcher starts and skips.
 */
const COMPLETION_KIND: Record<string, string> = {
    [START_PROJECT]: 'where_to_start_start_project',
    [COLOR_CODE]: 'where_to_start_color_code',
    [TIDY_UP]: 'where_to_start_tidy_up',
    [DISCOVER]: 'where_to_start_discover',
};
const SKIP_COMPLETION_KIND = 'where_to_start_skip';

/**
 * One launcher option. Display copy comes from the resolved built-in action so
 * it stays in sync with the catalog; `title` is overridden for color-code to
 * name the specific paper.
 */
export interface StartOption {
    actionId: string;
    targetType: ActionTargetType;
    title: string;
    description: string;
    requiresTopic: boolean;
    /** Enable web search on launch (external-search actions). */
    requiresWebSearch: boolean;
    /** Placeholder for the inline topic input (topic options only). */
    argumentHintPlaceholder?: string;
    /** Color-code target — pre-attached to the composer when the option runs. */
    attachmentItem?: Zotero.Item;
}

// DEV-only session visibility flag; set from the Dev Tools menu.
export const devWhereToStartVisibleAtom = atom<boolean>(false);

// null = not yet computed.
export const whereToStartOptionsAtom = atom<StartOption[] | null>(null);
export const whereToStartLoadingAtom = atom<boolean>(false);

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max).trimEnd() + '…';
}

/** Short label for a paper: "Surname Year" → "Surname" → truncated title. */
function labelFromSignal(s: SignalItem): string {
    const surname = s.creators?.[0];
    if (surname && s.year) return `${surname} ${s.year}`;
    if (surname) return surname;
    if (s.title) return truncate(s.title, 40);
    return 'this paper';
}

/**
 * Pick the best paper to color-code, highest-signal first:
 *   1. currently open in the reader
 *   2. most recently read (with an agent-supported attachment)
 *   3. most recently added (with an agent-supported attachment)
 * Returns the parent regular item + a short label, or null when nothing fits.
 */
async function pickColorCodeTarget(
    readerAttachment: Zotero.Item | null,
    libraryID: number,
): Promise<{ item: Zotero.Item; label: string } | null> {
    // 1. Currently open reader attachment → its parent regular item.
    if (readerAttachment) {
        const parent = readerAttachment.parentItem;
        if (parent && parent.isRegularItem()) {
            await Zotero.Items.loadDataTypes([parent], ['itemData', 'creators', 'childItems']);
            const sig = await toSignalItem(parent);
            return { item: parent, label: labelFromSignal(sig) };
        }
    }

    // 2. Most recently read with a supported attachment.
    const active = await getActiveItems(libraryID);
    const read = active.find((i) => i.kinds.includes('read') && i.has_supported_attachment);
    if (read) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(read.library_id, read.zotero_key);
        if (item) return { item: item as Zotero.Item, label: labelFromSignal(read) };
    }

    // 3. Most recently added with a supported attachment.
    const recent = await getRecentItems(libraryID);
    const added = recent.find((i) => i.has_supported_attachment);
    if (added) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(added.library_id, added.zotero_key);
        if (item) return { item: item as Zotero.Item, label: labelFromSignal(added) };
    }

    return null;
}

function makeGlobalOption(
    byId: Map<string, { title: string; description?: string; argumentHint?: string }>,
    id: string,
): StartOption {
    const action = byId.get(id);
    const requiresTopic = TOPIC_ACTIONS.has(id);
    return {
        actionId: id,
        targetType: 'global',
        title: action?.title ?? id,
        description: action?.description ?? '',
        requiresTopic,
        requiresWebSearch: WEB_SEARCH_ACTIONS.has(id),
        argumentHintPlaceholder: requiresTopic
            ? (action?.argumentHint ?? 'Describe your first task…')
            : undefined,
    };
}

/**
 * Compute the option slate from local signals. Populated libraries get three
 * options (Start project · Color-code / Discover · Tidy up); empty or
 * almost-empty libraries get the two that work with no content (Start project ·
 * Discover).
 */
export const loadWhereToStartOptionsAtom = atom(null, async (get, set) => {
    set(whereToStartLoadingAtom, true);
    try {
        const actions = get(actionsAtom);
        const byId = new Map(actions.map((a) => [a.id, a]));
        const libraryID = Zotero.Libraries.userLibraryID;
        const count = get(libraryItemCountAtom);
        const isEmpty = count !== null && count < SMALL_LIBRARY_THRESHOLD;

        const options: StartOption[] = [];

        // 1. Start a research project — always available (works on an empty library).
        options.push(makeGlobalOption(byId, START_PROJECT));

        if (isEmpty) {
            // Empty / almost-empty: only topic-input actions make sense.
            options.push(makeGlobalOption(byId, DISCOVER));
        } else {
            // 2. Color-code the best available paper — or Discover if none fits.
            const readerAttachment = get(currentReaderAttachmentAtom);
            const target = await pickColorCodeTarget(readerAttachment, libraryID);
            if (target) {
                const action = byId.get(COLOR_CODE);
                options.push({
                    actionId: COLOR_CODE,
                    targetType: 'attachment',
                    title: `Color-code ${target.label}`,
                    description: action?.description ?? '',
                    requiresTopic: false,
                    requiresWebSearch: false,
                    attachmentItem: target.item,
                });
            } else {
                options.push(makeGlobalOption(byId, DISCOVER));
            }

            // 3. Tidy up my library.
            options.push(makeGlobalOption(byId, TIDY_UP));
        }

        set(whereToStartOptionsAtom, options);
    } catch (e) {
        logger(`whereToStart: load failed: ${e}`, 1);
        set(whereToStartOptionsAtom, []);
    } finally {
        set(whereToStartLoadingAtom, false);
    }
});

// ---------------------------------------------------------------------------
// Selection state machine (select → Start)
// ---------------------------------------------------------------------------

/** Currently highlighted option (actionId), or null when nothing is selected. */
export const whereToStartSelectedActionIdAtom = atom<string | null>(null);

/** Topic typed for the selected input-required option (Start project / Discover). */
export const whereToStartTopicAtom = atom<string>('');

/** In-flight guard while a launch is starting the run. */
export const whereToStartSubmittingAtom = atom<boolean>(false);

/** The selected option resolved against the current option slate. */
export const whereToStartSelectedOptionAtom = atom<StartOption | null>((get) => {
    const id = get(whereToStartSelectedActionIdAtom);
    if (!id) return null;
    return get(whereToStartOptionsAtom)?.find((o) => o.actionId === id) ?? null;
});

/**
 * Whether the footer Start button can fire: an option is selected, no launch is
 * in flight, and — for topic options — a non-empty topic has been typed.
 */
export const canStartWhereToStartAtom = atom<boolean>((get) => {
    const option = get(whereToStartSelectedOptionAtom);
    if (!option) return false;
    if (get(whereToStartSubmittingAtom)) return false;
    if (option.requiresTopic && get(whereToStartTopicAtom).trim().length === 0) return false;
    return true;
});

/** Select an option and clear any typed topic. */
export const selectStartOptionAtom = atom(null, (get, set, actionId: string) => {
    if (get(whereToStartSelectedActionIdAtom) === actionId) return;
    set(whereToStartSelectedActionIdAtom, actionId);
    set(whereToStartTopicAtom, '');
});

/** Reset the launcher's local selection/topic/in-flight state. */
function resetSelectionState(set: any): void {
    set(whereToStartSelectedActionIdAtom, null);
    set(whereToStartTopicAtom, '');
}

/**
 * Enable web search for external-search options. If the selected model cannot
 * search, switch to the included Beaver model when one is available.
 */
function enableWebSearchForLaunch(get: any, set: any): void {
    if (!get(isWebSearchAllowedAtom)) {
        const beaverDefaultModel = get(beaverDefaultModelAtom);
        if (!beaverDefaultModel) {
            logger('whereToStart: web search unavailable; launching without it', 1);
            return;
        }
        set(updateSelectedModelAtom, { ...beaverDefaultModel, access_mode: 'app_key' });
    }
    set(isWebSearchEnabledAtom, true);
}

/**
 * Launch the selected option as an agent run.
 *
 * Marks onboarding complete, opens a fresh thread, pre-attaches any selected
 * target item, and sends the chosen built-in action as a structured `/command`.
 *
 * Throws on failure so the page can keep the launcher open for retry.
 */
export const startSelectedOptionAtom = atom(null, async (get, set) => {
    if (!get(canStartWhereToStartAtom)) return;
    const option = get(whereToStartSelectedOptionAtom);
    if (!option) return;

    const action = get(actionsAtom).find((a) => a.id === option.actionId);
    if (!action) {
        logger(`whereToStart: action not found: ${option.actionId}`, 1);
        return;
    }

    set(whereToStartSubmittingAtom, true);
    try {
        const topic = option.requiresTopic ? get(whereToStartTopicAtom).trim() : '';

        if (option.requiresWebSearch) {
            enableWebSearchForLaunch(get, set);
        }

        // Mark completion before creating chat state so failures keep the launcher open.
        await set(markFirstRunCompleteAtom, COMPLETION_KIND[option.actionId] ?? 'where_to_start');

        await set(newThreadAtom, { skipAutoPopulate: true });
        if (option.attachmentItem) {
            set(currentMessageItemsAtom, [option.attachmentItem]);
        }

        // Resolve prompt variables only; selected target items are already attached.
        const { text: resolvedPrompt } = await resolvePromptVariables(action.text);
        const promptAction: PromptAction = {
            command: getActionCommand(action),
            action_id: action.id,
            title: action.title,
            prompt: resolvedPrompt,
            target_type: option.targetType,
            category: action.category,
            description: action.description,
        };
        set(markActionUsedAtom, action.id);

        const runId = uuidv4();
        set(firstRunReturnRequestedAtom, false);

        await set(sendWSMessageAtom, ensurePromptActionTokens(topic, [promptAction]), {
            runIdOverride: runId,
            permissionsOverride: WHERE_TO_START_PERMISSIONS_OVERRIDE,
            actions: [promptAction],
            origin: {
                kind: 'where_to_start',
                action_id: option.actionId,
                requires_topic: option.requiresTopic,
                topic_label: topic.length > 0 ? topic : null,
            },
        });

        set(devWhereToStartVisibleAtom, false);
        resetSelectionState(set);
    } catch (e) {
        logger(`whereToStart: start failed: ${e}`, 1);
        throw e;
    } finally {
        set(whereToStartSubmittingAtom, false);
    }
});

/**
 * Dismiss the launcher, record a skip completion category, and clear local
 * selection state.
 */
export const skipWhereToStartAtom = atom(null, async (_get, set) => {
    try {
        await set(markFirstRunCompleteAtom, SKIP_COMPLETION_KIND);
    } catch (e) {
        logger(`whereToStart: skip completion failed: ${e}`, 1);
    } finally {
        set(devWhereToStartVisibleAtom, false);
        resetSelectionState(set);
    }
});
