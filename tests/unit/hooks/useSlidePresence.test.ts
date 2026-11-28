// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSlidePresence } from '../../../react/hooks/useSlidePresence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const Slot: React.FC<{ visible: boolean }> = ({ visible }) => {
    const { ref, present, open, onTransitionEnd } = useSlidePresence<HTMLDivElement>(visible);
    if (!present) return null;
    return React.createElement('div', { ref, id: 'slot', 'data-open': open, onTransitionEnd });
};

let container: HTMLDivElement;
let root: Root;

const render = (visible: boolean) => act(() => root.render(React.createElement(Slot, { visible })));
const slot = () => container.querySelector('#slot');
const endTransition = (target: Element) =>
    act(() => { target.dispatchEvent(new Event('transitionend', { bubbles: true })); });

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useSlidePresence', () => {
    it('shows content that is visible on first render already open', () => {
        render(true);
        expect(slot()?.getAttribute('data-open')).toBe('true');
    });

    it('opens content that becomes visible', () => {
        render(false);
        expect(slot()).toBeNull();
        render(true);
        expect(slot()?.getAttribute('data-open')).toBe('true');
    });

    it('keeps content mounted until it has slid out', () => {
        render(true);
        render(false);
        expect(slot()?.getAttribute('data-open')).toBe('false');
        endTransition(slot()!);
        expect(slot()).toBeNull();
    });

    it('ignores transitions that end on the content inside the slot', () => {
        render(true);
        const child = document.createElement('span');
        slot()!.appendChild(child);
        render(false);
        endTransition(child);
        expect(slot()).not.toBeNull();
    });

    it('reopens content that becomes visible again while sliding out', () => {
        render(true);
        render(false);
        render(true);
        expect(slot()?.getAttribute('data-open')).toBe('true');
        endTransition(slot()!);
        expect(slot()).not.toBeNull();
    });
});
