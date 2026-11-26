// @vitest-environment jsdom

/**
 * A citation names two things at once: the passage it cites and the work the
 * passage comes from. Holding the platform accelerator switches the hover
 * preview, the marker style and the click from the first to the second.
 *
 * Those three have to agree, and each can break independently: the held state is
 * document-wide shared state, the preview is rendered by the component, and the
 * click is executed by the host. So this drives the real component against a
 * stub host and asserts on all three.
 *
 * The component cases derive the chord from the running platform, so the choice
 * of accelerator is pinned by the `hasAlternateModifier` cases instead.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { Citation as CitationMetadata } from '@beaver/agent-core/types/citations';
import type { ClientHost } from '@beaver/agent-ui/host';
import { setHost } from '@beaver/agent-ui/host';
import Citation from '@beaver/agent-ui/chat/Citation';
import { HOLD_DELAY_MS, hasAlternateModifier } from '@beaver/agent-ui/chat/useAlternateActivation';
import { isMacPlatform } from '@beaver/agent-ui/utils/platform';

// Tells React that `act()` is available, so it doesn't warn on every render.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LIBRARY_ID = 1;
const ITEM_KEY = 'ABCD1234';
const OTHER_ITEM_KEY = 'EFGH5678';

/** The accelerator as this platform delivers it. */
const IS_MAC = isMacPlatform(window.navigator);
const ACCEL_KEY = IS_MAC ? 'Meta' : 'Control';
const ACCEL_DOWN = IS_MAC ? { metaKey: true } : { ctrlKey: true };

const macNavigator = { platform: 'MacIntel', userAgent: '' } as Navigator;
const winNavigator = { platform: 'Win32', userAgent: '' } as Navigator;
const NO_MODIFIER = { metaKey: false, ctrlKey: false };

/** A citation into a PDF at page 12 — the modifier redirects its click. */
function pageCitation(itemKey: string, citationId: string): CitationMetadata {
    const ref = {
        kind: 'zotero',
        library_id: LIBRARY_ID,
        zotero_key: itemKey,
        loc: { kind: 'page', value: '12', raw: 'page12' },
    };
    return {
        citation_id: citationId,
        requested_ref: ref,
        resolved_ref: ref,
        citation_type: 'attachment',
        content_kind: 'pdf',
        display_name: 'Smith, 2024',
        formatted_citation: 'Smith, J. (2024). A study of beavers. Journal of Rodents, 12(3), 1–20.',
        preview: 'Beavers build dams.',
        pages: [12],
        run_id: 'run-1',
    } as unknown as CitationMetadata;
}

/** A library citation with no locator: an ordinary click already reveals it. */
function locatorlessCitation(): CitationMetadata {
    const ref = { kind: 'zotero', library_id: LIBRARY_ID, zotero_key: ITEM_KEY };
    return {
        citation_id: 'c-plain',
        requested_ref: ref,
        resolved_ref: ref,
        citation_type: 'item',
        display_name: 'Smith, 2024',
        formatted_citation: 'Smith, J. (2024). A study of beavers. Journal of Rodents, 12(3), 1–20.',
        run_id: 'run-1',
    } as unknown as CitationMetadata;
}

let activateCitation: ReturnType<typeof vi.fn>;
// More than one root can be mounted at a time, to exercise citations that share
// a document without sharing a render tree.
let roots: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];

function citationTag(itemKey: string, withLocator = true) {
    return React.createElement(Citation, {
        key: itemKey,
        'data-library-id': String(LIBRARY_ID),
        'data-zotero-key': itemKey,
        ...(withLocator ? { 'data-loc': 'page12', 'data-loc-kind': 'page', 'data-loc-value': '12' } : {}),
    });
}

/** Render the given citations into a new root, and return their markers. */
function mount(
    citations: CitationMetadata[],
    tags: React.ReactNode[],
    setup?: (store: ReturnType<typeof createStore>) => void,
): HTMLElement[] {
    const store = createStore();
    store.set(citationsAtom, citations);
    setup?.(store);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    act(() => {
        root.render(React.createElement(Provider, { store }, ...tags));
    });
    const markers = Array.from(container.querySelectorAll('.zotero-citation')) as HTMLElement[];
    if (markers.length !== tags.length) throw new Error('citation markers did not render');
    return markers;
}

function unmountAll(): void {
    for (const { root, container } of roots) {
        act(() => root.unmount());
        container.remove();
    }
    roots = [];
}

/** Mount the single default citation: one library item, cited at page 12. */
function mountOne(): HTMLElement {
    return mount([pageCitation(ITEM_KEY, 'c1')], [citationTag(ITEM_KEY)])[0];
}

function openPreview(marker: HTMLElement): void {
    act(() => {
        marker.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
}

function tooltipText(): string {
    return document.querySelector('[role="tooltip"]')?.textContent ?? '';
}

function pressModifier(): void {
    act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ACCEL_KEY, bubbles: true, ...ACCEL_DOWN }));
    });
}

function releaseModifier(): void {
    act(() => {
        document.dispatchEvent(new KeyboardEvent('keyup', { key: ACCEL_KEY, bubbles: true }));
    });
}

/** Press the accelerator and hold it past the engage delay. */
function holdModifier(): void {
    pressModifier();
    act(() => {
        vi.advanceTimersByTime(HOLD_DELAY_MS);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    activateCitation = vi.fn();
    setHost({ navigation: { activateCitation } } as unknown as ClientHost);
});

afterEach(() => {
    // The held state is document-wide and outlives an unmount, so clear it.
    releaseModifier();
    unmountAll();
    setHost({});
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('citation hover preview', () => {
    it('previews the cited passage and its page by default', () => {
        openPreview(mountOne());

        expect(tooltipText()).toContain('Beavers build dams.');
        expect(tooltipText()).toContain('Page 12');
        expect(tooltipText()).toContain('Opens PDF on page 12');
    });

    it('swaps to the full reference while the modifier is held', () => {
        openPreview(mountOne());
        holdModifier();

        expect(tooltipText()).toContain('A study of beavers');
        expect(tooltipText()).toContain('Reveals item in library');
        // The passage and its locator describe what the *unmodified* click does.
        expect(tooltipText()).not.toContain('Beavers build dams.');
        expect(tooltipText()).not.toContain('Page 12');
    });

    it('restores the passage preview when the modifier is released', () => {
        openPreview(mountOne());
        holdModifier();
        releaseModifier();

        expect(tooltipText()).toContain('Beavers build dams.');
        expect(tooltipText()).not.toContain('A study of beavers');
    });
});

describe('held-modifier marker styling', () => {
    it('drops the locator style from every citation at once', () => {
        const markers = mount(
            [pageCitation(ITEM_KEY, 'c1'), pageCitation(OTHER_ITEM_KEY, 'c2')],
            [citationTag(ITEM_KEY), citationTag(OTHER_ITEM_KEY)],
        );
        expect(markers.every((m) => m.className.includes('with-locator'))).toBe(true);

        holdModifier();
        expect(markers.some((m) => m.className.includes('with-locator'))).toBe(false);

        releaseModifier();
        expect(markers.every((m) => m.className.includes('with-locator'))).toBe(true);
    });

    // Citations arrive mid-stream, so one can mount into a document that is
    // already tracking a held key. It has to adopt that state, not start plain.
    it('adopts the held state when it mounts while the key is already down', () => {
        mountOne();
        holdModifier();

        const late = mount([pageCitation(OTHER_ITEM_KEY, 'c2')], [citationTag(OTHER_ITEM_KEY)])[0];

        expect(late.className).not.toContain('with-locator');
    });

    // The accelerator is pressed constantly for unrelated shortcuts. Neither a
    // quick tap nor a chord may restyle the transcript.
    it('ignores a tap shorter than the hold delay', () => {
        const marker = mountOne();
        pressModifier();
        act(() => {
            vi.advanceTimersByTime(HOLD_DELAY_MS - 50);
        });
        releaseModifier();
        act(() => {
            vi.advanceTimersByTime(HOLD_DELAY_MS);
        });

        expect(marker.className).toContain('with-locator');
    });

    it('ignores a chord typed with the modifier down', () => {
        const marker = mountOne();
        pressModifier();
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, ...ACCEL_DOWN }));
            vi.advanceTimersByTime(HOLD_DELAY_MS * 4);
        });

        expect(marker.className).toContain('with-locator');
    });
});

describe('an imported web page', () => {
    const WEB_ID = 'web-MJNNMKH4ED';
    const PAGE_URL = 'https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight';

    /**
     * A sentence citation of a web page that has since been imported to the
     * library. It carries no page number, as a search-highlight sentence doesn't.
     */
    function mountImportedPage(webPage: object | null = { url: PAGE_URL, title: 'Obesity and overweight', site: 'who.int', content_type: 'html' }): HTMLElement {
        const citation = {
            citation_id: 'c-web',
            run_id: 'run-1',
            citation_type: 'external_reference',
            // As the backend resolves every web page citation.
            content_kind: 'snapshot',
            requested_ref: { kind: 'external', external_id: WEB_ID },
            resolved_ref: { kind: 'external', external_id: WEB_ID, source: 'exa' },
            display_name: 'who.int, 2026',
            formatted_citation: `who.int. 2026. "Obesity and overweight." ${PAGE_URL}.`,
            locations: [{ part_id: 's3', text: 'In 2024, 1 in 7 people were living with obesity.' }],
            ...(webPage ? { web_page: webPage } : {}),
        } as unknown as CitationMetadata;
        const tag = React.createElement(Citation, {
            'data-external-id': WEB_ID,
            'data-loc': 's3',
            'data-loc-kind': 'sentence',
            'data-loc-value': '3',
        });
        return mount([citation], [tag], (store) => {
            // The thread's page record, when it has one, is the imported item's: never the source.
            store.set(externalReferenceMappingAtom, {
                [WEB_ID]: { source: 'zotero', source_id: WEB_ID, url: 'https://www.who.int/', title: 'WHO' } as unknown as ExternalReference,
            });
            store.set(externalReferenceItemMappingAtom, { [WEB_ID]: { library_id: LIBRARY_ID, zotero_key: ITEM_KEY } });
        })[0];
    }

    // Its click opens the browser, so it keeps the external style; while the
    // modifier turns the click into a reveal, it drops to the plain style.
    it('is external by default and plain while the modifier is held', () => {
        const marker = mountImportedPage();
        expect(marker.className).toContain('external-citation');

        holdModifier();
        expect(marker.className).not.toContain('external-citation');
        expect(marker.className).not.toContain('with-locator');

        releaseModifier();
        expect(marker.className).toContain('external-citation');
    });

    it('opens the page its citation names at the cited sentence on a plain click', () => {
        const openExternalUrl = vi.fn();
        setHost({ navigation: { activateCitation, openExternalUrl } } as unknown as ClientHost);
        const marker = mountImportedPage();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(activateCitation).not.toHaveBeenCalled();
        expect(openExternalUrl).toHaveBeenCalledWith(`${PAGE_URL}#:~:text=In%202024%2C%201%20in%207%20people%20were%20living%20with%20obesity.`);
    });

    it('reveals the imported item on a modified click', () => {
        const marker = mountImportedPage();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true, ...ACCEL_DOWN }));
        });

        expect(activateCitation).toHaveBeenCalledTimes(1);
        expect(activateCitation.mock.calls[0][0]).toMatchObject({ intent: 'item', hasMappedItem: true });
    });

    // A citation that names no page opens nothing, rather than another record of the id.
    it('does nothing on a plain click when the citation names no page', () => {
        const openExternalUrl = vi.fn();
        setHost({ navigation: { activateCitation, openExternalUrl } } as unknown as ClientHost);
        const marker = mountImportedPage(null);
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(activateCitation).not.toHaveBeenCalled();
        expect(openExternalUrl).not.toHaveBeenCalled();
    });

    // The preview shows the site's icon from the citation, and never loads one
    // from a URL, which would contact the site.
    it('shows the site icon the citation carries, and only an inline one', () => {
        const page = { url: PAGE_URL, title: 'Obesity and overweight', site: 'who.int', content_type: 'html', published: '2026-10-07' };
        const icon = 'data:image/webp;base64,UklGRhwAAABXRUJQ';
        openPreview(mountImportedPage({ ...page, icon }));
        expect(document.querySelector('[role="tooltip"] .site-icon-tile img')?.getAttribute('src')).toBe(icon);
        // The site line names the site and the date; the footer says what the click does.
        expect(tooltipText().replace(/\u00a0/g, ' ')).toContain('who.int · Oct 7, 2026');
        expect(tooltipText()).toContain('Highlights passage in browser');

        unmountAll();
        openPreview(mountImportedPage({ ...page, icon: 'https://www.who.int/favicon.ico' }));
        expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
        expect(document.querySelector('[role="tooltip"] img')).toBeNull();
    });
});

describe('citation click', () => {
    it('activates the cited passage on a plain click', () => {
        const marker = mountOne();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(activateCitation).toHaveBeenCalledTimes(1);
        expect(activateCitation.mock.calls[0][0]).toMatchObject({
            intent: 'passage',
            effectiveLibraryID: LIBRARY_ID,
            effectiveItemKey: ITEM_KEY,
        });
    });

    // The click reads the modifier off its own event rather than the held state,
    // so it is correct even before the hold delay has elapsed.
    it('activates the cited work on a modified click', () => {
        const marker = mountOne();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true, ...ACCEL_DOWN }));
        });

        expect(activateCitation).toHaveBeenCalledTimes(1);
        expect(activateCitation.mock.calls[0][0]).toMatchObject({ intent: 'item' });
    });

    // Shift-click extends the text selection around the citation, on mousedown,
    // where the click handler can no longer prevent it. It must stay a plain
    // activation rather than doubling as the alternate one.
    it('ignores Shift, which belongs to the text selection', () => {
        const marker = mountOne();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        });

        expect(activateCitation.mock.calls[0][0]).toMatchObject({ intent: 'passage' });
    });
});

describe('citations the modifier does not apply to', () => {
    // A locator-less item is already revealed in the library by an ordinary
    // click, so the modifier would change neither the click nor the tooltip.
    it('stays inert on a library citation with no locator', () => {
        const marker = mount([locatorlessCitation()], [citationTag(ITEM_KEY, false)])[0];
        openPreview(marker);
        expect(tooltipText()).toContain('Reveals item in library');

        holdModifier();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true, ...ACCEL_DOWN }));
        });

        expect(activateCitation.mock.calls[0][0]).toMatchObject({ intent: 'passage' });
    });
});

describe('hasAlternateModifier', () => {
    it('is Cmd on macOS, where Ctrl-click is the context menu', () => {
        expect(hasAlternateModifier({ metaKey: true, ctrlKey: false }, macNavigator)).toBe(true);
        expect(hasAlternateModifier({ metaKey: false, ctrlKey: true }, macNavigator)).toBe(false);
    });

    it('is Ctrl everywhere else', () => {
        expect(hasAlternateModifier({ metaKey: false, ctrlKey: true }, winNavigator)).toBe(true);
        expect(hasAlternateModifier({ metaKey: true, ctrlKey: false }, winNavigator)).toBe(false);
    });

    it('is not triggered by an unmodified event', () => {
        expect(hasAlternateModifier(NO_MODIFIER, macNavigator)).toBe(false);
        expect(hasAlternateModifier(NO_MODIFIER, winNavigator)).toBe(false);
    });
});
