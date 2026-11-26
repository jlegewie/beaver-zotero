// @vitest-environment jsdom

/**
 * The shared chat link (`@beaver/agent-ui/chat/MarkdownLink`): a small type
 * icon before the link text, decided by what the link opens. Library objects
 * take their kind from the host (`itemData.resolveLinkedObject`); web pages and
 * URLs take a globe. A link the host cannot follow renders as text.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarkdownLink from '@beaver/agent-ui/chat/MarkdownLink';
import { setHost } from '@beaver/agent-ui/host';
import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';

const navigation = {
    revealObject: vi.fn(),
    revealCollection: vi.fn(),
    openExternalUrl: vi.fn(),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let store: ReturnType<typeof createStore>;

async function render(href: string, text = 'Smith 2004'): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(
            React.createElement(Provider, { store }, React.createElement(MarkdownLink, { href }, text)),
        );
    });
    return container;
}

/** The icon's path data, which tells the icons apart. */
function iconPaths(el: HTMLElement): string | null {
    const icon = el.querySelector('.markdown-link-icon svg');
    return icon ? icon.innerHTML : null;
}

describe('MarkdownLink', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        store = createStore();
    });

    afterEach(() => {
        if (root) act(() => root?.unmount());
        container?.remove();
        root = null;
        container = null;
        setHost({});
        delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    });

    it('leads an object link with the icon for the kind the host resolves', async () => {
        const kinds = {
            AAAA2222: { kind: 'item' },
            BBBB2222: { kind: 'attachment', contentKind: 'pdf' },
            CCCC2222: { kind: 'note' },
            DDDD2222: { kind: 'annotation' },
            EEEE2222: { kind: 'collection' },
        } as const;
        const resolveLinkedObject = vi.fn(async (ref: { zotero_key: string }) => kinds[ref.zotero_key as keyof typeof kinds]);
        setHost({ navigation: navigation as any, itemData: { resolveLinkedObject } as any });

        const drawn = new Set<string>();
        for (const key of Object.keys(kinds)) {
            const el = await render(`u-${key}`);
            const paths = iconPaths(el);
            expect(paths).not.toBeNull();
            drawn.add(paths!);
            act(() => root?.unmount());
            container?.remove();
            root = null;
        }
        // One distinct icon per kind.
        expect(drawn.size).toBe(Object.keys(kinds).length);
    });

    it('leads the link with the icon and keeps the label whole', async () => {
        setHost({
            navigation: navigation as any,
            itemData: { resolveLinkedObject: async () => ({ kind: 'note' }) } as any,
        });
        const el = await render('u-FFFF2222', 'Reading notes');
        const anchor = el.querySelector('a')!;
        expect(anchor.firstElementChild?.className).toBe('markdown-link-icon');
        expect(anchor.textContent).toBe('Reading notes');
    });

    it('draws no icon when the host cannot say what the key names', async () => {
        setHost({ navigation: navigation as any, itemData: { resolveLinkedObject: async () => null } as any });
        const el = await render('u-GGGG2222');
        expect(el.querySelector('a')).not.toBeNull();
        expect(el.querySelector('.markdown-link-icon')).toBeNull();
    });

    it('draws a folder for a collection URI without asking the host', async () => {
        const resolveLinkedObject = vi.fn();
        setHost({ navigation: navigation as any, itemData: { resolveLinkedObject } as any });
        const el = await render('zotero://select/library/collections/HHHH2222', 'Methods');
        expect(el.querySelector('.markdown-link-icon')).not.toBeNull();
        expect(resolveLinkedObject).not.toHaveBeenCalled();
    });

    it('renders an object link as text, without asking what it is, when the host cannot reveal objects', async () => {
        const resolveLinkedObject = vi.fn(async () => ({ kind: 'item' }));
        setHost({ navigation: { openExternalUrl: vi.fn() } as any, itemData: { resolveLinkedObject } as any });
        const el = await render('u-JJJJ2222');
        expect(el.querySelector('a')).toBeNull();
        expect(el.querySelector('.markdown-link-icon')).toBeNull();
        expect(el.textContent).toBe('Smith 2004');
        expect(resolveLinkedObject).not.toHaveBeenCalled();
    });

    it('opens a web page id at its recorded URL, with a globe', async () => {
        setHost({ navigation: navigation as any });
        store.set(externalReferenceMappingAtom, {
            'web-MJNNMKH4ED': { source_id: 'web-MJNNMKH4ED', url: 'https://www.who.int/fact' } as any,
        });
        const el = await render('web-MJNNMKH4ED', 'WHO fact sheet');
        const anchor = el.querySelector('a')!;
        expect(anchor.title).toBe('https://www.who.int/fact');
        expect(el.querySelector('.markdown-link-icon')).not.toBeNull();
        act(() => {
            anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(navigation.openExternalUrl).toHaveBeenCalledWith('https://www.who.int/fact');
    });

    it('renders a web page id the conversation has no record of as text', async () => {
        setHost({ navigation: navigation as any });
        const el = await render('web-MJNNMKH4ED', 'WHO fact sheet');
        expect(el.querySelector('a')).toBeNull();
        expect(el.textContent).toBe('WHO fact sheet');
    });

    it('renders a URL as text on a host that cannot open URLs', async () => {
        setHost({});
        const el = await render('https://example.org/page', 'Example');
        expect(el.querySelector('a')).toBeNull();
        expect(el.querySelector('.markdown-link-icon')).toBeNull();
        expect(el.textContent).toBe('Example');
    });

    it('keeps a fragment link (a footnote reference) as an inert anchor', async () => {
        setHost({ navigation: navigation as any });
        const el = await render('#user-content-fn-1', '1');
        const anchor = el.querySelector('a')!;
        expect(anchor).not.toBeNull();
        act(() => {
            anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(navigation.openExternalUrl).not.toHaveBeenCalled();
        expect(el.querySelector('.markdown-link-icon')).toBeNull();
    });

    it('renders a link with an empty destination as text', async () => {
        setHost({ navigation: navigation as any });
        const el = await render('', 'nowhere');
        expect(el.querySelector('a')).toBeNull();
        expect(el.textContent).toBe('nowhere');
    });

    it('gives http(s) links a globe and other links no icon', async () => {
        setHost({ navigation: navigation as any });
        let el = await render('https://example.org/page', 'Example');
        expect(el.querySelector('.markdown-link-icon')).not.toBeNull();
        act(() => root?.unmount());
        container?.remove();
        el = await render('zotero://beaver/thread/abc', 'that chat');
        expect(el.querySelector('a')).not.toBeNull();
        expect(el.querySelector('.markdown-link-icon')).toBeNull();
    });
});
