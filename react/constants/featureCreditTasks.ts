/**
 * Feature-credit tasks this client knows how to present.
 *
 * The server owns the task list, the amounts and whether a task is done
 * (`profile.feature_credits`); this registry only supplies the words and the
 * action each task teaches. Keys the server sends that are not listed here
 * are not shown, so the server can add a task before the client supports it.
 */

import type { Action } from '@beaver/agent-core/types/actions';

/** What step 1 of a setup card asks the user to attach. */
export type FeatureTaskAttachKind =
    /** One or more papers (`optional`: the task also works without). */
    | { kind: 'paper'; optional?: boolean }
    /** A collection or papers; without either the action works on recent additions. */
    | { kind: 'collection' }
    /** A topic in the instruction; attachments only adjust what Beaver picks. */
    | { kind: 'topic' };

/** How the user organizes the library, used to pick fitting examples. */
export interface LibraryShape {
    /** Collections across the searchable libraries. */
    collectionCount: number;
    /** Whether any item in a searchable library has a manual tag. */
    usesTags: boolean;
}

export interface FeatureTaskExample {
    text: string;
    /** Shown only when this returns true for the user's library. */
    when?: (shape: LibraryShape) => boolean;
    /**
     * Shown as plain text, not as a link that fills in the chat input: the
     * example names a topic, which only fits some libraries, so it shows the
     * form of an instruction rather than one to send.
     */
    illustration?: boolean;
}

export interface FeatureTaskDefinition {
    key: string;
    title: string;
    subtitle: string;
    /** The built-in action the setup card stages. */
    actionId: string;
    /** One sentence on what the skill does. */
    explanation: string;
    attach: FeatureTaskAttachKind;
    /** The instruction step, completed by "For example:" and the examples. */
    instruction: string;
    examples: FeatureTaskExample[];
    /** The last step. */
    finalStep: string;
    /** A note under the steps. */
    footnote?: string;
    /** The card shown once the task is earned. */
    completion: {
        /** One sentence on what else the skill can do. */
        tip: string;
        docsUrl: string;
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
        key: 'annotate',
        title: 'Annotate a document',
        subtitle: 'Highlights and comments, added to your PDF',
        actionId: 'builtin-annotate',
        explanation: "Beaver reads a paper and adds highlights and comments in Zotero's reader.",
        attach: { kind: 'paper' },
        instruction: 'say what to highlight',
        examples: [
            { text: 'color-code the research question, methods, results and limitations' },
            { text: 'the key passages I need to skim the paper' },
        ],
        finalStep: 'Press Send. Accept the highlights if Beaver asks.',
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
        key: 'note',
        title: 'Write a note in Zotero',
        subtitle: 'Summaries, reviews and topic notes, cited to page',
        actionId: 'builtin-create-note',
        explanation: 'Beaver writes notes that live in Zotero. Every citation jumps to the exact passage.',
        attach: { kind: 'paper', optional: true },
        instruction: 'say what the note should be',
        examples: [
            { text: 'a summary of this paper' },
            { text: 'a literature review of the papers in this collection' },
        ],
        finalStep: 'Press Send. Accept the note if Beaver asks.',
        completion: {
            tip: 'Click a citation in the note to open the page it cites. Beaver can also edit your notes, and notes export to Word.',
            docsUrl: `${DOCS_BASE_URL}/notes`,
        },
    },
    {
        key: 'organize',
        title: 'Organize your library',
        subtitle: 'Collections, tags and metadata, filed for you',
        actionId: 'builtin-organize',
        explanation: 'Beaver does the tedious library work: collections, tags, metadata and duplicates. You review every change, and you can undo it.',
        attach: { kind: 'collection' },
        instruction: 'say what to do',
        examples: [
            { text: 'file my 20 most recent papers into my collections', when: (shape) => shape.collectionCount >= 2 },
            { text: 'tag the papers in this collection', when: (shape) => shape.usesTags },
            { text: 'fill in missing abstracts and DOIs' },
        ],
        finalStep: 'Press Send. Accept the changes if Beaver asks.',
        completion: {
            tip: 'Beaver can also merge duplicates, split a big collection into sub-collections, and set up a collection for a new project.',
            docsUrl: `${DOCS_BASE_URL}/library-management`,
        },
    },
    {
        key: 'research_table',
        title: 'Compare papers in a table',
        subtitle: 'One row per paper, one column per question',
        actionId: 'builtin-research-table',
        explanation: 'Beaver finds papers on a topic in your library and answers your questions about each one in a table. Every cell links to the quote behind it.',
        attach: { kind: 'topic' },
        instruction: 'name a topic and what to compare',
        examples: [
            { text: 'neighborhood effects on school outcomes: method, sample and main finding', illustration: true },
            { text: 'social capital: definition used and how it is measured', illustration: true },
        ],
        finalStep: 'Press Send, check the papers and questions Beaver proposes, then create the table with "Fill the table now" ticked.',
        footnote: 'Filling a table uses credits per row. You see the cost before anything is filled.',
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

/** The examples that fit the user's library (all of them while it is unknown). */
export function examplesForLibrary(task: FeatureTaskDefinition, shape: LibraryShape | null): FeatureTaskExample[] {
    if (!shape) return task.examples.filter((example) => !example.when);
    return task.examples.filter((example) => !example.when || example.when(shape));
}
