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
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => '' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { startFeatureTaskAtom } from '../../../react/atoms/featureCredits';
import { activeFeatureTaskAtom } from '../../../react/atoms/featureCreditRuns';
import { currentMessagePillsAtom } from '../../../react/atoms/messageComposition';

const pill = (actionId: string) => ({ actionId, commandName: actionId.replace(/^builtin-/, ''), title: actionId });

describe('startFeatureTaskAtom', () => {
    beforeEach(() => {
        staged.length = 0;
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
});
