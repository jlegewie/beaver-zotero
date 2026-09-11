// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import ProcessingIssueGroupRow from '../../../react/components/preferences/ProcessingIssueList';

// The expanded page resolves items through Zotero; the header is what these tests cover.
vi.mock('../../../react/compat/legacyToolResults', () => ({ hydrateItemListRows: vi.fn(async () => []) }));
vi.mock('../../../react/components/agentRuns/toolResultViews/ItemListResultView', async () => {
    const React = await import('react');
    return { default: () => React.createElement('div', { 'data-item-list': true }) };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

async function render(props: Partial<React.ComponentProps<typeof ProcessingIssueGroupRow>>, check: (container: HTMLDivElement) => Promise<void> | void) {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Provider, { store: createStore() }, React.createElement(ProcessingIssueGroupRow, {
            group: { reason: 'scanned', count: 3 },
            hasOcrAccess: false,
            hasSearchAccess: false,
            updatedAt: Date.now(),
            ...props,
        }))));
        await check(container);
    } finally {
        act(() => root.unmount());
    }
}
const buttonLabels = (container: HTMLElement) => Array.from(container.querySelectorAll('button')).map((node) => node.textContent?.trim());

it('marks scans without OCR access with a passive badge rather than a disabled action', async () => {
    await render({}, (container) => {
        expect(container.textContent).toContain('Scanned files without a text layer');
        expect(container.textContent).toContain('Coming soon');
        expect(buttonLabels(container)).not.toContain('Coming soon');
        expect(buttonLabels(container)).not.toContain('Supported soon');
        expect(buttonLabels(container)).not.toContain('Retry all');
    });
});

it('drops the badge once the account has OCR access', async () => {
    await render({ hasOcrAccess: true }, (container) => {
        expect(container.textContent).toContain('These files contain only images of text.');
        expect(container.textContent).not.toContain('Coming soon');
    });
});

it('offers Retry all only for retryable reasons and routes it to the group', async () => {
    const onRetry = vi.fn(async () => undefined);
    await render({ group: { reason: 'file_unavailable', count: 2 }, onRetry }, async (container) => {
        const retry = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === 'Retry all')!;
        expect(retry).toBeDefined();
        await act(async () => retry.click());
        expect(onRetry).toHaveBeenCalledWith('file_unavailable', null);
    });
    await render({ group: { reason: 'encrypted', count: 1 }, onRetry }, (container) => {
        expect(buttonLabels(container)).not.toContain('Retry all');
    });
});
