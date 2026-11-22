/**
 * Feature credits: wording and bookkeeping that does not touch Zotero.
 */
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { parseItemReference } from '@beaver/agent-core/identity/libraryRef';
import { TOPIC_PLACEHOLDER, type FeatureTaskDefinition } from '../constants/featureCreditTasks';

/**
 * Whether an attached paper has a file Beaver can annotate (a PDF, EPUB or
 * snapshot), from the readability check the chat input runs on attachments.
 * `none`: no such file; `unreadable`: none of its files has text Beaver can read;
 * `scan`: a PDF whose text Beaver reads through OCR, with no text layer of its
 * own for a highlight to attach to.
 */
export type DocumentStatus = 'readable' | 'checking' | 'scan' | 'unreadable' | 'none';

export interface AttachedPaper {
    /** Display name, e.g. "Smith 2020". */
    name: string;
    document: DocumentStatus;
}

/**
 * One status for a paper from those of its PDF, EPUB and snapshot files:
 * a single readable file is enough.
 */
export function combineDocumentStatuses(statuses: DocumentStatus[]): DocumentStatus {
    if (statuses.includes('readable')) return 'readable';
    if (statuses.includes('checking')) return 'checking';
    if (statuses.includes('scan')) return 'scan';
    if (statuses.includes('unreadable')) return 'unreadable';
    return 'none';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const FIND_ANOTHER = 'Open a PDF in Zotero, or type @ to find another paper.';

/** The "Choose a PDF" step of a task that works on attached PDFs. */
interface PdfSource {
    /** `ready`: a readable paper is attached; `checking`: its files are still being read. */
    state: 'ready' | 'checking' | 'missing';
    /** One sentence: what is attached, or how to add it. */
    text: string;
}

/** Papers count only once Beaver can read one of their files. */
export function pdfSource(papers: AttachedPaper[]): PdfSource {
    if (papers.length === 0) {
        return { state: 'missing', text: 'Open one in Zotero, type @ to find a paper, or drag one into the prompt.' };
    }
    const label = papers.length === 1 ? papers[0].name : plural(papers.length, 'paper');
    const many = papers.length > 1;
    const count = (status: DocumentStatus) => papers.filter((paper) => paper.document === status).length;
    const readable = count('readable');
    const checking = count('checking');
    if (readable > 0) {
        const skipped = papers.length - readable - checking;
        const note = skipped > 0 && checking === 0
            ? ` ${plural(skipped, 'paper')} without a readable PDF, EPUB or snapshot ${skipped === 1 ? 'is' : 'are'} skipped.`
            : '';
        return { state: 'ready', text: `${label} ${many ? 'are' : 'is'} attached.${note}` };
    }
    if (checking > 0) return { state: 'checking', text: `Checking ${label}…` };
    if (count('scan') > 0 && count('unreadable') === 0) {
        return {
            state: 'missing',
            text: `${label} ${many ? 'are scans' : 'is a scan'} without a text layer, which can't be highlighted. ${FIND_ANOTHER}`,
        };
    }
    const noFile = count('none') === papers.length;
    return {
        state: 'missing',
        text: noFile
            ? `${label} ${many ? 'have' : 'has'} no PDF, EPUB or snapshot. ${FIND_ANOTHER}`
            : `Beaver can't read the text of ${label}. ${FIND_ANOTHER}`,
    };
}

/**
 * A setup card step's state. `done` shows a check, `active` (the step to act
 * on next) an accented number, `checking` a spinner; otherwise a plain number.
 */
export type StepStatus = 'done' | 'active' | 'checking' | 'pending';

export interface SetupStep {
    key: 'model' | 'source' | 'prompt';
    title: string;
    /** Under the title; the card adds the model link and the prompt examples. */
    text: string;
    status: StepStatus;
    /** Set on a required step, which holds Send until done: Send's tooltip meanwhile. */
    requiredHint?: string;
    /** The prompt step's examples are left out: they do not fit what is attached. */
    hideExamples?: boolean;
}

export interface SetupInput {
    definition: FeatureTaskDefinition;
    /** The papers the chat input carries, for a task that works on a PDF. */
    papers: AttachedPaper[];
    onBeaverModel: boolean;
    /** Whether the message has text besides its /command. */
    hasInstruction: boolean;
    /** Whether that text still holds a picked example's `TOPIC_PLACEHOLDER`. */
    placeholderLeft?: boolean;
    /** The names of the collections the chat input carries. */
    collections?: string[];
}

/** How a task's `collectionHint` names what is attached. */
function attachedCollections(names: string[]): string {
    return names.length === 1 ? `the “${names[0]}” collection` : `the ${names.length} attached collections`;
}

/**
 * The numbered steps of a task's setup card: the Beaver model for a task that
 * only runs on it (starting a task selects it, so the step shows only after a
 * switch away), the PDF for a task that works on one, and what Beaver should
 * do. The first required step not yet done is `active`.
 *
 * What Beaver should do is optional for a task that can find it out itself,
 * with two exceptions to how it reads: an attached collection settles it for
 * a task that works on one, and a picked example holds Send until its topic
 * placeholder is replaced.
 */
export function setupSteps({
    definition, papers, onBeaverModel, hasInstruction, placeholderLeft = false, collections = [],
}: SetupInput): SetupStep[] {
    const steps: SetupStep[] = [];
    if (definition.requiresBeaverModel && !onBeaverModel) {
        steps.push({
            key: 'model',
            title: 'Use the Beaver model',
            text: 'This task runs on Beaver credits, not your own API key.',
            status: 'pending',
            requiredHint: 'Switch to the Beaver model',
        });
    }
    if (definition.attach === 'pdf') {
        const source = pdfSource(papers);
        steps.push({
            key: 'source',
            title: 'Choose a PDF',
            text: source.text,
            status: source.state === 'ready' ? 'done' : source.state === 'checking' ? 'checking' : 'pending',
            requiredHint: source.state === 'checking' ? 'Checking the PDF…' : 'Choose a PDF',
        });
    }
    const { prompt } = definition;
    const onCollection = !!prompt.collectionHint && collections.length > 0;
    steps.push({
        key: 'prompt',
        title: prompt.heading,
        text: onCollection
            ? prompt.collectionHint!.replace('{collection}', attachedCollections(collections))
            : prompt.hint,
        status: !placeholderLeft && (hasInstruction || onCollection) ? 'done' : 'pending',
        requiredHint: placeholderLeft ? `Replace ${TOPIC_PLACEHOLDER} with your topic` : prompt.requiredHint,
        ...(onCollection ? { hideExamples: true } : {}),
    });
    const next = steps.find((step) => step.requiredHint && step.status === 'pending');
    if (next) next.status = 'active';
    return steps;
}

/** Send's tooltip from the first required step not yet done; null when the message can be sent. */
export function sendHoldHint(steps: SetupStep[]): string | null {
    return steps.find((step) => step.requiredHint && step.status !== 'done')?.requiredHint ?? null;
}

/** A collection as an action result or a sent message names it; its library is not resolved yet. */
export interface CollectionCandidate {
    library_ref?: string;
    library_id?: number;
    zotero_key: string;
}

/**
 * Reads collections from an action result. Each id is portable (`u-KEY`) or,
 * in older results, a bare key within the result's library.
 */
function collectionsIn(ids: unknown, libraryId: unknown): CollectionCandidate[] {
    const candidates: CollectionCandidate[] = [];
    for (const id of Array.isArray(ids) ? ids : [ids]) {
        if (typeof id !== 'string' || !id) continue;
        const parsed = parseItemReference(id);
        if (parsed) candidates.push(parsed);
        else if (typeof libraryId === 'number') candidates.push({ library_id: libraryId, zotero_key: id });
    }
    return candidates;
}

/**
 * The collections a finished answer worked on, for the next task to start
 * from, best first: those it made, then those it imported papers into (a
 * project that reuses a collection), then those its message was sent with.
 */
export function collectionCandidates(
    runs: ReadonlyArray<Pick<AgentRun, 'user_prompt'>>,
    actions: ReadonlyArray<Pick<AgentAction, 'action_type' | 'status' | 'result_data'>>,
): CollectionCandidate[] {
    const created: CollectionCandidate[] = [];
    const importedInto: CollectionCandidate[] = [];
    for (let index = actions.length - 1; index >= 0; index--) {
        const { action_type, status, result_data } = actions[index];
        if (status !== 'applied' || !result_data) continue;
        if (action_type === 'create_collection') {
            created.push(...collectionsIn(result_data.collection_id ?? result_data.collection_key, result_data.library_id));
        } else if (action_type === 'import_item') {
            importedInto.push(...collectionsIn(result_data.collection_ids ?? result_data.collection_keys, result_data.library_id));
        }
    }
    const attached: CollectionCandidate[] = [];
    for (const attachment of runs[0]?.user_prompt.attachments ?? []) {
        if (attachment.type !== 'collection') continue;
        attached.push({ library_id: attachment.library_id, library_ref: attachment.library_ref, zotero_key: attachment.zotero_key });
    }
    return [...created, ...importedInto, ...attached];
}

/** The highlights a finished answer added, in page order. */
export function createdHighlights(
    actions: ReadonlyArray<Pick<AgentAction, 'action_type' | 'status' | 'result_data'>>,
): { library_id: number; zotero_key: string }[] {
    const highlights: { library_id: number; zotero_key: string; page: number }[] = [];
    for (const { action_type, status, result_data } of actions) {
        if (action_type !== 'create_highlight_annotations' || status !== 'applied') continue;
        for (const created of Array.isArray(result_data?.created) ? result_data.created : []) {
            if (typeof created?.library_id !== 'number' || typeof created?.zotero_key !== 'string') continue;
            const page = typeof created.page_idx === 'number' ? created.page_idx : Number.MAX_SAFE_INTEGER;
            highlights.push({ library_id: created.library_id, zotero_key: created.zotero_key, page });
        }
    }
    return highlights
        .sort((a, b) => a.page - b.page)
        .map(({ library_id, zotero_key }) => ({ library_id, zotero_key }));
}

/**
 * The tasks the first-run page offers: every task in a library of a useful
 * size, otherwise only those that need no papers.
 */
export function firstRunOfferedTasks<T extends {
    definition: Pick<FeatureTaskDefinition, 'worksWithoutPapers'>;
}>(entries: T[], libraryReady: boolean): T[] {
    return libraryReady ? entries : entries.filter(({ definition }) => definition.worksWithoutPapers);
}
