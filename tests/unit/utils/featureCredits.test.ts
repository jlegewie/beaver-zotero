import { isStoredAction } from '@beaver/agent-core/types/actions';
import { describe, expect, it } from 'vitest';
import {
    attachStep,
    featureTaskModelNote,
    topicStatus,
    type AttachmentSummary,
} from '../../../react/utils/featureCredits';
import { FEATURE_CREDIT_TASKS, examplesForLibrary, getFeatureCreditTask } from '../../../react/constants/featureCreditTasks';
import { ALL_BUILTIN_ACTIONS } from '../../../react/types/builtinActions';

const none: AttachmentSummary = { papers: [], collections: [] };
const papers = (...names: string[]): AttachmentSummary => ({ papers: names, collections: [] });
const collection = (name: string, itemCount: number | null): AttachmentSummary => ({ papers: [], collections: [{ name, itemCount }] });

describe('setup card step 1', () => {
    it('asks for a paper when nothing is attached', () => {
        expect(attachStep({ kind: 'paper' }, none)).toEqual({
            done: false,
            lead: 'Attach a paper:',
            text: 'type @ to search your library, drag it in from Zotero, or open its PDF.',
        });
    });

    it('names a single attached paper', () => {
        expect(attachStep({ kind: 'paper' }, papers('Smith 2020'))).toEqual({
            done: true,
            lead: 'Smith 2020 is attached.',
            text: 'Add other papers with @ or drag and drop.',
        });
    });

    it('counts several attached papers', () => {
        expect(attachStep({ kind: 'paper' }, papers('A', 'B', 'C'))).toMatchObject({
            done: true,
            lead: '3 papers are attached.',
            text: 'Add more with @ or drag and drop.',
        });
    });

    it('asks for a collection or papers, says what happens without, and names an attached collection', () => {
        const attach = { kind: 'collection', ifNone: 'If you attach nothing, Beaver works on your recent additions.' } as const;
        expect(attachStep(attach, none)).toEqual({
            done: false,
            lead: 'Attach a collection or papers:',
            text: 'type @ to search, or drag them in from Zotero. If you attach nothing, Beaver works on your recent additions.',
        });
        expect(attachStep(attach, collection('Neighborhood effects', 14))?.lead)
            .toBe('The Neighborhood effects collection (14 papers) is attached.');
    });

    it('lets a literature review go without attachments, on a topic', () => {
        const review = getFeatureCreditTask('literature_review')!;
        expect(attachStep(review.attach, none)?.text).toContain('Or attach nothing and name a topic in the next step.');
    });

    it('names a collection and papers attached together', () => {
        const attach = { kind: 'collection', ifNone: '' } as const;
        expect(attachStep(attach, { papers: ['A', 'B'], collections: [{ name: 'X', itemCount: 1 }] })?.lead)
            .toBe('The X collection (1 paper) and 2 papers are attached.');
        expect(attachStep(attach, { papers: [], collections: [{ name: 'A', itemCount: 2 }, { name: 'B', itemCount: null }] })?.lead)
            .toBe('The A collection (2 papers) and the B collection are attached.');
    });

    it('has no attach step for topic tasks', () => {
        expect(attachStep({ kind: 'topic' }, papers('A'))).toBeNull();
    });
});

describe('research table status line', () => {
    it('shows nothing when nothing is attached', () => {
        expect(topicStatus(none)).toBeNull();
    });

    it('follows the 10-20 paper rule', () => {
        expect(topicStatus(collection('Big', 300))?.text).toBe('Beaver will pick the most relevant papers from it. Remove it to search your whole library.');
        expect(topicStatus(collection('Mid', 14))?.text).toBe('Beaver will use these papers.');
        expect(topicStatus(papers('A', 'B'))?.text).toBe('Beaver will add related papers from your library.');
    });

    it('treats a collection of unknown size as large', () => {
        expect(topicStatus(collection('Unknown', null))?.text).toContain('pick the most relevant');
    });
});

describe('task registry', () => {
    it('has the four tasks, each with the action the server checks for', () => {
        expect(Object.fromEntries(FEATURE_CREDIT_TASKS.map((task) => [task.key, task.actionId]))).toEqual({
            annotate: 'builtin-annotate',
            organize: 'builtin-tidy-up',
            research_table: 'builtin-research-table',
            literature_review: 'builtin-collection-literature-review',
        });
        expect(getFeatureCreditTask('note')).toBeUndefined();
        expect(getFeatureCreditTask('unknown')).toBeUndefined();
    });

    it('teaches each task with a built-in action that exists', () => {
        const builtinIds = new Set(ALL_BUILTIN_ACTIONS.map((action) => action.id));
        for (const task of FEATURE_CREDIT_TASKS) expect(builtinIds.has(task.actionId)).toBe(true);
    });

    it('points to the export of the literature review note, with the notes docs as fallback', () => {
        const review = getFeatureCreditTask('literature_review')!;
        expect(review.completion.noteTip).toContain('Word, PDF or LaTeX');
        expect(review.completion.docsUrl).toBe('https://www.beaverapp.ai/docs/notes');
        expect(review.footnote).toContain('credit limit');
    });

    it('fits the organize examples to how the library is organized', () => {
        const organize = getFeatureCreditTask('organize')!;
        const texts = (shape: Parameters<typeof examplesForLibrary>[1]) => examplesForLibrary(organize, shape).map((e) => e.text);
        expect(texts({ collectionCount: 0, usesTags: false })).toEqual(['fill in missing abstracts and DOIs']);
        expect(texts({ collectionCount: 3, usesTags: true })).toHaveLength(3);
        expect(texts(null)).toEqual(['fill in missing abstracts and DOIs']);
    });

    it('has no attach step for organizing: /tidy-up finds what to work on', () => {
        const organize = getFeatureCreditTask('organize')!;
        expect(organize.attach).toEqual({ kind: 'none' });
        expect(attachStep(organize.attach, { papers: ['Smith 2020'], collections: [] })).toBeNull();
    });
});

describe('model note', () => {
    it('says nothing on the Beaver model', () => {
        for (const task of FEATURE_CREDIT_TASKS) {
            expect(featureTaskModelNote(task.key, true)).toBeNull();
        }
    });

    it('recommends the Beaver model for most tasks, and requires it for tables', () => {
        for (const key of ['annotate', 'organize', 'literature_review']) {
            expect(featureTaskModelNote(key, false)).toEqual({
                text: 'These tasks work best with the Beaver model.',
                required: false,
            });
        }
        expect(featureTaskModelNote('research_table', false)).toEqual({
            text: 'Tables run on Beaver credits.',
            required: true,
        });
    });
});

describe('completion starter actions', () => {
    it('offers a starter annotation action that stores as a valid action', () => {
        const starter = getFeatureCreditTask('annotate')!.completion.customAction!;
        expect(isStoredAction({ id: 'custom-x', ...starter.template })).toBe(true);
        expect(starter.template.category).toBe('annotate');
    });
});

describe('setup card examples', () => {
    it('shows topic examples for tables as text, not as links that fill the input', () => {
        const table = getFeatureCreditTask('research_table')!;
        expect(table.examples.length).toBeGreaterThan(0);
        expect(table.examples.every((example) => example.illustration)).toBe(true);
    });

    it('offers a literature review in any library as links, and its topic only as text', () => {
        const review = getFeatureCreditTask('literature_review')!;
        expect(review.examples.filter((example) => !example.illustration).map((example) => example.text))
            .toEqual(['a short review of the papers in this collection', 'an outline first']);
        expect(review.examples.filter((example) => example.illustration)).toHaveLength(1);
    });

    it('keeps one-click examples only where they fit any library', () => {
        const linked = FEATURE_CREDIT_TASKS
            .filter((task) => task.key !== 'research_table')
            .flatMap((task) => task.examples.map((example) => example.text));
        expect(linked).not.toContain('what my library says about measurement error');
        expect(linked).not.toContain('every definition of social capital');
    });
});
