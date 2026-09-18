/**
 * When a feature tip is shown, and where.
 */
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => mocks.prefs[key],
    setPref: (key: string, value: unknown) => { mocks.prefs[key] = value; },
}));
vi.mock('../../../react/constants/featureTips', () => ({
    FEATURE_TIPS: {
        'run-status-popup': { id: 'run-status-popup', title: 'T', text: 't', icon: () => null, inPanel: true },
    },
}));

import { dismissFeatureTipAtom, showFeatureTipAtom } from '../../../react/atoms/featureTips';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import { floatingPopupMessagesAtom } from '../../../react/atoms/floatingPopup';
import { getVersionUpdateMessageConfig } from '../../../react/constants/versionUpdateMessages';
import { deferFeatureTips, isFeatureTipDeferred, markFeatureTipShown, readFeatureTipState, writeFeatureTipState } from '../../../react/utils/featureTipPrefs';

let store = createStore();
const inPanel = () => store.get(popupMessagesAtom).map((m) => m.id);
const floating = () => store.get(floatingPopupMessagesAtom).map((m) => m.id);

beforeEach(() => {
    store = createStore();
    mocks.prefs = { featureTips: '{}', versionUpdatePopupShownAt: '', onboardingWelcomeShownAt: '' };
    vi.useRealTimers();
});

describe('showFeatureTipAtom', () => {
    it('postpones the quick prompt release tip for seven days without marking it seen', () => {
        vi.useFakeTimers();
        const now = Date.UTC(2026, 8, 9);
        vi.setSystemTime(now);
        const delays = getVersionUpdateMessageConfig('0.25.0')!.deferFeatureTips!;
        deferFeatureTips(delays, now);
        expect(readFeatureTipState().shown).toEqual({});
        expect(readFeatureTipState().lastShownAt).toBeUndefined();
        expect(isFeatureTipDeferred(readFeatureTipState(), 'other', now)).toBe(false);

        // Showing another tip must preserve the pending deferral.
        writeFeatureTipState(markFeatureTipShown(readFeatureTipState(), 'other', now));
        const until = now + 7 * 24 * 60 * 60 * 1000;
        vi.setSystemTime(until - 1);
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(false);
        expect(inPanel()).toEqual([]);
        expect(readFeatureTipState().shown['run-status-popup']).toBeUndefined();

        vi.setSystemTime(until);
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(true);
    });

    it('preserves longer deferrals and allows previews without consuming them', () => {
        const now = Date.now();
        deferFeatureTips({ 'run-status-popup': 100_000 }, now);
        deferFeatureTips({ 'run-status-popup': 1_000 }, now);
        expect(isFeatureTipDeferred(readFeatureTipState(), 'run-status-popup', now + 50_000)).toBe(true);
        expect(store.set(showFeatureTipAtom, 'run-status-popup', { force: true })).toBe(true);
        expect(readFeatureTipState().shown).toEqual({});
    });

    it('shows the tip where its definition says, once, and records it', () => {
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(true);
        expect(inPanel()).toEqual(['feature-tip:run-status-popup']);
        expect(floating()).toEqual([]);
        expect(JSON.parse(mocks.prefs.featureTips as string).shown['run-status-popup']).toEqual(expect.any(String));

        store.set(dismissFeatureTipAtom, 'run-status-popup');
        expect(inPanel()).toEqual([]);
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(false);
    });

    it('waits while another popup is up', () => {
        store.set(floatingPopupMessagesAtom, [{ id: 'version', type: 'version_update' } as any]);
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(false);
        expect(mocks.prefs.featureTips).toBe('{}');
    });

    it('keeps its distance from the release notes and other tips', () => {
        mocks.prefs.versionUpdatePopupShownAt = new Date(Date.now() - 60_000).toISOString();
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(false);

        mocks.prefs.versionUpdatePopupShownAt = '';
        mocks.prefs.featureTips = JSON.stringify({ shown: { other: 'x' }, lastShownAt: new Date(Date.now() - 60_000).toISOString() });
        expect(store.set(showFeatureTipAtom, 'run-status-popup')).toBe(false);
    });

    it('can be forced anywhere for a preview without being recorded', () => {
        mocks.prefs.featureTips = JSON.stringify({ shown: { 'run-status-popup': 'x' } });
        expect(store.set(showFeatureTipAtom, 'run-status-popup', { force: true, inPanel: false })).toBe(true);
        expect(floating()).toEqual(['feature-tip:run-status-popup']);
        expect(JSON.parse(mocks.prefs.featureTips as string).lastShownAt).toBeUndefined();
    });
});
