/**
 * The record of which feature tips the user has seen, and the pacing between them.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(), setPref: vi.fn() }));

import {
    FEATURE_TIP_GAP_MS,
    hasSeenFeatureTip,
    isWithinFeatureTipGap,
    markFeatureTipShown,
    parseFeatureTipState,
} from '../../../react/utils/featureTipPrefs';

const T0 = Date.UTC(2026, 8, 6, 12, 0, 0);

describe('parseFeatureTipState', () => {
    it('reads the stored record and shrugs off anything malformed', () => {
        expect(parseFeatureTipState('{}')).toEqual({ shown: {} });
        expect(parseFeatureTipState('')).toEqual({ shown: {} });
        expect(parseFeatureTipState('not json')).toEqual({ shown: {} });
        expect(parseFeatureTipState(undefined)).toEqual({ shown: {} });
        expect(parseFeatureTipState(JSON.stringify({ deferredUntil: { a: '2026-01-01T00:00:00.000Z', b: 5, c: 'bad' } })))
            .toEqual({ shown: {}, deferredUntil: { a: '2026-01-01T00:00:00.000Z' } });
        expect(parseFeatureTipState('{"shown":{"a":"2026-01-01T00:00:00.000Z","b":5},"lastShownAt":"2026-01-01T00:00:00.000Z"}'))
            .toEqual({ shown: { a: '2026-01-01T00:00:00.000Z' }, lastShownAt: '2026-01-01T00:00:00.000Z' });
    });
});

describe('marking and pacing', () => {
    it('remembers a shown tip and dates the gap from it', () => {
        const state = markFeatureTipShown({ shown: {} }, 'run-status-popup', T0);
        expect(hasSeenFeatureTip(state, 'run-status-popup')).toBe(true);
        expect(hasSeenFeatureTip(state, 'other')).toBe(false);
        expect(state.lastShownAt).toBe(new Date(T0).toISOString());

        expect(isWithinFeatureTipGap(state, T0 + FEATURE_TIP_GAP_MS - 1)).toBe(true);
        expect(isWithinFeatureTipGap(state, T0 + FEATURE_TIP_GAP_MS)).toBe(false);
    });

    it('counts other recent popups against the gap too', () => {
        const recent = new Date(T0 - 60_000).toISOString();
        expect(isWithinFeatureTipGap({ shown: {} }, T0, [recent])).toBe(true);
        expect(isWithinFeatureTipGap({ shown: {} }, T0, ['', null, undefined, 'garbage'])).toBe(false);
    });
});
