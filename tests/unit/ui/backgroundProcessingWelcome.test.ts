// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { expect, it, vi } from 'vitest';
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { accountGenerationAtom: atom(1), cloudConsentAtom: atom('pending'),
        hasOcrAccessAtom: atom(true), hasSearchIndexAccessAtom: atom(false), indexingPlanLabelAtom: atom('pro') };
});
vi.mock('../../../react/components/ui/popup/BackgroundProcessingWelcomeContent', () => ({ default: () => null }));
import { cloudConsentAtom } from '../../../react/atoms/profile';
import { floatingPopupMessagesAtom } from '../../../react/atoms/floatingPopup';
import { useBackgroundProcessingWelcome } from '../../../react/hooks/useBackgroundProcessingWelcome';
function Consumer() { useBackgroundProcessingWelcome(); return null; }
it.each([false, true])('removes stale consent on acceptance, including an already accepted mount=%s', async (acceptedAtMount) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const prior = Zotero.Beaver;
    (Zotero as any).Beaver = { background: { claimNotification: vi.fn(() => true) } };
    const store = createStore();
    store.set(floatingPopupMessagesAtom, [{ id: 'background-processing-welcome', type: 'info', title: 'Consent' }]);
    if (acceptedAtMount) store.set(cloudConsentAtom, 'accepted');
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(Consumer))));
        if (!acceptedAtMount) {
            expect(store.get(floatingPopupMessagesAtom)).toHaveLength(1);
            await act(async () => store.set(cloudConsentAtom, 'accepted'));
        }
        expect(store.get(floatingPopupMessagesAtom)).toEqual([]);
    } finally {
        act(() => root.unmount());
        Zotero.Beaver = prior;
    }
});
