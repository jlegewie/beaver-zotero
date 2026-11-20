/**
 * Feature credits: wording and bookkeeping that does not touch Zotero.
 */
import type { FeatureTaskDefinition } from '../constants/featureCreditTasks';

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
}

export interface SetupInput {
    definition: FeatureTaskDefinition;
    /** The papers the chat input carries, for a task that works on a PDF. */
    papers: AttachedPaper[];
    onBeaverModel: boolean;
    /** Whether the message has text besides its /command. */
    hasInstruction: boolean;
}

/**
 * The numbered steps of a task's setup card: the Beaver model for a task that
 * only runs on it (starting a task selects it, so the step shows only after a
 * switch away), the PDF for a task that works on one, and what Beaver should
 * do. The first required step not yet done is `active`.
 */
export function setupSteps({ definition, papers, onBeaverModel, hasInstruction }: SetupInput): SetupStep[] {
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
    steps.push({
        key: 'prompt',
        title: prompt.heading,
        text: prompt.hint,
        status: hasInstruction ? 'done' : 'pending',
        requiredHint: prompt.requiredHint,
    });
    const next = steps.find((step) => step.requiredHint && step.status === 'pending');
    if (next) next.status = 'active';
    return steps;
}

/** Send's tooltip from the first required step not yet done; null when the message can be sent. */
export function sendHoldHint(steps: SetupStep[]): string | null {
    return steps.find((step) => step.requiredHint && step.status !== 'done')?.requiredHint ?? null;
}
