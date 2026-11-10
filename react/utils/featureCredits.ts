/**
 * Feature credits: wording and bookkeeping that does not touch Zotero.
 */
import type { FeatureCreditTask } from '@beaver/agent-core/types/profile';
import type { FeatureTaskAttachKind } from '../constants/featureCreditTasks';

/** What the chat input has attached, as the setup card describes it. */
export interface AttachmentSummary {
    /** Attached papers (items and the open PDF), with display names. */
    papers: string[];
    /** Attached collections, with their item counts when known. */
    collections: { name: string; itemCount: number | null }[];
}

/** One line of a setup card: done (✓) or a numbered instruction. */
export interface AttachStep {
    done: boolean;
    /** Bold lead, e.g. "Attach a paper:" or "Smith 2020 is attached." */
    lead: string;
    /** Plain text after the lead. */
    text: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function collectionLabel(collection: AttachmentSummary['collections'][number]): string {
    return collection.itemCount === null
        ? collection.name
        : `${collection.name} (${plural(collection.itemCount, 'paper')})`;
}

/** "Smith 2020", "Neighborhood effects (14 papers)", "3 papers", or both joined. */
function attachedLabel(summary: AttachmentSummary): { label: string; plural: boolean } {
    const parts: string[] = [];
    let count = 0;
    for (const collection of summary.collections) {
        parts.push(collectionLabel(collection));
        count++;
    }
    if (summary.papers.length === 1 && summary.collections.length === 0) {
        return { label: summary.papers[0], plural: false };
    }
    if (summary.papers.length > 0) {
        parts.push(plural(summary.papers.length, 'paper'));
        count += summary.papers.length;
    }
    return { label: parts.join(' and '), plural: count > 1 };
}

function hasAttachments(summary: AttachmentSummary): boolean {
    return summary.papers.length > 0 || summary.collections.length > 0;
}

/**
 * Step 1 of a setup card for tasks that work on papers or a collection.
 * Null for topic tasks, whose attachments get a status line instead.
 */
export function attachStep(attach: FeatureTaskAttachKind, summary: AttachmentSummary): AttachStep | null {
    if (attach.kind === 'topic') return null;
    if (hasAttachments(summary)) {
        const { label, plural: many } = attachedLabel(summary);
        const onePaper = summary.papers.length === 1 && summary.collections.length === 0;
        return {
            done: true,
            lead: `${label} ${many ? 'are' : 'is'} attached.`,
            text: onePaper
                ? 'Add other papers with @ or drag and drop.'
                : 'Add more with @ or drag and drop.',
        };
    }
    if (attach.kind === 'collection') {
        return {
            done: false,
            lead: 'Attach a collection or papers:',
            text: 'type @ to search, or drag them in from Zotero. If you attach nothing, Beaver works on your recent additions.',
        };
    }
    return {
        done: false,
        lead: attach.optional ? 'Optional: attach a paper to write about:' : 'Attach a paper:',
        text: 'type @ to search your library, drag it in from Zotero, or open its PDF.',
    };
}

/** Papers the attachments stand for, for the table size rule. */
function attachedPaperCount(summary: AttachmentSummary): number | null {
    let count = summary.papers.length;
    for (const collection of summary.collections) {
        if (collection.itemCount === null) return null;
        count += collection.itemCount;
    }
    return count;
}

/**
 * The status line a topic task shows when something is already attached:
 * what Beaver will do with it, following the table's 10–20 paper rule.
 */
export function topicStatus(summary: AttachmentSummary): AttachStep | null {
    if (!hasAttachments(summary)) return null;
    const { label, plural: many } = attachedLabel(summary);
    const lead = `${label} ${many ? 'are' : 'is'} attached.`;
    const count = attachedPaperCount(summary);
    if (count === null || count > 20) {
        return {
            done: true,
            lead,
            text: `Beaver will pick the most relevant papers from ${many ? 'them' : 'it'}. Remove ${many ? 'them' : 'it'} to search your whole library.`,
        };
    }
    if (count >= 10) return { done: true, lead, text: 'Beaver will use these papers.' };
    return { done: true, lead, text: 'Beaver will add related papers from your library.' };
}

/** How long after leaving a chat its completion card can still show. */
export const COMPLETION_GRACE_MS = 60_000;

/** A completed task waiting for its chat to be idle. */
export interface PendingCompletion {
    task: FeatureCreditTask;
}

/**
 * Decides, for one window, which newly completed tasks get a completion card.
 *
 * Tasks already done when the window first sees the account (or when the
 * account changes) never produce a card. A task that becomes done does when
 * the chat it was done in is open in the window, or was left less than
 * {@link COMPLETION_GRACE_MS} ago. Either way each task is handled once.
 * Cards wait until the open chat is idle; {@link takeReady} hands them out.
 */
export class FeatureCreditCompletionTracker {
    private generation: number | null = null;
    private recorded: Set<string> | null = null;
    private openThreadId: string | null = null;
    private lastLeft: { threadId: string; at: number } | null = null;
    private pending: PendingCompletion[] = [];

    constructor(
        private readonly isKnownTask: (key: string) => boolean,
        private readonly now: () => number = Date.now,
    ) {}

    /** The chat open in the window changed. */
    setOpenThread(threadId: string | null): void {
        if (threadId === this.openThreadId) return;
        if (this.openThreadId) this.lastLeft = { threadId: this.openThreadId, at: this.now() };
        this.openThreadId = threadId;
    }

    /** The window's copy of the profile changed. */
    updateTasks(tasks: FeatureCreditTask[] | null | undefined, generation: number): void {
        if (generation !== this.generation) {
            this.generation = generation;
            this.recorded = null;
            this.pending = [];
            this.lastLeft = null;
        }
        if (!tasks) return;
        if (!this.recorded) {
            this.recorded = new Set(tasks.filter((task) => task.completed_at).map((task) => task.key));
            return;
        }
        for (const task of tasks) {
            if (!task.completed_at || this.recorded.has(task.key)) continue;
            this.recorded.add(task.key);
            if (!this.isKnownTask(task.key)) continue;
            if (this.wasDoneHere(task.source?.thread_id ?? null)) this.pending.push({ task });
        }
    }

    private wasDoneHere(threadId: string | null): boolean {
        if (!threadId) return false;
        if (threadId === this.openThreadId) return true;
        return !!this.lastLeft
            && this.lastLeft.threadId === threadId
            && this.now() - this.lastLeft.at < COMPLETION_GRACE_MS;
    }

    /** Completions to show now, given whether the open chat is idle. */
    takeReady(idle: boolean): PendingCompletion[] {
        if (!idle || this.pending.length === 0) return [];
        const ready = this.pending;
        this.pending = [];
        return ready;
    }
}

/** Credits a task run needs, roughly: below this the Beaver model can't run one. */
export const FEATURE_TASK_MIN_CREDITS = 2;

/** What the user can run a task with right now. */
export interface ModelAccess {
    /** The chat input's model runs on Beaver credits. */
    onBeaverModel: boolean;
    /** The account has enough Beaver credits for a task run. */
    hasBeaverCredits: boolean;
    /** The user has a model of their own (an API key or a custom model). */
    hasOwnModel: boolean;
}

/** A line on a setup card about which model to run the task with. */
export interface ModelNote {
    text: string;
    /** Offer a link that switches the chat input to the Beaver model. */
    offerBeaverModel: boolean;
    /** Show it as a numbered step: the task does not work without it. */
    required: boolean;
}

/** Whether the user can run a task at all, with Beaver credits or a model of their own. */
export function canRunFeatureTasks(access: ModelAccess): boolean {
    return access.hasBeaverCredits || access.hasOwnModel;
}

/**
 * What a setup card says about the model, or null when the chat input is
 * already set up to run the task well. Tables only run on Beaver credits;
 * the other tasks run on any model but work best with the Beaver model.
 */
export function featureTaskModelNote(taskKey: string, access: ModelAccess): ModelNote | null {
    const needsBeaverCredits = taskKey === 'research_table';
    if (!access.hasBeaverCredits) {
        if (needsBeaverCredits) {
            return { text: "Tables run on Beaver credits, and you don't have enough left.", offerBeaverModel: false, required: true };
        }
        if (!access.onBeaverModel) return null;
        return access.hasOwnModel
            ? { text: "You don't have enough Beaver credits left. Choose your own model in the chat input to try this.", offerBeaverModel: false, required: true }
            : { text: "You don't have enough Beaver credits left. Add credits or your own API key to try this.", offerBeaverModel: false, required: true };
    }
    if (access.onBeaverModel) return null;
    return needsBeaverCredits
        ? { text: 'Tables run on Beaver credits.', offerBeaverModel: true, required: true }
        : { text: 'These tasks work best with the Beaver model.', offerBeaverModel: true, required: false };
}
