/**
 * Feature-credit tasks this client knows how to present.
 *
 * The server owns the task list, the amounts and whether a task is done
 * (`profile.feature_credits`); this registry only supplies the words and the
 * action each task teaches. Keys the server sends that are not listed here
 * are not shown, so the server can add a task before the client supports it.
 */

import type { Action } from '@beaver/agent-core/types/actions';

/** What a setup card's "Which papers?" section asks the user to attach. */
export type FeatureTaskAttachKind =
    /** One or more papers: required. */
    | { kind: 'paper' }
    /** A collection or papers; without either, the papers on a topic. */
    | { kind: 'collection' }
    /** Papers on a topic; attachments adjust which papers Beaver picks. */
    | { kind: 'topic' }
    /** Nothing to attach: the action finds what to work on itself. */
    | { kind: 'none' };

/** How the user organizes the library, used to pick fitting examples. */
export interface LibraryShape {
    /** Collections across the searchable libraries. */
    collectionCount: number;
    /** Whether any item in a searchable library has a manual tag. */
    usesTags: boolean;
}

export interface FeatureTaskExample {
    /**
     * Put after the /command when picked; the user reviews it before sending.
     * A topic is written as "[your topic]", so an example fits any library.
     */
    text: string;
    /** Shown only when this returns true for the user's library. */
    when?: (shape: LibraryShape) => boolean;
    /** Shown only when the attachments are (true) or are not (false) what the task covers. */
    attached?: boolean;
}

/** The setup card's "what should Beaver do" section. */
export interface FeatureTaskPrompt {
    heading: string;
    /** Under the heading, above the examples. */
    hint: string;
    /** The hint when the attachments are what the task covers. */
    hintWhenAttached?: string;
    /** When the action runs without an instruction. */
    optional?: 'always' | 'whenAttached';
}

export interface FeatureTaskDefinition {
    key: string;
    title: string;
    subtitle: string;
    /** The built-in action the setup card stages. */
    actionId: string;
    attach: FeatureTaskAttachKind;
    prompt: FeatureTaskPrompt;
    examples: FeatureTaskExample[];
    /** Added after the reward line under the steps. */
    footnote?: string;
    /** The card shown once the task is earned. */
    completion: {
        /** One sentence on what else the skill can do. */
        tip: string;
        docsUrl: string;
        /**
         * Shown instead of the tip and the docs link once the note the run
         * wrote is in the library, followed by the export icon of the note's
         * card above.
         */
        noteTip?: string;
        /**
         * A starter action of the user's own, offered instead of the docs
         * link: clicking saves it as a custom action and opens it for editing.
         */
        customAction?: {
            label: string;
            template: Pick<Action, 'title' | 'description' | 'text' | 'argumentHint' | 'targets' | 'category'>;
        };
    };
}

const DOCS_BASE_URL = 'https://www.beaverapp.ai/docs';

export const FEATURE_CREDIT_TASKS: FeatureTaskDefinition[] = [
    {
        key: 'literature_review',
        title: 'Write a literature review',
        subtitle: 'A cited review as a Zotero note',
        actionId: 'builtin-collection-literature-review',
        attach: { kind: 'collection' },
        prompt: {
            heading: 'What should the review cover?',
            hint: 'Name a topic, and a purpose or length if you like. For example:',
            hintWhenAttached: 'Add a purpose or length, or send as is. For example:',
            optional: 'whenAttached',
        },
        examples: [
            { text: 'A short review of these papers, organized by theme', attached: true },
            { text: 'An outline first', attached: true },
            { text: 'Background on [your topic] for a grant proposal', attached: false },
            { text: 'An outline of the research on [your topic]', attached: false },
        ],
        footnote: 'A long review can cost more; Beaver asks before going past your credit limit.',
        completion: {
            tip: 'Beaver writes a review as a note in Zotero: click a citation to open the passage it cites.',
            noteTip: 'Your literature review is stored as a note in Zotero. Export it as Word, PDF or LaTeX using',
            docsUrl: `${DOCS_BASE_URL}/notes`,
        },
    },
    {
        key: 'annotate',
        title: 'Annotate a PDF',
        subtitle: 'Add highlights and comments directly to your PDFs.',
        actionId: 'builtin-annotate',
        attach: { kind: 'paper' },
        prompt: {
            heading: 'What should Beaver highlight?',
            hint: 'Type it in the prompt, or start from an example:',
        },
        examples: [
            { text: 'Highlight key passages for a quick skim' },
            { text: 'Color-code the methods, findings, and limitations' },
        ],
        completion: {
            tip: 'Annotate the same way every time: create a reusable prompt with your colors and what to highlight.',
            customAction: {
                label: 'Create my annotation action',
                template: {
                    title: 'My annotations',
                    description: 'Highlight a paper the way I like it.',
                    text: 'Highlight this document with my color scheme:\n- Yellow: the research question or central argument\n- Green: data and methods\n- Blue: main results\n- Purple: limitations and open questions\n\nHighlight only short, high-signal passages (1-3 sentences each) and add a brief comment to each highlight.\n\nWhen finished, write a short summary organized by color (🟨, 🟩, 🟦, 🟪): state the legend, then 1-2 sentences per color citing its annotations.',
                    argumentHint: 'Optional: what to focus on',
                    targets: ['attachment'],
                    category: 'annotate',
                },
            },
            docsUrl: `${DOCS_BASE_URL}/annotations`,
        },
    },
    {
        key: 'organize',
        title: 'Organize your library',
        subtitle: 'Collections, tags, metadata and more',
        actionId: 'builtin-tidy-up',
        attach: { kind: 'none' },
        prompt: {
            heading: 'What should Beaver tidy up?',
            hint: 'Name a focus, or send as is. For example:',
            optional: 'always',
        },
        examples: [
            { text: 'File my unfiled papers into my collections', when: (shape) => shape.collectionCount >= 2 },
            { text: 'Tag my untagged papers', when: (shape) => shape.usesTags },
            { text: 'Fill in missing abstracts and DOIs' },
        ],
        footnote: 'You approve a large clean-up before it runs, and can undo every change.',
        completion: {
            tip: 'Beaver can also merge duplicates, split a big collection into sub-collections, and set up a collection for a new project.',
            docsUrl: `${DOCS_BASE_URL}/library-management`,
        },
    },
    {
        key: 'research_table',
        title: 'Compare papers in a table',
        subtitle: 'Systematic comparison of research papers',
        actionId: 'builtin-research-table',
        attach: { kind: 'topic' },
        prompt: {
            heading: 'What should the table compare?',
            hint: 'Name a topic and the questions to ask of each paper. For example:',
            hintWhenAttached: 'Say what to compare, or send as is and Beaver picks the questions. For example:',
            optional: 'whenAttached',
        },
        examples: [
            { text: 'Method, sample, and main finding', attached: true },
            { text: 'How each paper defines and measures its key concept', attached: true },
            { text: 'Papers on [your topic]: method, sample, and main finding', attached: false },
            { text: 'Papers on [your topic]: how each defines and measures its key concept', attached: false },
        ],
        // footnote: 'Filling a table uses credits per row. You see the cost before anything is filled.',
        completion: {
            tip: 'Click a cell to see the quote behind it. You can add a column with a new question and fill the remaining rows.',
            docsUrl: `${DOCS_BASE_URL}/research-tables`,
        },
    },
];

const TASKS_BY_KEY = new Map(FEATURE_CREDIT_TASKS.map((task) => [task.key, task]));

/** The client's definition of a task, or undefined for a key it does not know. */
export function getFeatureCreditTask(key: string): FeatureTaskDefinition | undefined {
    return TASKS_BY_KEY.get(key);
}

/**
 * The examples that fit the user's library (only those without a library
 * condition while its shape is unknown) and the chat input's attachments.
 */
export function examplesForLibrary(task: FeatureTaskDefinition, shape: LibraryShape | null, attached: boolean): FeatureTaskExample[] {
    return task.examples.filter((example) => {
        if (example.attached !== undefined && example.attached !== attached) return false;
        if (!example.when) return true;
        return !!shape && example.when(shape);
    });
}

/** The "what should Beaver do" section as the attachments make it read. */
export function promptSection(prompt: FeatureTaskPrompt, attached: boolean): { heading: string; hint: string; optional: boolean } {
    return {
        heading: prompt.heading,
        hint: attached ? (prompt.hintWhenAttached ?? prompt.hint) : prompt.hint,
        optional: prompt.optional === 'always' || (prompt.optional === 'whenAttached' && attached),
    };
}
