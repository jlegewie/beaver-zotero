// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { cloudConsentAtom } from '../../../react/atoms/profile';
import CloudFeaturesBanner from '../../../react/components/preferences/CloudFeaturesBanner';

const { access } = vi.hoisted(() => ({ access: { search: true } }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        cloudConsentAtom: atom('pending'),
        accountGenerationAtom: atom(1),
        hasOcrAccessAtom: atom(false),
        hasSearchIndexAccessAtom: atom(() => access.search),
        cloudProductNameAtom: atom('Beaver Pro'),
        cloudBetaAtom: atom(true),
    };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const previousBeaver = Zotero.Beaver;
afterEach(() => {
    vi.clearAllMocks();
    access.search = true;
    Zotero.Beaver = previousBeaver;
});

async function render(store: ReturnType<typeof createStore>, run: (container: HTMLElement) => Promise<void>) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store }, React.createElement(CloudFeaturesBanner))));
        await run(container);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
}

const buttons = (container: HTMLElement) => Array.from(container.querySelectorAll('button')).map(b => b.textContent);

it('offers both answers while consent is pending and records the choice', async () => {
    const setCloudConsent = vi.fn();
    (Zotero as any).Beaver = { account: { setCloudConsent } };
    const store = createStore();
    await render(store, async container => {
        expect(container.textContent).toContain('Beaver Pro Beta');
        expect(container.textContent).toContain('Full-text search and OCR');
        expect(buttons(container)).toEqual(['Not now', 'Accept and turn on']);
        const accept = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Accept and turn on')!;
        await act(async () => accept.click());
        expect(setCloudConsent).toHaveBeenCalledWith(true, 1);
    });
});

it('keeps only the accept button after the user declined once', async () => {
    const store = createStore();
    store.set(cloudConsentAtom, 'declined');
    await render(store, async container => {
        expect(buttons(container)).toEqual(['Accept and turn on']);
    });
});

it('disappears once consent is accepted or no cloud feature is available', async () => {
    const accepted = createStore();
    accepted.set(cloudConsentAtom, 'accepted');
    await render(accepted, async container => expect(container.textContent).toBe(''));
    access.search = false;
    await render(createStore(), async container => expect(container.textContent).toBe(''));
});
