/**
 * Feature credits: wording and bookkeeping that does not touch Zotero.
 */
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
        return { label: summary.papers[0], plural: false };
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
 * Step 1 of a setup card for tasks that work on papers or a collection.
 * Null for topic tasks, whose attachments get a status line instead, and for
 * tasks that take no attachments.
 */
export function attachStep(attach: FeatureTaskAttachKind, summary: AttachmentSummary): AttachStep | null {
    if (attach.kind === 'topic' || attach.kind === 'none') return null;
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
            text: `type @ to search, or drag them in from Zotero. ${attach.ifNone}`,
        };
    }
    return {
        done: false,
        lead: 'Attach a paper:',
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
