import { beforeEach, expect, it, vi } from 'vitest';
const prefs = vi.hoisted(() => ({ backgroundProcessingEnabled: false, backgroundProcessingSearchInitialized: false }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: keyof typeof prefs) => prefs[key],
    setPref: (key: keyof typeof prefs, value: boolean) => { prefs[key] = value; },
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { hasSearchIndexAccessAtom: atom(false) };
});
import { initializeSearchProcessing } from '../../../react/hooks/useSearchIndexAccess';
beforeEach(() => { prefs.backgroundProcessingEnabled = false; prefs.backgroundProcessingSearchInitialized = false; });
it('leaves users without search access on just-in-time processing', () => {
    initializeSearchProcessing(false);
    expect(prefs.backgroundProcessingEnabled).toBe(false);
    expect(prefs.backgroundProcessingSearchInitialized).toBe(false);
});
it('enables processing on first search entitlement and preserves a later pause across restart or entitlement refresh', () => {
    initializeSearchProcessing(true);
    expect(prefs.backgroundProcessingEnabled).toBe(true);
    prefs.backgroundProcessingEnabled = false;
    initializeSearchProcessing(true);
    initializeSearchProcessing(false);
    initializeSearchProcessing(true);
    expect(prefs.backgroundProcessingEnabled).toBe(false);
});
