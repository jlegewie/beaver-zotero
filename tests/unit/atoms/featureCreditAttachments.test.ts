import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

vi.mock('../../../react/atoms/actions', () => ({ stageActionPillAtom: atom(null, () => true) }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: (item: { key: string }) => item.key }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: (item: { kind?: string }) => item.kind ?? null,
    getContentKind: (item: { kind?: string }) => item.kind ?? 'other',
}));

import { featureTaskAttachedPapersAtom, featureTaskSendBlockAtom } from '../../../react/atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../../react/atoms/featureCreditRuns';
import {
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

    const summarize = (setup: (store: ReturnType<typeof createStore>) => void) => {
        const store = createStore();
        setup(store);
        return store.get(featureTaskAttachedPapersAtom);
    };

    it('rates a paper with no PDF, EPUB or snapshot as having none', () => {
        items.set(1, attachment('NOTEFILE', 'text'));
        expect(summarize((store) => store.set(currentMessageItemsAtom, [paper('P1', [1])] as any)))
            .toEqual([{ name: 'P1', document: 'none' }]);
        expect(summarize((store) => store.set(currentMessageItemsAtom, [paper('P2')] as any)))
            .toEqual([{ name: 'P2', document: 'none' }]);
    });

    it('waits for the readability check of a paper\'s PDF', () => {
        items.set(1, attachment('PDF1', 'pdf'));
        expect(summarize((store) => store.set(currentMessageItemsAtom, [paper('P1', [1])] as any))[0].document).toBe('checking');
        expect(summarize((store) => {
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        })[0].document).toBe('readable');
        expect(summarize((store) => {
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('unreadable')]]));
        })[0].document).toBe('unreadable');
    });

    it('counts the open reader file once under its paper', () => {
        const parent = paper('P1', [1]);
        const pdf = attachment('PDF1', 'pdf', parent);
        items.set(1, pdf);
        expect(summarize((store) => {
            store.set(currentMessageItemsAtom, [parent] as any);
            store.set(currentReaderAttachmentAtom, pdf as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        })).toEqual([{ name: 'P1', document: 'readable' }]);
    });
});

describe('featureTaskSendBlockAtom', () => {
    const annotatePill = { actionId: 'builtin-annotate', commandName: 'annotate', title: 'Annotate' };

    const setup = (options: { completed?: boolean; pill?: boolean; content?: string } = {}) => {
        const store = createStore();
        store.set(profileProjectionAtom, {
            first_run_completed_at: '2026-11-01T00:00:00Z',
            feature_credits: {
                tasks: [{ key: 'annotate', credits: 5, completed_at: options.completed ? '2026-11-02T00:00:00Z' : null }],
            },
        } as any);
        store.set(activeFeatureTaskAtom, 'annotate');
        store.set(currentMessagePillsAtom, options.pill === false ? [] : [annotatePill] as any);
        store.set(currentMessageContentAtom, options.content ?? '/annotate Color-code the methods');
        return store;
    };

    it("holds Send on the setup card's first open required step", () => {
        expect(setup().get(featureTaskSendBlockAtom)).toEqual({ hint: 'Choose a PDF' });
    });

    it('lifts once every required step is done', () => {
        const store = setup();
        const pdf = attachment('PDF1', 'pdf');
        store.set(currentMessageItemsAtom, [pdf] as any);
        store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        expect(store.get(featureTaskSendBlockAtom)).toBeNull();
        store.set(currentMessageContentAtom, '/annotate Highlight every mention of [your topic]');
        expect(store.get(featureTaskSendBlockAtom)).toBeNull();
        store.set(currentMessageContentAtom, '/annotate ');
        expect(store.get(featureTaskSendBlockAtom)).toEqual({ hint: 'Describe what to highlight' });
    });

    it('keeps the topic step open until a picked example names a topic', () => {
        const store = createStore();
        store.set(profileProjectionAtom, {
            feature_credits: { tasks: [{ key: 'research_table', credits: 5, completed_at: null }] },
        } as any);
        store.set(activeFeatureTaskAtom, 'research_table');
        store.set(currentMessagePillsAtom, [{ actionId: 'builtin-research-table', commandName: 'table', title: 'Table' }] as any);
        store.set(currentMessageContentAtom, '/table Papers on [your topic]: method, sample, and main finding');
        expect(store.get(featureTaskSendBlockAtom)).toEqual({ hint: 'Name a topic and what to compare' });
        store.set(currentMessageContentAtom, '/table Papers on school choice: method, sample, and main finding');
        expect(store.get(featureTaskSendBlockAtom)).toBeNull();
    });

    it('applies only while the message would start the task', () => {
        const noSetup = setup();
        noSetup.set(activeFeatureTaskAtom, null);
        expect(noSetup.get(featureTaskSendBlockAtom)).toBeNull();
        expect(setup({ pill: false, content: 'Color-code the methods' }).get(featureTaskSendBlockAtom)).toBeNull();
        expect(setup({ completed: true }).get(featureTaskSendBlockAtom)).toBeNull();
    });
});
