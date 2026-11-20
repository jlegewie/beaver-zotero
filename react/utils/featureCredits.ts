/**
 * Feature credits: wording and bookkeeping that does not touch Zotero.
 */
import type { FeatureTaskAttachKind } from '../constants/featureCreditTasks';

/**
 * Whether an attached paper has a file Beaver can annotate (a PDF, EPUB or
 * snapshot), from the readability check the chat input runs on attachments.
 * `none`: no such file; `unreadable`: none of its files has text Beaver can read.
 */
export type DocumentStatus = 'readable' | 'checking' | 'unreadable' | 'none';

export interface AttachedPaper {
    /** Display name, e.g. "Smith 2020". */
    name: string;
    document: DocumentStatus;
}

/** What the chat input has attached, as the setup card describes it. */
export interface AttachmentSummary {
    /** Attached papers (items and the open PDF); an attachment stands for its parent. */
    papers: AttachedPaper[];
    /** Attached collections, with their item counts when known. */
    collections: { name: string; itemCount: number | null }[];
}

/**
 * Step 1 of a setup card: what Beaver works on. Every task has it, so each
 * card says the same things the same way: what is attached, what Beaver uses
 * without an attachment, or how to add the input it needs.
 */
export interface SetupSource {
    title: string;
    /** Whether the task also works without attachments. */
    optional: boolean;
    /**
     * `ready`: the chat input carries what Beaver will work on (the step is done).
     * `default`: nothing attached, and Beaver knows what to use instead.
     * `checking`: the attachments' files are still being read.
     * `missing`: the task needs an attachment the chat input lacks, or the
     * attached papers have no file it can use.
     */
    state: 'ready' | 'default' | 'checking' | 'missing';
    /** One sentence: what is attached, or how to add it. */
    text: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function collectionLabel(collection: AttachmentSummary['collections'][number]): string {
    const name = `the ${collection.name} collection`;
    return collection.itemCount === null ? name : `${name} (${plural(collection.itemCount, 'paper')})`;
}

/** "Smith 2020", "The Neighborhood effects collection (14 papers)", "3 papers", or both joined. */
function attachedLabel(summary: AttachmentSummary): { label: string; plural: boolean } {
    const parts: string[] = [];
    let count = 0;
    for (const collection of summary.collections) {
        parts.push(collectionLabel(collection));
        count++;
    }
    if (summary.papers.length === 1 && summary.collections.length === 0) {
        return { label: summary.papers[0].name, plural: false };
    }
    if (summary.papers.length > 0) {
        parts.push(plural(summary.papers.length, 'paper'));
        count += summary.papers.length;
    }
    const label = parts.join(' and ');
    return { label: label.charAt(0).toUpperCase() + label.slice(1), plural: count > 1 };
}

function hasAttachments(summary: AttachmentSummary): boolean {
    return summary.papers.length > 0 || summary.collections.length > 0;
}

/**
 * Whether the attachments are what a review or table covers: a collection or
 * two or more papers. One paper still needs a topic to find the others.
 */
export function attachmentsSetScope(summary: AttachmentSummary): boolean {
    return summary.collections.length > 0 || summary.papers.length >= 2;
}

/**
 * One status for a paper from those of its PDF, EPUB and snapshot files:
 * a single readable file is enough.
 */
export function combineDocumentStatuses(statuses: DocumentStatus[]): DocumentStatus {
    if (statuses.includes('readable')) return 'readable';
    if (statuses.includes('checking')) return 'checking';
    if (statuses.includes('unreadable')) return 'unreadable';
    return 'none';
}

const FIND_ANOTHER = 'Open a PDF in Zotero, or type @ to find another paper.';
const ADD_PAPERS = 'Type @ or drag in a collection or papers.';

/** "Smith 2020 is attached." / "3 papers are attached." */
function attachedSentence(summary: AttachmentSummary): string {
    const { label, plural: many } = attachedLabel(summary);
    return `${label} ${many ? 'are' : 'is'} attached.`;
}

/** Annotating: papers count only once Beaver can read one of their files. */
function annotateSource(summary: AttachmentSummary): SetupSource {
    const title = 'Choose a PDF';
    if (!hasAttachments(summary)) {
        return {
            title,
            optional: false,
            state: 'missing',
            text: 'Open one in Zotero, type @ to find a paper, or drag one into the prompt.',
        };
    }
    const { label, plural: many } = attachedLabel(summary);
    const count = (status: DocumentStatus) => summary.papers.filter((paper) => paper.document === status).length;
    const readable = count('readable');
    const checking = count('checking');
    // A collection's papers are found and checked when the run starts.
    if (readable > 0 || summary.collections.length > 0) {
        const skipped = summary.papers.length - readable - checking;
        const note = skipped > 0 && checking === 0
            ? ` ${plural(skipped, 'paper')} without a readable PDF, EPUB or snapshot ${skipped === 1 ? 'is' : 'are'} skipped.`
            : '';
        return { title, optional: false, state: 'ready', text: attachedSentence(summary) + note };
    }
    if (checking > 0) return { title, optional: false, state: 'checking', text: `Checking ${label}…` };
    const noFile = count('none') === summary.papers.length;
    return {
        title,
        optional: false,
        state: 'missing',
        text: noFile
            ? `${label} ${many ? 'have' : 'has'} no PDF, EPUB or snapshot. ${FIND_ANOTHER}`
            : `Beaver can't read the text of ${label}. ${FIND_ANOTHER}`,
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

/** What a table does with the attached papers, following its 10–20 paper rule. */
function tableUse(summary: AttachmentSummary, many: boolean): string {
    const count = attachedPaperCount(summary);
    if (count === null || count > 20) {
        return `Beaver will pick the most relevant papers from ${many ? 'them' : 'it'}. Remove ${many ? 'them' : 'it'} to search your whole library.`;
    }
    if (count >= 10) return 'Beaver will use these papers.';
    return 'Beaver will add related papers from your library.';
}

/** Step 1 of a task's setup card. */
export function setupSource(attach: FeatureTaskAttachKind, summary: AttachmentSummary): SetupSource {
    if (attach.kind === 'paper') return annotateSource(summary);
    if (attach.kind === 'none') {
        return { title: 'Nothing to attach', optional: false, state: 'ready', text: 'Beaver works on your whole library.' };
    }
    const title = 'Choose papers';
    if (!hasAttachments(summary)) {
        return {
            title,
            optional: true,
            state: 'default',
            text: `${ADD_PAPERS} Without any, Beaver finds papers on your topic in your library.`,
        };
    }
    const attached = attachedSentence(summary);
    if (!attachmentsSetScope(summary)) {
        return { title, optional: true, state: 'ready', text: `${attached} Name a topic in the next step, and Beaver adds related papers.` };
    }
    if (attach.kind === 'topic') {
        return { title, optional: true, state: 'ready', text: `${attached} ${tableUse(summary, attachedLabel(summary).plural)}` };
    }
    return { title, optional: true, state: 'ready', text: attached };
}

/** A line on a setup card about which model to run the task with. */
export interface ModelNote {
    text: string;
    /** Show it as a numbered step: the task does not work without it. */
    required: boolean;
}

/**
 * What a setup card says about the model, or null when the chat input
 * already uses the Beaver model. Tables only run on Beaver credits; the other
 * tasks run on any model but work best with the Beaver model. The card
 * follows the note with a link that switches to the Beaver model.
 */
export function featureTaskModelNote(taskKey: string, onBeaverModel: boolean): ModelNote | null {
    if (onBeaverModel) return null;
    return taskKey === 'research_table'
        ? { text: 'Tables run on Beaver credits.', required: true }
        : { text: 'These tasks work best with the Beaver model.', required: false };
}
