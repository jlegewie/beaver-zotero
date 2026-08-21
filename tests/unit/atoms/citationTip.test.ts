import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// Mutable state the module mocks below read, so each test can drive the
// suppression conditions without a real profile / pref store.
const mocks = vi.hoisted(() => ({
    firstRunVisible: false,
    tipShownPref: false as unknown,
    popupMessages: [] as unknown[],
}));

const setPrefMock = vi.fn((key: string, value: unknown) => {
    if (key === 'onboardingCitationTipShown') mocks.tipShownPref = value;
});

vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => (key === 'onboardingCitationTipShown' ? mocks.tipShownPref : undefined),
    setPref: (key: string, value: unknown) => setPrefMock(key, value),
}));

vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: unknown) => {
            mocks.popupMessages.push(message);
        }),
    };
});

vi.mock('../../../react/atoms/firstRun', async () => {
    const { atom } = await import('jotai');
    return { isFirstRunVisibleAtom: atom(() => mocks.firstRunVisible) };
});

import { maybeShowCitationTipAtom } from '../../../react/atoms/citationTip';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { Citation } from '@beaver/agent-core/types/citations';
import type { AgentRun } from '@beaver/agent-core/agents/types';

function pageCitation(): Citation {
    return {
        citation_id: 'c1',
        run_id: 'run1',
        resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ITEM' },
        pages: [3],
    };
}

function externalCitation(): Citation {
    return {
        citation_id: 'c2',
        run_id: 'run1',
        citation_type: 'external_reference',
        resolved_ref: { kind: 'external', source: 'openalex', external_id: 'W1' },
    };
}

function firstRunAgentRun(): AgentRun {
    return {
        id: 'run1',
        user_prompt: { origin: { kind: 'first_run_card' } },
    } as unknown as AgentRun;
}

describe('maybeShowCitationTipAtom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.firstRunVisible = false;
        mocks.tipShownPref = false;
        mocks.popupMessages = [];
    });

    it('shows the tip once for a page-locator citation and records the pref', () => {
        const store = createStore();
        store.set(citationsAtom, [pageCitation()]);

        store.set(maybeShowCitationTipAtom);
        store.set(maybeShowCitationTipAtom);

        expect(mocks.popupMessages).toHaveLength(1);
        expect(mocks.popupMessages[0]).toMatchObject({ type: 'citation_tip', expire: false });
        expect(setPrefMock).toHaveBeenCalledTimes(1);
    });

    it('shows the tip for an external citation', () => {
        const store = createStore();
        store.set(citationsAtom, [externalCitation()]);

        store.set(maybeShowCitationTipAtom);

        expect(mocks.popupMessages).toHaveLength(1);
    });

    it('does nothing when no citation is external or page-located', () => {
        const store = createStore();
        store.set(citationsAtom, [{
            citation_id: 'c1',
            run_id: 'run1',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ITEM' },
        }]);

        store.set(maybeShowCitationTipAtom);

        expect(mocks.popupMessages).toHaveLength(0);
        expect(setPrefMock).not.toHaveBeenCalled();
    });

    it('suppresses the tip without setting the pref while the first-run page is visible', () => {
        mocks.firstRunVisible = true;
        const store = createStore();
        store.set(citationsAtom, [pageCitation()]);

        store.set(maybeShowCitationTipAtom);

        expect(mocks.popupMessages).toHaveLength(0);
        expect(setPrefMock).not.toHaveBeenCalled();
    });

    it('suppresses the tip without setting the pref in a first-run thread', () => {
        const store = createStore();
        store.set(citationsAtom, [pageCitation()]);
        store.set(threadRunsAtom, [firstRunAgentRun()]);

        store.set(maybeShowCitationTipAtom);

        expect(mocks.popupMessages).toHaveLength(0);
        expect(setPrefMock).not.toHaveBeenCalled();
    });

    it('does not show the tip again once the pref is set', () => {
        mocks.tipShownPref = true;
        const store = createStore();
        store.set(citationsAtom, [pageCitation()]);

        store.set(maybeShowCitationTipAtom);

        expect(mocks.popupMessages).toHaveLength(0);
        expect(setPrefMock).not.toHaveBeenCalled();
    });
});
