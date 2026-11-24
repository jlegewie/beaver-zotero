// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { setHost } from '@beaver/agent-ui/host';
import type { ItemListView } from '@beaver/agent-core/run-state/toolResultViews';
import { ItemListResultView } from '../../../react/components/agentRuns/toolResultViews/ItemListResultView';

vi.mock('../../../react/components/icons/icons', () => ({ CSSItemTypeIcon: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

const URL = 'https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight';

it('lists a web page an extract read and opens it at its URL', async () => {
    const openExternalUrl = vi.fn();
    const revealInLibrary = vi.fn();
    setHost({ navigation: { openExternalUrl, revealInLibrary } as any });
    const view: ItemListView = {
        view_type: 'item_list',
        tool_name: 'extract',
        items: [
            { kind: 'web_page', web_id: 'web-MJNNMKH4ED', url: URL, display_name: 'Obesity and overweight', site: 'who.int', status: 'ok' },
            { kind: 'web_page', web_id: 'web-X45SUKGLKI', display_name: 'cdc.gov', site: 'cdc.gov', status: 'error' },
        ],
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(ItemListResultView, { view })));
        expect(container.textContent).toContain('Obesity and overweight');
        expect(container.textContent).toContain('who.int');
        // A page with no title shows its site once.
        expect(container.textContent?.match(/cdc\.gov/g)).toHaveLength(1);

        const [page, failed] = Array.from(container.querySelectorAll<HTMLElement>('[title], .opacity-50'));
        expect(page.getAttribute('title')).toBe(URL);
        act(() => page.click());
        expect(openExternalUrl).toHaveBeenCalledWith(URL);
        expect(revealInLibrary).not.toHaveBeenCalled();

        expect(failed.className).toContain('opacity-50');
        act(() => failed.click());
        expect(openExternalUrl).toHaveBeenCalledTimes(1);
    } finally {
        act(() => root.unmount());
    }
});
