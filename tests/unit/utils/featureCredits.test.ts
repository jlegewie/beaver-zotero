import { isStoredAction } from '@beaver/agent-core/types/actions';
import { describe, expect, it } from 'vitest';
import {
    attachmentsSetScope,
    combineDocumentStatuses,
    featureTaskModelNote,
    setupSource,
    type AttachmentSummary,
    type DocumentStatus,
} from '../../../react/utils/featureCredits';
import { FEATURE_CREDIT_TASKS, examplesForLibrary, getFeatureCreditTask, promptSection } from '../../../react/constants/featureCreditTasks';
import { ALL_BUILTIN_ACTIONS } from '../../../react/types/builtinActions';

const none: AttachmentSummary = { papers: [], collections: [] };
const papers = (...names: string[]): AttachmentSummary => ({
    papers: names.map((name) => ({ name, document: 'readable' })),
    collections: [],
});
const withFiles = (...documents: DocumentStatus[]): AttachmentSummary => ({
    papers: documents.map((document, index) => ({ name: `Paper ${index + 1}`, document })),
    collections: [],
});
const collection = (name: string, itemCount: number | null): AttachmentSummary => ({ papers: [], collections: [{ name, itemCount }] });

describe('setup card step 1: what Beaver works on', () => {
    it('asks for a PDF to annotate as the missing input', () => {
        expect(setupSource({ kind: 'paper' }, none)).toEqual({
            title: 'Choose a PDF',
            optional: false,
            state: 'missing',
            text: 'Open one in Zotero, type @ to find a paper, or drag one into the prompt.',
        });
    });

    it('names the attached PDF once it is readable', () => {
        expect(setupSource({ kind: 'paper' }, papers('Smith 2020'))).toMatchObject({ state: 'ready', text: 'Smith 2020 is attached.' });
        expect(setupSource({ kind: 'paper' }, papers('A', 'B', 'C'))).toMatchObject({ state: 'ready', text: '3 papers are attached.' });
    });

    it('checks the attached paper has a readable file before taking it', () => {
        expect(setupSource({ kind: 'paper' }, withFiles('checking'))).toMatchObject({ state: 'checking', text: 'Checking Paper 1…' });
        expect(setupSource({ kind: 'paper' }, withFiles('none'))).toMatchObject({
            state: 'missing',
            text: 'Paper 1 has no PDF, EPUB or snapshot. Open a PDF in Zotero, or type @ to find another paper.',
        });
        expect(setupSource({ kind: 'paper' }, withFiles('unreadable')).text)
            .toBe("Beaver can't read the text of Paper 1. Open a PDF in Zotero, or type @ to find another paper.");
    });

    it('is ready once one attached paper is readable, and says how many are skipped', () => {
        expect(setupSource({ kind: 'paper' }, withFiles('readable', 'checking'))).toMatchObject({ state: 'ready', text: '2 papers are attached.' });
        expect(setupSource({ kind: 'paper' }, withFiles('readable', 'none', 'unreadable')).text)
            .toBe('3 papers are attached. 2 papers without a readable PDF, EPUB or snapshot are skipped.');
    });

    it('takes an attached collection as ready: its papers are checked when the run starts', () => {
        expect(setupSource({ kind: 'paper' }, collection('X', 4)).state).toBe('ready');
    });

    it('rates a paper by its best file', () => {
        expect(combineDocumentStatuses([])).toBe('none');
        expect(combineDocumentStatuses(['none', 'unreadable', 'readable'])).toBe('readable');
        expect(combineDocumentStatuses(['unreadable', 'checking'])).toBe('checking');
        expect(combineDocumentStatuses(['none', 'unreadable'])).toBe('unreadable');
    });

    it('lets a review or table go without attachments, on a topic', () => {
        for (const kind of ['collection', 'topic'] as const) {
            expect(setupSource({ kind }, none)).toEqual({
                title: 'Choose papers',
                optional: true,
                state: 'default',
                text: 'Type @ or drag in a collection or papers. Without any, Beaver finds papers on your topic in your library.',
            });
        }
    });

    it('names an attached collection, and a collection and papers attached together', () => {
        expect(setupSource({ kind: 'collection' }, collection('Neighborhood effects', 14)).text)
            .toBe('The Neighborhood effects collection (14 papers) is attached.');
        expect(setupSource({ kind: 'collection' }, { papers: papers('A', 'B').papers, collections: [{ name: 'X', itemCount: 1 }] }).text)
            .toBe('The X collection (1 paper) and 2 papers are attached.');
        expect(setupSource({ kind: 'collection' }, { papers: [], collections: [{ name: 'A', itemCount: 2 }, { name: 'B', itemCount: null }] }).text)
            .toBe('The A collection (2 papers) and the B collection are attached.');
    });

    it('asks for a topic when only one paper is attached to a review or table', () => {
        expect(setupSource({ kind: 'topic' }, papers('A')).text).toBe('A is attached. Name a topic in the next step, and Beaver adds related papers.');
        expect(attachmentsSetScope(papers('A'))).toBe(false);
        expect(attachmentsSetScope(papers('A', 'B'))).toBe(true);
        expect(attachmentsSetScope(collection('X', 3))).toBe(true);
    });

    it('follows the 10-20 paper rule for tables', () => {
        expect(setupSource({ kind: 'topic' }, collection('Big', 300)).text).toContain('Beaver will pick the most relevant papers from it. Remove it to search your whole library.');
        expect(setupSource({ kind: 'topic' }, collection('Mid', 14)).text).toContain('Beaver will use these papers.');
        expect(setupSource({ kind: 'topic' }, papers('A', 'B')).text).toContain('Beaver will add related papers from your library.');
        expect(setupSource({ kind: 'topic' }, collection('Unknown', null)).text).toContain('pick the most relevant');
    });

    it('needs nothing attached to organize', () => {
        expect(setupSource({ kind: 'none' }, papers('Smith 2020'))).toMatchObject({ title: 'Nothing to attach', state: 'ready' });
    });
});

describe('setup card: what Beaver should do', () => {
    it('requires an instruction to annotate', () => {
        expect(promptSection(getFeatureCreditTask('annotate')!.prompt, true).optional).toBe(false);
    });

    it('makes the instruction optional once papers are attached to a review or table', () => {
        for (const key of ['literature_review', 'research_table']) {
            const prompt = getFeatureCreditTask(key)!.prompt;
            expect(promptSection(prompt, false).optional).toBe(false);
            expect(promptSection(prompt, true)).toMatchObject({ optional: true, hint: prompt.hintWhenAttached });
        }
    });

    it('lets organizing run without an instruction', () => {
        expect(promptSection(getFeatureCreditTask('organize')!.prompt, false).optional).toBe(true);
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
        const texts = (shape: Parameters<typeof examplesForLibrary>[1]) => examplesForLibrary(organize, shape, false).map((e) => e.text);
        expect(texts({ collectionCount: 0, usesTags: false })).toEqual(['Fill in missing abstracts and DOIs']);
        expect(texts({ collectionCount: 3, usesTags: true })).toHaveLength(3);
        expect(texts(null)).toEqual(['Fill in missing abstracts and DOIs']);
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
    it('fits review and table examples to whether papers are attached', () => {
        for (const key of ['literature_review', 'research_table']) {
            const task = getFeatureCreditTask(key)!;
            const withPapers = examplesForLibrary(task, null, true).map((example) => example.text);
            const withoutPapers = examplesForLibrary(task, null, false).map((example) => example.text);
            expect(withPapers.length).toBeGreaterThan(0);
            expect(withoutPapers.length).toBeGreaterThan(0);
            expect(withPapers.some((text) => text.includes('[your topic]'))).toBe(false);
            expect(withoutPapers.every((text) => text.includes('[your topic]'))).toBe(true);
        }
    });

    it('names no real topic, so every example fits any library', () => {
        for (const task of FEATURE_CREDIT_TASKS) {
            for (const example of task.examples) {
                expect(example.text).not.toMatch(/neighborhood|social capital/i);
            }
        }
    });
});
