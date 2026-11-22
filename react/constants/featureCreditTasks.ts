/**
 * Feature-credit tasks this client knows how to present.
 *
 * The server owns the task list, the amounts and whether a task is done
 * (`profile.feature_credits`); this registry only supplies the words and the
 * action each task teaches. Keys the server sends that are not listed here
 * are not shown, so the server can add a task before the client supports it.
 */

import type { Action } from '@beaver/agent-core/types/actions';

/** How the user organizes the library, used to pick fitting examples. */
export interface LibraryShape {
    /** Collections across the searchable libraries. */
    collectionCount: number;
    /** Whether any item in a searchable library has a manual tag. */
    usesTags: boolean;
}

/**
 * Stands for the topic in an example, so the example fits any library. It is
 * selected when the example is picked, so typing replaces it, and Send waits
 * until the user does.
 */
export const TOPIC_PLACEHOLDER = '[your topic]';

export interface FeatureTaskExample {
    /**
     * Put after the /command when picked; the user reviews it before sending.
     * A topic is written as `TOPIC_PLACEHOLDER`.
     */
    text: string;
    /** Shown only when this returns true for the user's library. */
    when?: (shape: LibraryShape) => boolean;
}

/** The setup card's "what should Beaver do" section. */
export interface FeatureTaskPrompt {
    heading: string;
    /** Under the heading, above the examples. */
    hint: string;
    /**
     * Set when Send waits for an instruction: Send's tooltip meanwhile.
     * Without it the action runs without one, and the step reads "(optional)".
     */
    requiredHint?: string;
    /**
     * Set on a task that works on an attached collection's papers: shown
     * instead of `hint` and the examples while one is attached. `{collection}`
     * stands for what is attached.
     */
    collectionHint?: string;
}

export interface FeatureTaskDefinition {
    key: string;
    title: string;
    subtitle: string;
    /** The built-in action the setup card stages. */
    actionId: string;
    /**
     * `pdf`: the task works on an attached PDF, which the card asks for.
     * `none`: Beaver finds what to work on in the library. Whatever the chat
     * input carries is still sent, but the card does not ask for it.
     */
    attach: 'pdf' | 'none';
    /** The task does not run on the user's own API key. */
    requiresBeaverModel?: boolean;
    /**
     * The task needs no papers in the library: first run offers only these
     * when the library is below the small-library threshold.
     */
    worksWithoutPapers?: boolean;
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
         * Shown instead of the tip and the docs link when the run made a
         * table: one sentence, then a link that opens the table.
         */
        tableTip?: { text: string; label: string };
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
        title: 'Annotate a PDF',
        subtitle: 'Add highlights and comments directly to your PDFs',
        actionId: 'builtin-annotate',
        attach: 'pdf',
        prompt: {
            heading: 'What should Beaver highlight?',
            hint: 'Type it in the prompt, or start from an example:',
            requiredHint: 'Describe what to highlight',
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
        key: 'start_project',
        title: 'Start a research project',
        subtitle: 'A collection of your papers, plus new ones Beaver finds',
        actionId: 'builtin-start-project',
        attach: 'none',
        worksWithoutPapers: true,
        prompt: {
            heading: 'What is the project about?',
            hint: 'Type a topic or research question, or send as is and Beaver suggests topics from your library.',
        },
        examples: [],
        footnote: 'Beaver asks before it adds anything to your library.',
        completion: {
            tip: 'The project has its own collection. Attach a collection with @ and Beaver works on its papers.',
            docsUrl: `${DOCS_BASE_URL}/library-management`,
        },
    },
    {
        key: 'research_table',
        title: 'Compare papers in a table',
        subtitle: 'Systematic comparison of research papers',
        actionId: 'builtin-research-table',
        attach: 'none',
        requiresBeaverModel: true,
        prompt: {
            heading: 'What should the table compare?',
            hint: 'Type a topic and what to ask of each paper, or send as is and Beaver suggests topics from your library. Examples:',
            collectionHint: 'Beaver compares the papers in {collection}. Say what to ask of each, or send as is.',
        },
        examples: [
            { text: `Papers on ${TOPIC_PLACEHOLDER}: method, sample, and main finding` },
            { text: `Papers on ${TOPIC_PLACEHOLDER}: how each defines and measures its key concept` },
        ],
        completion: {
            tip: 'Click a cell to see the quote behind it. Next time, attach a collection to compare its papers.',
            tableTip: { text: 'Click a cell in the table to see the quote behind it.', label: 'Open the table' },
            docsUrl: `${DOCS_BASE_URL}/research-tables`,
        },
    },
    {
        key: 'literature_review',
        title: 'Write a literature review',
        subtitle: 'A cited review as a Zotero note',
        actionId: 'builtin-collection-literature-review',
        attach: 'none',
        prompt: {
            heading: 'What should the review cover?',
            hint: 'Type a topic, and a purpose or length if you like, or send as is and Beaver suggests topics from your library. Examples:',
            collectionHint: 'Beaver reviews the papers in {collection}. Add a purpose or length if you like, or send as is.',
        },
        examples: [
            { text: `Background on ${TOPIC_PLACEHOLDER} for a grant proposal` },
            { text: `An outline of the research on ${TOPIC_PLACEHOLDER}` },
        ],
        completion: {
            tip: 'Beaver writes a review as a note in Zotero: click a citation to open the passage it cites. Next time, attach a collection to review its papers.',
            noteTip: 'Your literature review is stored as a note in Zotero. Export it as Word, PDF or LaTeX using',
            docsUrl: `${DOCS_BASE_URL}/notes`,
        },
    },
    {
        key: 'organize',
        title: 'Organize your library',
        subtitle: 'Collections, tags, metadata and more',
        actionId: 'builtin-tidy-up',
        attach: 'none',
        prompt: {
            heading: 'What should Beaver tidy up?',
            hint: 'Beaver looks over your whole library. Name a focus, or send as is. For example:',
        },
        examples: [
            { text: 'File my unfiled papers into my collections', when: (shape) => shape.collectionCount >= 2 },
            { text: 'Tag my untagged papers', when: (shape) => shape.usesTags },
            { text: 'Fill in missing abstracts and DOIs' },
        ],
        footnote: 'You approve a large clean-up before it runs, and can undo every change.',
        completion: {
            tip: 'Beaver can also merge duplicates, split a big collection into sub-collections, and fill in missing metadata.',
            docsUrl: `${DOCS_BASE_URL}/library-management`,
        },
    },
];

const TASKS_BY_KEY = new Map(FEATURE_CREDIT_TASKS.map((task) => [task.key, task]));

/** The client's definition of a task, or undefined for a key it does not know. */
export function getFeatureCreditTask(key: string): FeatureTaskDefinition | undefined {
    return TASKS_BY_KEY.get(key);
}

/**
 * The examples that fit the user's library: only those without a library
 * condition while its shape is unknown.
 */
export function examplesForLibrary(task: FeatureTaskDefinition, shape: LibraryShape | null): FeatureTaskExample[] {
    return task.examples.filter((example) => !example.when || (!!shape && example.when(shape)));
}
