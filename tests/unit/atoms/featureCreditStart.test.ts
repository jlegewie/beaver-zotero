import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const staged = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../react/atoms/actions', async () => {
    const { atom } = await import('jotai');
    return {
        stageActionPillAtom: atom(null, (_get, _set, payload: unknown) => {
            staged.push(payload);
            return true;
        }),
    };
});
const selectedModels = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../react/atoms/models', async () => {
    const { atom } = await import('jotai');
    return {
        beaverDefaultModelAtom: atom({ id: 'beaver-default', allow_app_key: true }),
        isUsingBeaverCreditsAtom: atom(true),
        updateSelectedModelAtom: atom(null, (_get, _set, model: unknown) => {
            selectedModels.push(model);
        }),
    };
});
const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key),
    setPref: (key: string, value: unknown) => prefs.set(key, value),
}));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => '' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { leaveFeatureTaskAtom, startFeatureTaskAtom } from '../../../react/atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../../react/atoms/featureCreditRuns';
import {
    automaticMessageCollectionsAtom,
    automaticMessageItemKeysAtom,
    composerResetTokenAtom,
    currentMessageCollectionsAtom,
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    pendingPillInsertsAtom,
    readerActionContextAtom,
} from '../../../react/atoms/messageComposition';

const pill = (actionId: string) => ({ actionId, commandName: actionId.replace(/^builtin-/, ''), title: actionId });

describe('startFeatureTaskAtom', () => {
    beforeEach(() => {
        staged.length = 0;
        selectedModels.length = 0;
    });

    it('stages the task action and opens its setup card', () => {
        const store = createStore();
        expect(store.set(startFeatureTaskAtom, { key: 'organize' })).toBe(true);
        expect(store.get(activeFeatureTaskAtom)).toBe('organize');
        expect(staged).toEqual([{ actionId: 'builtin-tidy-up', targetWindow: undefined, argumentText: undefined }]);
    });

    it('replaces every other /command in the chat input, so the message runs the task alone', () => {
        const store = createStore();
        store.set(currentMessagePillsAtom, [pill('builtin-annotate'), pill('builtin-summarize'), pill('builtin-annotate')]);
        store.set(startFeatureTaskAtom, { key: 'organize' });
        expect(staged).toEqual([expect.objectContaining({
            actionId: 'builtin-tidy-up',
            replaceActionIds: ['builtin-annotate', 'builtin-summarize'],
        })]);
    });

    it('attaches the collection the task should work on, once', () => {
        const store = createStore();
        const collection = { library_id: 1, zotero_key: 'COLL0001', name: 'School choice', parent_key: null };
        store.set(startFeatureTaskAtom, { key: 'research_table', collection });
        store.set(startFeatureTaskAtom, { key: 'research_table', collection });
        expect(store.get(currentMessageCollectionsAtom)).toEqual([collection]);
    });

    it('keeps its own /command, and only sets its text when an example is picked', () => {
        const store = createStore();
        store.set(currentMessagePillsAtom, [pill('builtin-tidy-up')]);
        store.set(startFeatureTaskAtom, { key: 'organize' });
        expect(staged).toEqual([]);

        store.set(startFeatureTaskAtom, { key: 'organize', argumentText: 'tag my untagged papers' });
        expect(staged).toEqual([{ actionId: 'builtin-tidy-up', targetWindow: undefined, argumentText: 'tag my untagged papers' }]);
    });

    it("has a picked example's topic placeholder selected, so typing replaces it", () => {
        const store = createStore();
        store.set(startFeatureTaskAtom, {
            key: 'literature_review',
            argumentText: 'Background on [your topic] for a grant proposal',
        });
        expect(staged).toEqual([expect.objectContaining({
            actionId: 'builtin-collection-literature-review',
            argumentText: 'Background on [your topic] for a grant proposal',
            selectText: '[your topic]',
        })]);
    });

    it('does nothing for a task this client does not know', () => {
        const store = createStore();
        expect(store.set(startFeatureTaskAtom, { key: 'unknown' })).toBe(false);
        expect(staged).toEqual([]);
        expect(store.get(activeFeatureTaskAtom)).toBeNull();
    });

    it('switches to the Beaver model when a task starts, not when an example is picked', () => {
        const store = createStore();
        store.set(startFeatureTaskAtom, { key: 'annotate' });
        expect(selectedModels).toEqual([{ id: 'beaver-default', allow_app_key: true, access_mode: 'app_key' }]);
        store.set(startFeatureTaskAtom, { key: 'annotate', argumentText: 'Highlight key passages' });
        expect(selectedModels).toHaveLength(1);
    });

    describe('attachments taken from the Zotero selection', () => {
        const item = (key: string) => ({ key, libraryID: 1, id: key.length }) as unknown as Zotero.Item;
        const collection = (key: string) => ({ zotero_key: key, library_id: 1, name: key, parent_key: null });

        const withSelection = () => {
            const store = createStore();
            const selected = item('SELECTED');
            const added = item('ADDED');
            store.set(currentMessageItemsAtom, [selected, added]);
            store.set(automaticMessageItemKeysAtom, new Set(['1-SELECTED']));
            const automatic = [collection('BROWSED')];
            store.set(currentMessageCollectionsAtom, [...automatic, collection('PICKED')]);
            store.set(automaticMessageCollectionsAtom, automatic);
            return store;
        };

        it('are removed when a task that finds its papers starts; those the user added stay', () => {
            for (const key of ['research_table', 'literature_review', 'organize']) {
                const store = withSelection();
                store.set(startFeatureTaskAtom, { key });
                expect(store.get(currentMessageItemsAtom).map((i) => i.key)).toEqual(['ADDED']);
                expect(store.get(currentMessageCollectionsAtom).map((c) => c.zotero_key)).toEqual(['PICKED']);
                expect(store.get(automaticMessageCollectionsAtom)).toEqual([]);
            }
        });

        it('stay for annotating, where a selected paper is the input', () => {
            const store = withSelection();
            store.set(startFeatureTaskAtom, { key: 'annotate' });
            expect(store.get(currentMessageItemsAtom).map((i) => i.key)).toEqual(['SELECTED', 'ADDED']);
            expect(store.get(currentMessageCollectionsAtom)).toHaveLength(2);
        });
    });
});

describe('leaveFeatureTaskAtom', () => {
    const colorCode = pill('builtin-color-code');

    function storeWith(content: string, pills: ReturnType<typeof pill>[]) {
        const store = createStore();
        store.set(activeFeatureTaskAtom, 'annotate');
        store.set(currentMessageContentAtom, content);
        store.set(currentMessagePillsAtom, pills);
        return store;
    }

    it("removes the task's /command when nothing else was typed", () => {
        const store = storeWith('/color-code ', [colorCode]);
        store.set(leaveFeatureTaskAtom);
        expect(store.get(activeFeatureTaskAtom)).toBeNull();
        expect(store.get(currentMessageContentAtom)).toBe('');
        expect(store.get(currentMessagePillsAtom)).toEqual([]);
    });

    it('replaces the one-line prompt with the task list for good', () => {
        prefs.clear();
        const store = storeWith('/color-code ', [colorCode]);
        expect(prefs.has('featureCreditsTeaserDone')).toBe(false);
        store.set(leaveFeatureTaskAtom);
        expect(prefs.get('featureCreditsTeaserDone')).toBe(true);
    });

    it('leaves the attachments\' reader context and files being attached alone', () => {
        const store = storeWith('/color-code ', [colorCode]);
        const context = { item: { id: 1 } as Zotero.Item, selection: null };
        store.set(readerActionContextAtom, context);
        const token = store.get(composerResetTokenAtom);
        store.set(leaveFeatureTaskAtom);
        expect(store.get(currentMessagePillsAtom)).toEqual([]);
        expect(store.get(readerActionContextAtom)).toBe(context);
        expect(store.get(composerResetTokenAtom)).toBe(token);
    });

    it('keeps the /command with text the user typed', () => {
        const store = storeWith('/color-code methods ', [colorCode]);
        store.set(leaveFeatureTaskAtom);
        expect(store.get(activeFeatureTaskAtom)).toBeNull();
        expect(store.get(currentMessageContentAtom)).toBe('/color-code methods ');
        expect(store.get(currentMessagePillsAtom)).toEqual([colorCode]);
    });

    it('keeps the message when it holds another /command', () => {
        const summarize = pill('builtin-summarize');
        const store = storeWith('/color-code /summarize ', [colorCode, summarize]);
        store.set(leaveFeatureTaskAtom);
        expect(store.get(currentMessagePillsAtom)).toEqual([colorCode, summarize]);
    });

    it('drops the /command while it waits to be inserted', () => {
        const store = storeWith('', []);
        const other = { descriptor: pill('builtin-summarize') };
        store.set(pendingPillInsertsAtom, [{ descriptor: colorCode }, other]);
        store.set(leaveFeatureTaskAtom);
        expect(store.get(pendingPillInsertsAtom)).toEqual([other]);
    });
});
