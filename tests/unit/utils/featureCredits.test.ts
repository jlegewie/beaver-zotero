import { isStoredAction } from '@beaver/agent-core/types/actions';
import { describe, expect, it } from 'vitest';
import {
    collectionCandidates,
    combineDocumentStatuses,
    createdHighlights,
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
        expect(combineDocumentStatuses(['scan', 'unreadable'])).toBe('scan');
        expect(combineDocumentStatuses(['scan', 'readable'])).toBe('readable');
    });

    it('does not take a scan, which Beaver can read but not highlight', () => {
        expect(pdfSource(withFiles('scan'))).toEqual({
            state: 'missing',
            text: "Paper 1 is a scan without a text layer, which can't be highlighted. Open a PDF in Zotero, or type @ to find another paper.",
        });
        expect(pdfSource(withFiles('scan', 'scan')).text).toContain('2 papers are scans without a text layer');
        expect(pdfSource(withFiles('readable', 'scan')).text)
            .toBe('2 papers are attached. 1 paper without a readable PDF, EPUB or snapshot is skipped.');
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

    it('lets a task that starts from a topic go without one: Beaver suggests topics', () => {
        for (const key of ['start_project', 'research_table', 'literature_review']) {
            expect(summary(key)).toEqual(['prompt:pending:optional']);
            expect(holding(key)).toBeNull();
            expect(steps(key)[0].text).toContain('send as is and Beaver suggests topics from your library');
            expect(summary(key, { hasInstruction: true })).toEqual(['prompt:done:optional']);
        }
    });

    it('holds Send while a picked example still has its topic placeholder', () => {
        for (const key of ['research_table', 'literature_review']) {
            expect(summary(key, { hasInstruction: true, placeholderLeft: true })).toEqual(['prompt:active']);
            expect(holding(key, { hasInstruction: true, placeholderLeft: true })).toBe('Replace [your topic] with your topic');
            // The placeholder is in the message whatever is attached.
            expect(holding(key, { hasInstruction: true, placeholderLeft: true, collections: ['Thesis'] }))
                .toBe('Replace [your topic] with your topic');
        }
    });

    it('works on an attached collection for a table or review, and says so instead of asking for a topic', () => {
        const [table] = steps('research_table', { collections: ['School choice'] });
        expect(table).toMatchObject({
            status: 'done',
            hideExamples: true,
            text: 'Beaver compares the papers in the “School choice” collection. Say what to ask of each, or send as is.',
        });
        const [review] = steps('literature_review', { collections: ['A', 'B'] });
        expect(review.text).toBe('Beaver reviews the papers in the 2 attached collections. Add a purpose or length if you like, or send as is.');
        // Other tasks do not work on a collection: theirs reads as before.
        for (const key of ['start_project', 'organize']) {
            expect(steps(key, { collections: ['A'] })[0]).toEqual(steps(key)[0]);
        }
    });

    it('requires the Beaver model only for a table, first', () => {
        expect(summary('research_table', { onBeaverModel: false })).toEqual(['model:active', 'prompt:pending:optional']);
        expect(holding('research_table', { onBeaverModel: false, hasInstruction: true })).toBe('Switch to the Beaver model');
        for (const key of ['annotate', 'start_project', 'literature_review', 'organize']) {
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
    it('has the five tasks, each with the action the server checks for', () => {
        expect(Object.fromEntries(FEATURE_CREDIT_TASKS.map((task) => [task.key, task.actionId]))).toEqual({
            annotate: 'builtin-annotate',
            start_project: 'builtin-start-project',
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
    });

    it('points to the table a table task made', () => {
        expect(getFeatureCreditTask('research_table')!.completion.tableTip).toEqual({
            text: 'Click a cell in the table to see the quote behind it.',
            label: 'Open the table',
        });
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
    it('gives the review examples a topic to fill in', () => {
        const texts = examplesForLibrary(getFeatureCreditTask('literature_review')!, null).map((example) => example.text);
        expect(texts.length).toBeGreaterThan(0);
        expect(texts.every((text) => text.includes('[your topic]'))).toBe(true);
    });

    it('gives the table examples a topic to fill in', () => {
        const texts = examplesForLibrary(getFeatureCreditTask('research_table')!, null).map((example) => example.text);
        expect(texts.length).toBeGreaterThan(0);
        expect(texts.every((text) => text.includes('[your topic]'))).toBe(true);
    });

    it('names no real topic, so every example fits any library', () => {
        for (const task of FEATURE_CREDIT_TASKS) {
            for (const example of task.examples) {
                expect(example.text).not.toMatch(/neighborhood|social capital|CRISPR/i);
            }
        }
    });
});

describe('what a finished task hands on', () => {
    const applied = (action_type: string, result_data: Record<string, unknown>) =>
        ({ action_type, status: 'applied', result_data }) as any;
    const sentWith = (...attachments: unknown[]) => [{ user_prompt: { content: '', attachments } }] as any;

    it('reads the collection a project made from its portable id', () => {
        // As the action reaches the client: the portable id in both fields.
        const made = applied('create_collection', { library_id: 1, collection_id: 'u-ABCD1234', collection_key: 'u-ABCD1234' });
        expect(collectionCandidates(sentWith(), [made])).toEqual([{ library_ref: 'u', zotero_key: 'ABCD1234' }]);
        // A bare key belongs to the result's library.
        expect(collectionCandidates(sentWith(), [applied('create_collection', { library_id: 3, collection_key: 'ABCD1234' })]))
            .toEqual([{ library_id: 3, zotero_key: 'ABCD1234' }]);
    });

    it('prefers a collection the answer made, then one it imported into, then one it was sent with', () => {
        const attached = { type: 'collection', library_id: 1, library_ref: 'u', zotero_key: 'SENTWITH', name: 'S', parent_key: null };
        const imported = applied('import_item', { library_id: 1, zotero_key: 'ITEM0001', collection_ids: ['u-IMPORTED'], collection_keys: ['IMPORTED'] });
        const made = applied('create_collection', { library_id: 1, collection_id: 'u-MADE0001' });
        expect(collectionCandidates(sentWith(attached), [imported, made]).map((c) => c.zotero_key))
            .toEqual(['MADE0001', 'IMPORTED', 'SENTWITH']);
    });

    it('offers every collection an import filed a paper in', () => {
        const imported = applied('import_item', { library_id: 1, collection_ids: ['u-FIRST001', 'u-SECOND01'] });
        expect(collectionCandidates(sentWith(), [imported]).map((c) => c.zotero_key)).toEqual(['FIRST001', 'SECOND01']);
    });

    it('ignores changes that were not applied, and other attachments', () => {
        const rejected = { action_type: 'create_collection', status: 'rejected', result_data: { collection_id: 'u-MADE0001' } } as any;
        const pending = { action_type: 'create_collection', status: 'pending' } as any;
        expect(collectionCandidates(sentWith({ type: 'item', library_id: 1, zotero_key: 'ITEM0001' }), [rejected, pending])).toEqual([]);
    });

    it('lists the highlights an answer added in page order', () => {
        const batch = (created: unknown[]) => applied('create_highlight_annotations', { created });
        expect(createdHighlights([
            batch([{ library_id: 1, zotero_key: 'PAGE0009', page_idx: 8 }, { library_id: 1, zotero_key: 'NOPAGE00' }]),
            batch([{ library_id: 1, zotero_key: 'PAGE0003', page_idx: 2 }]),
            applied('edit_annotations', { created: [{ library_id: 1, zotero_key: 'EDITED00', page_idx: 0 }] }),
        ])).toEqual([
            { library_id: 1, zotero_key: 'PAGE0003' },
            { library_id: 1, zotero_key: 'PAGE0009' },
            { library_id: 1, zotero_key: 'NOPAGE00' },
        ]);
    });
});
