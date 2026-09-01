// @vitest-environment jsdom

/**
 * A citation names two things at once: the passage it cites and the work the
 * passage comes from. Holding the platform accelerator switches both the hover
 * preview and the click from the first to the second.
 *
 * The two halves have to agree, and each can break independently: the hover
 * state lives in the shared component while the click is executed by the host,
 * so this drives the real component against a stub host and asserts on both.
 *
 * The component cases derive the chord from the running platform, so the choice
 * of accelerator is pinned by the `hasAlternateModifier` cases instead.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import type { Citation as CitationMetadata } from '@beaver/agent-core/types/citations';
import type { ClientHost } from '@beaver/agent-ui/host';
import { setHost } from '@beaver/agent-ui/host';
import Citation from '@beaver/agent-ui/chat/Citation';
import { hasAlternateModifier } from '@beaver/agent-ui/chat/useAlternateActivation';
import { isMacPlatform } from '@beaver/agent-ui/utils/platform';

// Tells React that `act()` is available, so it doesn't warn on every render.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LIBRARY_ID = 1;
const ITEM_KEY = 'ABCD1234';

/** The accelerator chord as this platform delivers it. */
const ACCEL_DOWN = isMacPlatform(window.navigator) ? { metaKey: true } : { ctrlKey: true };

const macNavigator = { platform: 'MacIntel', userAgent: '' } as Navigator;
const winNavigator = { platform: 'Win32', userAgent: '' } as Navigator;
const NO_MODIFIER = { metaKey: false, ctrlKey: false };

const pageCitation: CitationMetadata = {
    citation_id: 'c1',
    requested_ref: { kind: 'zotero', library_id: LIBRARY_ID, zotero_key: ITEM_KEY, loc: { kind: 'page', value: '12', raw: 'page12' } },
    resolved_ref: { kind: 'zotero', library_id: LIBRARY_ID, zotero_key: ITEM_KEY, loc: { kind: 'page', value: '12', raw: 'page12' } },
    citation_type: 'attachment',
    content_kind: 'pdf',
    display_name: 'Smith, 2024',
    formatted_citation: 'Smith, J. (2024). A study of beavers. Journal of Rodents, 12(3), 1–20.',
    preview: 'Beavers build dams.',
    pages: [12],
    run_id: 'run-1',
} as unknown as CitationMetadata;

let activateCitation: ReturnType<typeof vi.fn>;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLElement {
    const store = createStore();
    store.set(citationsAtom, [pageCitation]);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root?.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(Citation, {
                    'data-library-id': String(LIBRARY_ID),
                    'data-zotero-key': ITEM_KEY,
                    'data-loc': 'page12',
                    'data-loc-kind': 'page',
                    'data-loc-value': '12',
                }),
            ),
        );
    });
    const marker = container.querySelector('.zotero-citation');
    if (!marker) throw new Error('citation marker did not render');
    return marker as HTMLElement;
}

/** Open the hover preview, optionally with the modifier already held. */
function hover(marker: HTMLElement, withModifier = false): void {
    act(() => {
        marker.dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true, ...(withModifier ? ACCEL_DOWN : {}) }),
        );
    });
}

/** Press or release the accelerator on the document the citation lives in. */
function setModifier(held: boolean): void {
    act(() => {
        document.dispatchEvent(
            new KeyboardEvent(held ? 'keydown' : 'keyup', {
                bubbles: true,
                ...(held ? ACCEL_DOWN : {}),
            }),
        );
    });
}

function tooltipText(): string {
    return container?.querySelector('[role="tooltip"]')?.textContent ?? '';
}

beforeEach(() => {
    activateCitation = vi.fn();
    setHost({ navigation: { activateCitation } } as unknown as ClientHost);
});

afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    setHost({});
    vi.clearAllMocks();
});

describe('citation hover preview', () => {
    it('previews the cited passage and its page by default', () => {
        hover(mount());

        expect(tooltipText()).toContain('Beavers build dams.');
        expect(tooltipText()).toContain('Page 12');
        expect(tooltipText()).toContain('Opens PDF on page 12');
    });

    it('swaps to the full reference while the modifier is held', () => {
        const marker = mount();
        hover(marker);

        setModifier(true);

        expect(tooltipText()).toContain('A study of beavers');
        expect(tooltipText()).toContain('Reveals item in library');
        // The passage and its locator describe what the *unmodified* click does.
        expect(tooltipText()).not.toContain('Beavers build dams.');
        expect(tooltipText()).not.toContain('Page 12');
    });

    it('restores the passage preview when the modifier is released', () => {
        const marker = mount();
        hover(marker);

        setModifier(true);
        setModifier(false);

        expect(tooltipText()).toContain('Beavers build dams.');
        expect(tooltipText()).not.toContain('A study of beavers');
    });

    it('shows the item state when the modifier is already held on arrival', () => {
        hover(mount(), true);

        expect(tooltipText()).toContain('Reveals item in library');
    });
});

describe('citation click', () => {
    it('activates the cited passage on a plain click', () => {
        const marker = mount();
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

    it('activates the cited work on a modified click', () => {
        const marker = mount();
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
        const marker = mount();
        act(() => {
            marker.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
