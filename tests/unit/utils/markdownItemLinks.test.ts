// @vitest-environment jsdom

/**
 * Zotero object links in the rendered chat body: `[Smith 2004](u-KEY)` renders
 * as an anchor that reveals the object through the host on click, while every
 * other link keeps its behavior. Export renders carry a working
 * `zotero://select` href instead.
 */
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/chat/Citation', () => ({
    default: () => null,
}));

vi.mock('../../../react/components/messages/NoteDisplay', () => ({
    default: () => null,
}));

import { setHost } from '@beaver/agent-ui/host';
import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';

const navigation = {
    revealObject: vi.fn(),
    revealCollection: vi.fn(),
    openExternalUrl: vi.fn(),
};

function staticHtml(content: string, exportRendering = false): string {
    return renderToStaticMarkup(React.createElement(MarkdownRenderer, { content, exportRendering }));
}

describe('MarkdownRenderer item links', () => {
    let root: ReturnType<typeof createRoot> | null = null;
    let container: HTMLDivElement | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        setHost({ navigation: navigation as any });
    });

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        setHost({});
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    /** Mount `content` and click the first anchor. */
    function clickFirstLink(content: string): HTMLAnchorElement {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root?.render(React.createElement(MarkdownRenderer, { content }));
        });
        const anchor = container.querySelector('a');
        expect(anchor).not.toBeNull();
        act(() => {
            anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        return anchor!;
    }

    it('renders an object id link as an anchor that says what it does', () => {
        const html = staticHtml('See [Smith 2004](u-ANVV522N).');
        expect(html).toContain('<a href="u-ANVV522N" title="Show in Zotero">Smith 2004</a>');
    });

    it('reveals the object through the host on click', () => {
        clickFirstLink('See [Smith 2004](g42-ANVV522N).');
        expect(navigation.revealObject).toHaveBeenCalledTimes(1);
        expect(navigation.revealObject).toHaveBeenCalledWith(
            expect.objectContaining({ library_ref: 'g42', zotero_key: 'ANVV522N' }),
        );
        expect(navigation.openExternalUrl).not.toHaveBeenCalled();
    });

    it('reveals a collection when the link says it is one', () => {
        clickFirstLink('Filed under [Methods](zotero://select/library/collections/ANVV522N).');
        expect(navigation.revealCollection).toHaveBeenCalledWith(
            expect.objectContaining({ library_ref: 'u', zotero_key: 'ANVV522N' }),
        );
        expect(navigation.revealObject).not.toHaveBeenCalled();
    });

    it('still opens ordinary links through the host', () => {
        clickFirstLink('See [the docs](https://example.org/u-ANVV522N).');
        expect(navigation.openExternalUrl).toHaveBeenCalledWith('https://example.org/u-ANVV522N');
        expect(navigation.revealObject).not.toHaveBeenCalled();
    });

    it('writes a zotero://select href when rendering for note export', () => {
        const html = staticHtml('See [Smith 2004](u-ANVV522N).', true);
        expect(html).toContain('href="zotero://select/library/items/ANVV522N"');
        expect(html).not.toContain('title="Show in Zotero"');
    });
});
