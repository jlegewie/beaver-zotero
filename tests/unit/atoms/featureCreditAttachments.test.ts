import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

vi.mock('../../../react/atoms/actions', () => ({ stageActionPillAtom: atom(null, () => true) }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: (item: { key: string }) => item.key }));
vi.mock('../../../src/services/artifacts/tableItemIdentity', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isTableAttachment: (item: { isTable?: boolean } | null | undefined) => !!item?.isTable,
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: (item: { kind?: string }) => item.kind ?? null,
    getContentKind: (item: { kind?: string }) => item.kind ?? 'other',
}));

import { featureTaskAttachedPapersAtom, featureTaskSendBlockAtom, featureTaskSetupStepsAtom, lookUpOcrPreparedPdfsAtom } from '../../../react/atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../../react/atoms/featureCreditRuns';
import {
    composerSourceSearchTextAtom,
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    currentReaderAttachmentAtom,
} from '../../../react/atoms/messageComposition';
import { profileProjectionAtom } from '../../../react/atoms/profile';
import { itemValidationResultsAtom, type ItemValidationState } from '../../../react/atoms/itemValidation';

type FakeItem = Record<string, unknown>;

function attachment(key: string, kind: string | null, parent?: FakeItem): FakeItem {
    return {
        key,
        libraryID: 1,
        kind,
        parentItem: parent,
        isAttachment: () => true,
        isAnnotation: () => false,
        isRegularItem: () => false,
    };
}

function paper(key: string, childIDs: number[] = []): FakeItem {
    return {
        key,
        libraryID: 1,
        isAttachment: () => false,
        isAnnotation: () => false,
        isRegularItem: () => true,
        getAttachments: () => childIDs,
    };
}

const checked = (state: 'readable' | 'unreadable', contentKind = 'pdf'): ItemValidationState =>
    ({ state, contentKind, isValidating: false } as ItemValidationState);

describe('setup card: whether attached papers have a file to annotate', () => {
    let items: Map<number, FakeItem>;

    beforeEach(() => {
        items = new Map();
        (Zotero as any).Items = { get: vi.fn((id: number) => items.get(id) ?? false) };
    });

    // With the lookup of where each readable PDF's text comes from, as the
    // setup card runs it.
    const summarize = async (setup: (store: ReturnType<typeof createStore>) => void) => {
        const store = createStore();
        setup(store);
        await store.set(lookUpOcrPreparedPdfsAtom);
        return store.get(featureTaskAttachedPapersAtom);
    };

    it('rates a paper with no PDF, EPUB or snapshot as having none', async () => {
        items.set(1, attachment('NOTEFILE', 'text'));
        expect(await summarize((store) => store.set(currentMessageItemsAtom, [paper('P1', [1])] as any)))
            .toEqual([{ name: 'P1', document: 'none' }]);
        expect(await summarize((store) => store.set(currentMessageItemsAtom, [paper('P2')] as any)))
            .toEqual([{ name: 'P2', document: 'none' }]);
    });

    it('waits for the readability check of a paper\'s PDF', async () => {
        items.set(1, attachment('PDF1', 'pdf'));
        expect((await summarize((store) => store.set(currentMessageItemsAtom, [paper('P1', [1])] as any)))[0].document).toBe('checking');
        expect((await summarize((store) => {
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        }))[0].document).toBe('readable');
        expect((await summarize((store) => {
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('unreadable')]]));
        }))[0].document).toBe('unreadable');
    });

    it('keeps checking a readable PDF until it is known where its text comes from', () => {
        items.set(1, attachment('PDF1', 'pdf'));
        const store = createStore();
        store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
        store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        expect(store.get(featureTaskAttachedPapersAtom)[0].document).toBe('checking');
    });

    describe('a scan, which Beaver can read but not highlight', () => {
        const hasOcrText = vi.fn();
        let beaver: unknown;

        beforeEach(() => {
            hasOcrText.mockReset();
            beaver = (Zotero as any).Beaver;
            (Zotero as any).Beaver = { documentCache: { hasOcrText } };
        });

        afterEach(() => {
            (Zotero as any).Beaver = beaver;
        });

        const lookedUp = async (validation: ItemValidationState) => {
            const pdf = attachment('PDF1', 'pdf');
            items.set(1, pdf);
            const store = createStore();
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', validation]]));
            await store.set(lookUpOcrPreparedPdfsAtom);
            return store;
        };

        it('is told apart once its text turns out to come from OCR', async () => {
            hasOcrText.mockResolvedValue(true);
            const store = await lookedUp(checked('readable'));
            expect(hasOcrText).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'PDF1' });
            expect(store.get(featureTaskAttachedPapersAtom)).toEqual([{ name: 'P1', document: 'scan' }]);
            // Looked up once per file.
            await store.set(lookUpOcrPreparedPdfsAtom);
            expect(hasOcrText).toHaveBeenCalledTimes(1);
        });

        it('leaves a PDF with its own text layer readable', async () => {
            hasOcrText.mockResolvedValue(false);
            expect((await lookedUp(checked('readable'))).get(featureTaskAttachedPapersAtom)[0].document).toBe('readable');
        });

        it('is known without a lookup while it is not prepared yet', async () => {
            const store = await lookedUp({ ...checked('readable'), statusCode: 'pdf_needs_ocr' } as ItemValidationState);
            expect(store.get(featureTaskAttachedPapersAtom)[0].document).toBe('scan');
            expect(hasOcrText).not.toHaveBeenCalled();
        });

        it('does not look up files Beaver cannot read, or that are not PDFs', async () => {
            await lookedUp(checked('unreadable'));
            await lookedUp(checked('readable', 'epub'));
            expect(hasOcrText).not.toHaveBeenCalled();
        });
    });

    it('counts the open reader file once under its paper', async () => {
        const parent = paper('P1', [1]);
        const pdf = attachment('PDF1', 'pdf', parent);
        items.set(1, pdf);
        expect(await summarize((store) => {
            store.set(currentMessageItemsAtom, [parent] as any);
            store.set(currentReaderAttachmentAtom, pdf as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        })).toEqual([{ name: 'P1', document: 'readable' }]);
    });
});

describe('featureTaskSendBlockAtom', () => {
    const colorCodePill = { actionId: 'builtin-color-code', commandName: 'color-code', title: 'Color-code this paper' };

    const setup = (options: { completed?: boolean; pill?: boolean; content?: string } = {}) => {
        const store = createStore();
        store.set(profileProjectionAtom, {
            first_run_completed_at: '2026-11-01T00:00:00Z',
            feature_credits: {
                tasks: [{ key: 'annotate', credits: 5, completed_at: options.completed ? '2026-11-02T00:00:00Z' : null }],
            },
        } as any);
        store.set(activeFeatureTaskAtom, 'annotate');
        store.set(currentMessagePillsAtom, options.pill === false ? [] : [colorCodePill] as any);
        store.set(currentMessageContentAtom, options.content ?? '/color-code ');
        return store;
    };

    it("holds Send on the setup card's first open required step", () => {
        expect(setup().get(featureTaskSendBlockAtom)).toEqual({ hint: 'Choose a PDF' });
    });

    it('lifts once the PDF is attached and checked, with or without an instruction', async () => {
        const store = setup();
        const pdf = attachment('PDF1', 'pdf');
        store.set(currentMessageItemsAtom, [pdf] as any);
        store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        // Readable, but not yet known to have a text layer of its own.
        expect(store.get(featureTaskSendBlockAtom)).toEqual({ hint: 'Checking the PDF…' });
        await store.set(lookUpOcrPreparedPdfsAtom);
        expect(store.get(featureTaskSendBlockAtom)).toBeNull();
        store.set(currentMessageContentAtom, '/color-code Use red for methods');
        expect(store.get(featureTaskSendBlockAtom)).toBeNull();
    });

    it('lets a table or review go without a topic, but not with a picked example left unfilled', () => {
        const cases = [
            { key: 'research_table', actionId: 'builtin-research-table', command: '/table', example: 'Papers on [your topic]: method, sample, and main finding' },
            { key: 'literature_review', actionId: 'builtin-collection-literature-review', command: '/review', example: 'Background on [your topic] for a grant proposal' },
        ];
        for (const { key, actionId, command, example } of cases) {
            const store = createStore();
            store.set(profileProjectionAtom, {
                feature_credits: { tasks: [{ key, credits: 5, completed_at: null }] },
            } as any);
            store.set(activeFeatureTaskAtom, key);
            store.set(currentMessagePillsAtom, [{ actionId, commandName: command.slice(1), title: key }] as any);
            store.set(currentMessageContentAtom, `${command} `);
            expect(store.get(featureTaskSendBlockAtom)).toBeNull();
            store.set(currentMessageContentAtom, `${command} ${example}`);
            expect(store.get(featureTaskSendBlockAtom)).toEqual({ hint: 'Replace [your topic] with your topic' });
            store.set(currentMessageContentAtom, `${command} ${example.replace('[your topic]', 'school choice')}`);
            expect(store.get(featureTaskSendBlockAtom)).toBeNull();
        }
    });

    it('does not take an @ search in progress for an instruction', () => {
        const store = createStore();
        store.set(profileProjectionAtom, {
            feature_credits: { tasks: [{ key: 'literature_review', credits: 5, completed_at: null }] },
        } as any);
        store.set(activeFeatureTaskAtom, 'literature_review');
        store.set(currentMessagePillsAtom, [{ actionId: 'builtin-collection-literature-review', commandName: 'literature-review', title: 'Review' }] as any);
        const promptStatus = () => store.get(featureTaskSetupStepsAtom)!.find((step) => step.key === 'prompt')!.status;
        store.set(currentMessageContentAtom, '/literature-review @smi');
        store.set(composerSourceSearchTextAtom, '@smi');
        expect(promptStatus()).toBe('pending');
        store.set(currentMessageContentAtom, '/literature-review school choice @smi');
        expect(promptStatus()).toBe('done');
        // The menu closed without a pick: the text is the user's.
        store.set(composerSourceSearchTextAtom, null);
        store.set(currentMessageContentAtom, '/literature-review @smi');
        expect(promptStatus()).toBe('done');
        // A bare "@" left behind has no word in it.
        store.set(currentMessageContentAtom, '/literature-review @ ');
        expect(promptStatus()).toBe('pending');
    });

    it('names a table open in its tab, or attached, as what a review works on', () => {
        const store = createStore();
        store.set(profileProjectionAtom, {
            feature_credits: { tasks: [{ key: 'literature_review', credits: 5, completed_at: null }] },
        } as any);
        store.set(activeFeatureTaskAtom, 'literature_review');
        store.set(currentMessagePillsAtom, [{ actionId: 'builtin-collection-literature-review', commandName: 'literature-review', title: 'Review' }] as any);
        store.set(currentMessageContentAtom, '/literature-review ');
        const table = (key: string, title: string) => ({ ...attachment(key, null), isTable: true, getField: () => title });
        const prompt = () => store.get(featureTaskSetupStepsAtom)!.find((step) => step.key === 'prompt')!;

        expect(prompt().text).toContain('send as is and Beaver suggests topics');
        store.set(currentReaderAttachmentAtom, table('TBL1', 'Education & Inequality') as any);
        expect(prompt()).toMatchObject({ status: 'done', hideExamples: true });
        expect(prompt().text).toContain('the papers in the “Education & Inequality” table');
        // The same table attached as well counts once.
        store.set(currentMessageItemsAtom, [table('TBL1', 'Education & Inequality'), attachment('PDF1', 'pdf')] as any);
        expect(prompt().text).toContain('the “Education & Inequality” table');
        store.set(currentMessageItemsAtom, [table('TBL2', 'Second')] as any);
        expect(prompt().text).toContain('the 2 attached tables');
    });

    it('applies only while the message would start the task', () => {
        const noSetup = setup();
        noSetup.set(activeFeatureTaskAtom, null);
        expect(noSetup.get(featureTaskSendBlockAtom)).toBeNull();
        expect(setup({ pill: false, content: 'Color-code this paper' }).get(featureTaskSendBlockAtom)).toBeNull();
        expect(setup({ completed: true }).get(featureTaskSendBlockAtom)).toBeNull();
    });
});
