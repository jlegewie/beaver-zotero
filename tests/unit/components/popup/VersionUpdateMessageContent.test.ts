// @vitest-environment jsdom

/**
 * Where a release note's showcase is drawn, in each of the note's layouts.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
vi.mock('../../../../react/constants/versionShowcases', async () => {
    const React = await import('react');
    const Stub: React.FC = () => React.createElement('div', { 'data-showcase': 'quick-prompt' }, 'showcase');
    return { getVersionShowcase: (id?: string) => (id === 'quick-prompt' ? Stub : undefined) };
});

import VersionUpdateMessageContent from '../../../../react/components/ui/popup/VersionUpdateMessageContent';
import type { PopupMessage } from '../../../../react/types/popupMessage';

let root: Root | null = null;
let container: HTMLDivElement;

function render(message: Partial<PopupMessage>, isFloating = false) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(VersionUpdateMessageContent, {
            message: { id: 'm', type: 'version_update', version: '0.25.0', ...message } as PopupMessage,
            onDismiss: () => {},
            isFloating,
        }));
    });
}

const showcases = () => container.querySelectorAll('[data-showcase]').length;
/** What comes before and after the showcase, in document order. */
const order = () => Array.from(container.querySelectorAll('[data-showcase], [data-order]')).map((el) => el.textContent);

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).Zotero = { launchURL: vi.fn() };
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    delete (globalThis as any).Zotero;
});

describe('VersionUpdateMessageContent', () => {
    it('draws the showcase under the intro of a floating note, above its feature list', () => {
        render({ title: 'T', text: 'Intro', featureList: [{ title: 'Feature' }], showcase: 'quick-prompt' }, true);
        expect(showcases()).toBe(1);
        const text = container.textContent ?? '';
        expect(text.indexOf('Intro')).toBeLessThan(text.indexOf('showcase'));
        expect(text.indexOf('showcase')).toBeLessThan(text.indexOf('Feature'));
    });

    it('draws it in an in-panel note, with or without text beside it', () => {
        render({ text: 'Intro', showcase: 'quick-prompt' });
        expect(showcases()).toBe(1);
        act(() => { root?.unmount(); });
        container.remove();

        render({ showcase: 'quick-prompt' });
        expect(showcases()).toBe(1);
    });

    it('draws a step tour\'s showcases: the note\'s above the tour, a step\'s inside its step', () => {
        render({
            subtitle: 'Sub',
            showcase: 'quick-prompt',
            steps: [{ title: 'One', showcase: 'quick-prompt' }, { title: 'Two' }],
        });
        expect(showcases()).toBe(2);

        act(() => { container.querySelector<HTMLButtonElement>('.step-indicator-dot:nth-child(2)')?.click(); });
        expect(container.textContent).toContain('Two');
        expect(showcases()).toBe(1);
    });

    it('draws nothing extra for a note without one', () => {
        render({ title: 'T', text: 'Intro' }, true);
        expect(showcases()).toBe(0);
        expect(order()).toEqual([]);
    });
});
