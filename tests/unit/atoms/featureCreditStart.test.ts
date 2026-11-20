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
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => '' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { startFeatureTaskAtom } from '../../../react/atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../../react/atoms/featureCreditRuns';
import {
    automaticMessageCollectionsAtom,
    automaticMessageItemKeysAtom,
    currentMessageCollectionsAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
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

    it("replaces another task's /command left in the chat input", () => {
        const store = createStore();
        store.set(currentMessagePillsAtom, [pill('builtin-annotate'), pill('builtin-summarize')]);
        store.set(startFeatureTaskAtom, { key: 'organize' });
        expect(staged).toEqual([expect.objectContaining({
            actionId: 'builtin-tidy-up',
            replaceActionIds: ['builtin-annotate'],
        })]);
    });

    it('keeps its own /command, and only sets its text when an example is picked', () => {
        const store = createStore();
        store.set(currentMessagePillsAtom, [pill('builtin-tidy-up')]);
        store.set(startFeatureTaskAtom, { key: 'organize' });
        expect(staged).toEqual([]);

        store.set(startFeatureTaskAtom, { key: 'organize', argumentText: 'tag my untagged papers' });
        expect(staged).toEqual([{ actionId: 'builtin-tidy-up', targetWindow: undefined, argumentText: 'tag my untagged papers' }]);
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
