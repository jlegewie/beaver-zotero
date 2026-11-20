import { isStoredAction } from '@beaver/agent-core/types/actions';
import { describe, expect, it } from 'vitest';
import {
    combineDocumentStatuses,
    pdfSource,
    sendHoldHint,
    setupSteps,
    type AttachedPaper,
    type DocumentStatus,
    type SetupInput,
} from '../../../react/utils/featureCredits';
import { FEATURE_CREDIT_TASKS, examplesForLibrary, getFeatureCreditTask } from '../../../react/constants/featureCreditTasks';
import { ALL_BUILTIN_ACTIONS } from '../../../react/types/builtinActions';

const papers = (...names: string[]): AttachedPaper[] => names.map((name) => ({ name, document: 'readable' }));
const withFiles = (...documents: DocumentStatus[]): AttachedPaper[] =>
    documents.map((document, index) => ({ name: `Paper ${index + 1}`, document }));

describe('setup card: the PDF to annotate', () => {
    it('asks for a PDF as the missing input', () => {
        expect(pdfSource([])).toEqual({
            state: 'missing',
            text: 'Open one in Zotero, type @ to find a paper, or drag one into the prompt.',
        });
    });

    it('names the attached PDF once it is readable', () => {
        expect(pdfSource(papers('Smith 2020'))).toEqual({ state: 'ready', text: 'Smith 2020 is attached.' });
        expect(pdfSource(papers('A', 'B', 'C'))).toEqual({ state: 'ready', text: '3 papers are attached.' });
    });

    it('checks the attached paper has a readable file before taking it', () => {
        expect(pdfSource(withFiles('checking'))).toEqual({ state: 'checking', text: 'Checking Paper 1…' });
        expect(pdfSource(withFiles('none'))).toEqual({
            state: 'missing',
            text: 'Paper 1 has no PDF, EPUB or snapshot. Open a PDF in Zotero, or type @ to find another paper.',
        });
        expect(pdfSource(withFiles('unreadable')).text)
            .toBe("Beaver can't read the text of Paper 1. Open a PDF in Zotero, or type @ to find another paper.");
    });

    it('is ready once one attached paper is readable, and says how many are skipped', () => {
        expect(pdfSource(withFiles('readable', 'checking'))).toEqual({ state: 'ready', text: '2 papers are attached.' });
        expect(pdfSource(withFiles('readable', 'none', 'unreadable')).text)
            .toBe('3 papers are attached. 2 papers without a readable PDF, EPUB or snapshot are skipped.');
    });

    it('rates a paper by its best file', () => {
        expect(combineDocumentStatuses([])).toBe('none');
        expect(combineDocumentStatuses(['none', 'unreadable', 'readable'])).toBe('readable');
        expect(combineDocumentStatuses(['unreadable', 'checking'])).toBe('checking');
        expect(combineDocumentStatuses(['none', 'unreadable'])).toBe('unreadable');
    });
});

describe('setup card steps and Send', () => {
    const steps = (key: string, input: Partial<Omit<SetupInput, 'definition'>> = {}) => setupSteps({
        definition: getFeatureCreditTask(key)!,
        papers: [],
        onBeaverModel: true,
        hasInstruction: false,
        ...input,
    });
    const summary = (key: string, input?: Partial<Omit<SetupInput, 'definition'>>) =>
        steps(key, input).map(({ key: step, status, requiredHint }) => `${step}:${status}${requiredHint ? '' : ':optional'}`);
    const holding = (key: string, input?: Partial<Omit<SetupInput, 'definition'>>) => sendHoldHint(steps(key, input));

    it('asks for a PDF, then what to highlight, before an annotation can be sent', () => {
        expect(summary('annotate')).toEqual(['source:active', 'prompt:pending']);
        expect(holding('annotate')).toBe('Choose a PDF');
        expect(holding('annotate', { hasInstruction: true })).toBe('Choose a PDF');
        expect(summary('annotate', { papers: papers('A') })).toEqual(['source:done', 'prompt:active']);
        expect(holding('annotate', { papers: papers('A') })).toBe('Describe what to highlight');
        expect(holding('annotate', { papers: papers('A'), hasInstruction: true })).toBeNull();
    });

    it('holds Send while the attached PDF is still being checked', () => {
        expect(summary('annotate', { papers: withFiles('checking'), hasInstruction: true })).toEqual(['source:checking', 'prompt:done']);
        expect(holding('annotate', { papers: withFiles('checking'), hasInstruction: true })).toBe('Checking the PDF…');
        expect(holding('annotate', { papers: withFiles('unreadable'), hasInstruction: true })).toBe('Choose a PDF');
    });

    it('asks a review or table only for a topic, whatever is attached', () => {
        expect(summary('literature_review')).toEqual(['prompt:active']);
        expect(holding('literature_review')).toBe('Name a topic for the review');
        expect(holding('literature_review', { papers: papers('A', 'B') })).toBe('Name a topic for the review');
        expect(holding('literature_review', { hasInstruction: true })).toBeNull();
        expect(summary('research_table')).toEqual(['prompt:active']);
        expect(holding('research_table')).toBe('Name a topic and what to compare');
        expect(holding('research_table', { hasInstruction: true })).toBeNull();
    });

    it('requires the Beaver model only for a table, first', () => {
        expect(summary('research_table', { onBeaverModel: false })).toEqual(['model:active', 'prompt:pending']);
        expect(holding('research_table', { onBeaverModel: false, hasInstruction: true })).toBe('Switch to the Beaver model');
        for (const key of ['annotate', 'literature_review', 'organize']) {
            expect(summary(key, { onBeaverModel: false })).not.toContain('model:active');
        }
    });

    it('lets organizing go without an instruction', () => {
        expect(summary('organize')).toEqual(['prompt:pending:optional']);
        expect(holding('organize')).toBeNull();
        expect(summary('organize', { hasInstruction: true })).toEqual(['prompt:done:optional']);
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
        expect(texts({ collectionCount: 0, usesTags: false })).toEqual(['Fill in missing abstracts and DOIs']);
        expect(texts({ collectionCount: 3, usesTags: true })).toHaveLength(3);
        expect(texts(null)).toEqual(['Fill in missing abstracts and DOIs']);
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
    it('gives the review and table examples a topic to fill in', () => {
        for (const key of ['literature_review', 'research_table']) {
            const texts = examplesForLibrary(getFeatureCreditTask(key)!, null).map((example) => example.text);
            expect(texts.length).toBeGreaterThan(0);
            expect(texts.every((text) => text.includes('[your topic]'))).toBe(true);
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
