// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { expect, it, vi } from 'vitest';
import AdvancedSection from '../../../react/components/preferences/AdvancedSection';

// The moved rows are stubbed with markers; this suite checks where they land.
vi.mock('../../../react/components/preferences/LocalDocumentCacheRow', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-row': 'local-document-cache' }) };
});
vi.mock('../../../react/components/preferences/RebuildSearchIndexRow', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-row': 'rebuild-search-index' }) };
});
vi.mock('../../../react/components/preferences/CustomInstructionsSection', () => ({ default: () => null }));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => globalThis.window }));
vi.mock('../../../react/hooks/useMcpServer', () => ({ ensureMcpBridgeScript: vi.fn() }));
vi.mock('../../../react/utils/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../src/services/externalFiles', () => ({
    deleteAllExternalFiles: vi.fn(),
    getExternalFilesStats: vi.fn(async () => ({ count: 0, totalBytes: 0 })),
    revealExternalFilesDir: vi.fn(),
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { isMcpServerSupportedAtom: atom(false) };
});
vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(), setPref: vi.fn() }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('places the document cache under Storage beside External Files and the index rebuild under Troubleshooting', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store: createStore() }, React.createElement(AdvancedSection))));
        const cacheRow = container.querySelector('[data-row="local-document-cache"]');
        const rebuildRow = container.querySelector('[data-row="rebuild-search-index"]');
        expect(cacheRow).not.toBeNull();
        expect(rebuildRow).not.toBeNull();
        // Same card as External Files, so it reads as one Storage group.
        const storageGroup = cacheRow!.parentElement!;
        expect(storageGroup.textContent).toContain('External Files');
        const headings = Array.from(container.querySelectorAll('div')).filter((node) => node.classList.contains('font-bold'))
            .map((node) => node.textContent);
        expect(headings).toContain('Storage');
        expect(headings).toContain('Troubleshooting');
        const troubleshooting = Array.from(container.querySelectorAll('div')).find((node) => node.textContent === 'Troubleshooting')!;
        expect(troubleshooting.compareDocumentPosition(rebuildRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(rebuildRow!.parentElement!.textContent).not.toContain('External Files');
    } finally {
        act(() => root.unmount());
    }
});
