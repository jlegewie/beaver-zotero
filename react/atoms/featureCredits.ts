/**
 * Feature credits: the window's view of the account's tasks and starting a
 * task in the chat input.
 *
 * Whether a task is done comes only from the profile. The server grants a
 * task when a message is sent from its setup card (see `featureCreditRuns`).
 */
import { atom } from 'jotai';
import type { FeatureCreditTask } from '@beaver/agent-core/types/profile';
import type { CollectionReference } from '@beaver/agent-core/types/zotero';
import { profileWithPlanAtom } from './profile';
import { beaverDefaultModelAtom, isUsingBeaverCreditsAtom, updateSelectedModelAtom } from './models';
import { preferencesRevisionAtom } from './preferences';
import { getPref, setPref } from '../../src/utils/prefs';
import { actionRequirementBlockAtom, stageActionPillAtom } from './actions';
import {
    addCollectionsToCurrentMessageAtom,
    composerSourceSearchTextAtom,
    currentMessageCollectionsAtom,
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    currentReaderAttachmentAtom,
    messageItemDataRevisionAtom,
    pendingPillInsertsAtom,
    removeAutomaticAttachmentsAtom,
} from './messageComposition';
import { FeatureTaskDefinition, TOPIC_PLACEHOLDER, getFeatureCreditTask } from '../constants/featureCreditTasks';
import {
    combineDocumentStatuses,
    sendHoldHint,
    setupSteps,
    type AttachedPaper,
    type DocumentStatus,
    type SetupStep,
} from '../utils/featureCredits';
import { hasTextBesidesPills, textBesidesPills, type ActionRequirementBlock } from '../utils/actionRequirements';
import { itemValidationResultsAtom, type ItemValidationState } from './itemValidation';
import { getReadableContentKind } from '../../src/services/documentExtraction/attachmentResolution';
import { activeFeatureTaskAtom } from './featureCreditRuns';
import { getDisplayNameFromItem } from '../utils/sourceUtils';

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
 * Starting it (not picking one of its examples) switches to the Beaver model
 * and, for a task that finds its papers in the library, removes what the chat
 * input took from the Zotero selection; attachments the user added stay, and
 * `collection` is attached for the task to work on. Any other /command in the
 * chat input is replaced by this one. A picked example's topic placeholder is
 * selected, so typing replaces it.
 */
export const startFeatureTaskAtom = atom(
    null,
    (get, set, payload: {
        key: string;
        targetWindow?: Window;
        argumentText?: string;
        collection?: CollectionReference;
    }): boolean => {
        const definition = getFeatureCreditTask(payload.key);
        if (!definition) return false;
        if (get(activeFeatureTaskAtom) !== definition.key) {
            set(selectBeaverModelAtom);
            if (definition.attach === 'none') set(removeAutomaticAttachmentsAtom);
        }
        if (payload.collection) set(addCollectionsToCurrentMessageAtom, [payload.collection]);
        set(activeFeatureTaskAtom, definition.key);
        const pills = get(currentMessagePillsAtom);
        // The chat input already has this /command: keep it, and only replace
        // its text when an example was picked.
        const staged = pills.some((pill) => pill.actionId === definition.actionId);
        if (staged && payload.argumentText === undefined) return true;
        // Every other /command goes, with its text, so a command left from
        // something else does not run with the task.
        const replaceActionIds = [...new Set(pills.map((pill) => pill.actionId))]
            .filter((actionId) => actionId !== definition.actionId);
        return set(stageActionPillAtom, {
            actionId: definition.actionId,
            targetWindow: payload.targetWindow,
            argumentText: payload.argumentText,
            ...(payload.argumentText?.includes(TOPIC_PLACEHOLDER) ? { selectText: TOPIC_PLACEHOLDER } : {}),
            ...(replaceActionIds.length > 0 ? { replaceActionIds } : {}),
        });
    },
);

/**
 * Go back from a task's setup to the task list. The task's /command goes too
 * when the chat input holds nothing else: no other /command and no text.
 */
export const leaveFeatureTaskAtom = atom(null, (get, set) => {
    const key = get(activeFeatureTaskAtom);
    const definition = key ? getFeatureCreditTask(key) : undefined;
    set(activeFeatureTaskAtom, null);
    if (!definition) return;
    const pills = get(currentMessagePillsAtom);
    if (pills.some((pill) => pill.actionId !== definition.actionId)) return;
    if (hasTextBesidesPills(get(currentMessageContentAtom), pills)) return;
    // Only the text and the /command: attachments, the reader context that
    // comes with them, and files still being attached stay.
    if (pills.length > 0) {
        set(currentMessageContentAtom, '');
        set(currentMessagePillsAtom, []);
    }
    // A /command not inserted yet (Back right after the task started) is dropped too.
    const pending = get(pendingPillInsertsAtom);
    const otherPending = pending.filter((insert) => insert.descriptor.actionId !== definition.actionId);
    if (otherPending.length !== pending.length) set(pendingPillInsertsAtom, otherPending);
});

const ANNOTATABLE_KINDS = new Set(['pdf', 'epub', 'snapshot']);

const fileKey = (item: Zotero.Item) => `${item.libraryID}-${item.key}`;

/**
 * Whether the text of a PDF the chat input can read was prepared by OCR, by
 * `fileKey`. A scan reads like any other PDF once it is prepared, but has no
 * text layer for a highlight to attach to. Absent until looked up (see
 * `lookUpOcrPreparedPdfsAtom`).
 */
const ocrPreparedPdfsAtom = atom<ReadonlyMap<string, boolean>>(new Map());

/**
 * Whether a file can be annotated, from the chat input's readability check of
 * it and, for a readable PDF, where its text comes from (`ocrPrepared`;
 * undefined while not looked up, when the file is still being checked).
 */
function fileStatus(
    attachment: Zotero.Item,
    validation: ItemValidationState | undefined,
    ocrPrepared: boolean | undefined,
): DocumentStatus {
    const checked = validation && !validation.isValidating && validation.state !== 'checking' ? validation : undefined;
    const kind = checked?.contentKind ?? getReadableContentKind(attachment);
    if (!kind || !ANNOTATABLE_KINDS.has(kind)) return 'none';
    // Not checked yet: the chat input validates every attachment it adds.
    if (!checked) return 'checking';
    if (checked.state !== 'readable') return 'unreadable';
    if (kind !== 'pdf') return 'readable';
    // A scan a vision model may read, not prepared yet.
    if (checked.statusCode === 'pdf_needs_ocr') return 'scan';
    if (ocrPrepared === undefined) return 'checking';
    return ocrPrepared ? 'scan' : 'readable';
}

function childAttachments(item: Zotero.Item): Zotero.Item[] {
    try {
        return item.getAttachments()
            .map((id: number) => Zotero.Items.get(id))
            .filter((attachment): attachment is Zotero.Item => !!attachment);
    } catch {
        return [];
    }
}

/**
 * The file an attached attachment or annotation stands for; null for a paper,
 * which brings all of its files.
 */
function ownFile(item: Zotero.Item): Zotero.Item | null {
    return (item.isAnnotation() ? item.parentItem : item.isAttachment() ? item : null) ?? null;
}

/** The files an attached item counts with: its own, or every file of an attached paper. */
function filesOf(item: Zotero.Item): Zotero.Item[] {
    const file = ownFile(item);
    return file ? [file] : item.isRegularItem() ? childAttachments(item) : [];
}

/**
 * Look up where the text of the attached, readable PDFs comes from, for those
 * not looked up yet. The setup card of a task that works on a PDF runs this
 * as the attachments and their readability checks change.
 */
export const lookUpOcrPreparedPdfsAtom = atom(null, async (get, set) => {
    const validations = get(itemValidationResultsAtom);
    const known = get(ocrPreparedPdfsAtom);
    const reader = get(currentReaderAttachmentAtom);
    const attached = reader ? [...get(currentMessageItemsAtom), reader] : get(currentMessageItemsAtom);
    const pending = attached.flatMap(filesOf).filter((file) => {
        const validation = validations.get(fileKey(file));
        return !known.has(fileKey(file))
            && !!validation && !validation.isValidating && validation.state === 'readable'
            && validation.contentKind === 'pdf'
            // A scan not prepared yet says so itself.
            && validation.statusCode !== 'pdf_needs_ocr';
    });
    if (pending.length === 0) return;
    const cache = Zotero.Beaver?.documentCache;
    const results = await Promise.all(pending.map(async (file) => {
        // Without the cache nothing says the PDF is a scan: it counts as annotatable.
        const prepared = await cache?.hasOcrText({ libraryId: file.libraryID, zoteroKey: file.key }).catch(() => false);
        return [fileKey(file), prepared === true] as const;
    }));
    set(ocrPreparedPdfsAtom, new Map([...get(ocrPreparedPdfsAtom), ...results]));
});

/** The papers the chat input carries, for the setup card's "Choose a PDF" step. */
export const featureTaskAttachedPapersAtom = atom<AttachedPaper[]>((get) => {
    get(messageItemDataRevisionAtom);
    const items = get(currentMessageItemsAtom);
    const reader = get(currentReaderAttachmentAtom);
    const ocrPrepared = get(ocrPreparedPdfsAtom);
    // Read the results map itself, not `getItemValidationAtom`: through that
    // derived getter, this atom's subscribers were not notified when a check
    // finished, and the card kept showing "Checking".
    const validations = get(itemValidationResultsAtom);
    const getValidation = (item: Zotero.Item) => validations.get(fileKey(item));

    // Papers in the order attached, each with the statuses of its files.
    const papers = new Map<string, { name: string; files: DocumentStatus[] }>();
    const add = (item: Zotero.Item) => {
        // An attachment or annotation stands for its paper, and only its own
        // file counts; an attached paper brings all of its files.
        const file = ownFile(item);
        const paper = file?.parentItem ?? file ?? item;
        const key = `${paper.libraryID}-${paper.key}`;
        let entry = papers.get(key);
        if (!entry) {
            entry = { name: getDisplayNameFromItem(paper), files: [] };
            papers.set(key, entry);
        }
        for (const attachment of filesOf(item)) {
            entry.files.push(fileStatus(attachment, getValidation(attachment), ocrPrepared.get(fileKey(attachment))));
        }
    };
    for (const item of items) add(item);
    if (reader) add(reader);

    return [...papers.values()].map(({ name, files }) => ({ name, document: combineDocumentStatuses(files) }));
});

/** The message text without the `@query` an open Add Sources menu is searching from. */
function withoutSourceSearch(content: string, search: string | null): string {
    const index = search ? content.lastIndexOf(search) : -1;
    return search && index >= 0 ? content.slice(0, index) + content.slice(index + search.length) : content;
}

/** The open setup card's steps, or null while no task's setup is open. */
export const featureTaskSetupStepsAtom = atom<SetupStep[] | null>((get) => {
    const key = get(activeFeatureTaskAtom);
    const definition = key ? getFeatureCreditTask(key) : undefined;
    if (!definition) return null;
    const content = withoutSourceSearch(get(currentMessageContentAtom), get(composerSourceSearchTextAtom));
    const instruction = textBesidesPills(content, get(currentMessagePillsAtom));
    const usesPlaceholder = definition.examples.some((example) => example.text.includes(TOPIC_PLACEHOLDER));
    return setupSteps({
        definition,
        papers: definition.attach === 'pdf' ? get(featureTaskAttachedPapersAtom) : [],
        onBeaverModel: get(isUsingBeaverCreditsAtom),
        // An instruction has a word in it: a stray "@" or "?" is not one.
        hasInstruction: /[\p{L}\p{N}]/u.test(instruction),
        // A picked example still names no topic.
        placeholderLeft: usesPlaceholder && instruction.includes(TOPIC_PLACEHOLDER),
        collections: get(currentMessageCollectionsAtom).map((collection) => collection.name),
    });
});

/**
 * Why Send waits for the open setup card: the first required step not yet
 * done, or null. Applies only while the message would start the task (its
 * setup is open, the task is not done and its /command is in the chat
 * input); the action itself runs without these steps elsewhere.
 */
export const featureTaskSendBlockAtom = atom<ActionRequirementBlock | null>((get) => {
    const key = get(activeFeatureTaskAtom);
    if (!key) return null;
    const entry = get(featureCreditEntriesAtom)?.find(({ definition }) => definition.key === key);
    if (!entry || entry.task.completed_at) return null;
    if (!get(currentMessagePillsAtom).some((pill) => pill.actionId === entry.definition.actionId)) return null;
    const steps = get(featureTaskSetupStepsAtom);
    const hint = steps && sendHoldHint(steps);
    return hint ? { hint } : null;
});

/**
 * Why the composer holds Send, or null: an open setup step first (the step
 * the card accents), then a /command whose action needs text it lacks.
 */
export const composerSendBlockAtom = atom<ActionRequirementBlock | null>(
    (get) => get(featureTaskSendBlockAtom) ?? get(actionRequirementBlockAtom),
);
