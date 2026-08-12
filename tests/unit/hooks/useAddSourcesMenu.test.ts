// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAddSourcesMenu, AddSourcesMenuHandle } from '../../../react/hooks/useAddSourcesMenu';

type Hook = ReturnType<typeof useAddSourcesMenu>;

const RECT = { left: 40, top: 200, bottom: 260 } as DOMRect;

/**
 * Renders the hook and exposes its latest return value, plus the editor seams
 * it drives (content mirror, trailing-query delete, focus).
 */
function mount(options?: { goBack?: () => boolean }) {
    const contentRef: React.MutableRefObject<string> = { current: '' };
    const menuRef: React.MutableRefObject<AddSourcesMenuHandle | null> = {
        current: options?.goBack ? { goBack: options.goBack } : null,
    };
    const deleted: number[] = [];
    const focused = { count: 0 };
    const focusedAtEnd = { count: 0 };
    let latest: Hook;

    const Harness: React.FC = () => {
        latest = useAddSourcesMenu({
            verticalPosition: 'above',
            contentRef,
            deleteTrailingQuery: (length) => deleted.push(length),
            focusEditor: () => { focused.count++; },
            focusEditorAtEnd: () => { focusedAtEnd.count++; },
            setMessageContent: (value) => { contentRef.current = value; },
            menuRef,
        });
        return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => { root.render(React.createElement(Harness)); });

    return {
        get hook() { return latest!; },
        contentRef,
        deleted,
        focused,
        focusedAtEnd,
        /** Run an interaction and let React flush the state it produced. */
        run<T>(fn: (hook: Hook) => T): T {
            let result!: T;
            act(() => { result = fn(latest!); });
            return result;
        },
        unmount() {
            act(() => { root.unmount(); });
            container.remove();
        },
    };
}

/** A keydown event shaped like the React synthetic one the hook receives. */
function keyEvent(key: string) {
    const prevented = { value: false };
    const event = {
        key,
        preventDefault: () => { prevented.value = true; },
    } as unknown as React.KeyboardEvent<HTMLElement>;
    return { event, prevented };
}

describe('useAddSourcesMenu', () => {
    let harness: ReturnType<typeof mount>;

    afterEach(() => {
        harness?.unmount();
    });

    describe('opening from a typed @', () => {
        it('opens when the @ starts a word', () => {
            harness = mount();
            expect(harness.run(h => h.handleTrigger('find @', RECT))).toBe(true);
            expect(harness.hook.isOpen).toBe(true);
            expect(harness.hook.query).toBe('');
        });

        it('opens when the @ is the first character', () => {
            harness = mount();
            expect(harness.run(h => h.handleTrigger('@', RECT))).toBe(true);
            expect(harness.hook.isOpen).toBe(true);
        });

        it('leaves an @ inside a word alone', () => {
            harness = mount();
            expect(harness.run(h => h.handleTrigger('joscha@', RECT))).toBe(false);
            expect(harness.hook.isOpen).toBe(false);
        });

        it('keeps the typed @ in the editor content', () => {
            harness = mount();
            harness.run(h => h.handleTrigger('find @', RECT));
            expect(harness.contentRef.current).toBe('find @');
            expect(harness.deleted).toEqual([]);
        });
    });

    describe('typing the query', () => {
        beforeEach(() => {
            harness = mount();
            harness.run(h => h.handleTrigger('find @', RECT));
        });

        it('treats everything after the @ as the query', () => {
            harness.run(h => h.handleChange('find @smith'));
            expect(harness.hook.query).toBe('smith');
            expect(harness.hook.isOpen).toBe(true);
        });

        it('keeps a space that is not the first query character', () => {
            harness.run(h => h.handleChange('find @smith'));
            harness.run(h => h.handleChange('find @smith 2020'));
            expect(harness.hook.query).toBe('smith 2020');
            expect(harness.hook.isOpen).toBe(true);
        });

        it('closes once the @ itself is deleted', () => {
            harness.run(h => h.handleChange('find @smith'));
            harness.run(h => h.handleChange('find '));
            expect(harness.hook.isOpen).toBe(false);
            expect(harness.contentRef.current).toBe('find ');
        });

        it('reports the change as handled while open, and not once closed', () => {
            expect(harness.run(h => h.handleChange('find @s'))).toBe(true);
            expect(harness.run(h => h.handleChange('other text'))).toBe(true);
            expect(harness.run(h => h.handleChange('other text!'))).toBe(false);
        });
    });

    describe('closing', () => {
        beforeEach(() => {
            harness = mount();
            harness.run(h => h.handleTrigger('find @', RECT));
        });

        it('closes on a space typed as the first query character', () => {
            const { event, prevented } = keyEvent(' ');
            expect(harness.run(h => h.handleKeyDown(event))).toBe(true);
            expect(harness.hook.isOpen).toBe(false);
            // The space still types — only the menu goes away.
            expect(prevented.value).toBe(false);
        });

        it('does not close on a space typed later in the query', () => {
            harness.run(h => h.handleChange('find @smith'));
            const { event } = keyEvent(' ');
            expect(harness.run(h => h.handleKeyDown(event))).toBe(false);
            expect(harness.hook.isOpen).toBe(true);
        });

        it('closes on Escape', () => {
            const { event, prevented } = keyEvent('Escape');
            expect(harness.run(h => h.handleKeyDown(event))).toBe(true);
            expect(harness.hook.isOpen).toBe(false);
            expect(prevented.value).toBe(true);
        });

        it('leaves the typed text alone when dismissed', () => {
            harness.run(h => h.handleChange('find @smith'));
            harness.run(h => h.dismiss());
            expect(harness.deleted).toEqual([]);
            expect(harness.contentRef.current).toBe('find @smith');
        });

        it('takes back the @ and the query when something is picked', () => {
            harness.run(h => h.handleChange('find @smith'));
            harness.run(h => h.commit());
            expect(harness.hook.isOpen).toBe(false);
            expect(harness.deleted).toEqual(['@smith'.length]);
        });

        it('refocuses the editor after a pick', async () => {
            harness.run(h => h.commit());
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
            expect(harness.focused.count).toBe(1);
        });

        it('passes navigation keys to the menu without consuming them further', () => {
            for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Tab']) {
                const { event, prevented } = keyEvent(key);
                expect(harness.run(h => h.handleKeyDown(event))).toBe(true);
                expect(prevented.value).toBe(true);
                expect(harness.hook.isOpen).toBe(true);
            }
        });

        it('ignores keys once closed', () => {
            harness.run(h => h.dismiss());
            const { event } = keyEvent('Enter');
            expect(harness.run(h => h.handleKeyDown(event))).toBe(false);
        });
    });

    describe('submenu navigation', () => {
        it('steps back out of a submenu on an empty-query Backspace', () => {
            const goBack = vi.fn(() => true);
            harness = mount({ goBack });
            harness.run(h => h.handleTrigger('@', RECT));
            const { event, prevented } = keyEvent('Backspace');
            expect(harness.run(h => h.handleKeyDown(event))).toBe(true);
            expect(goBack).toHaveBeenCalled();
            expect(prevented.value).toBe(true);
            expect(harness.hook.isOpen).toBe(true);
        });

        it('lets Backspace delete the @ when there is no submenu to leave', () => {
            const goBack = vi.fn(() => false);
            harness = mount({ goBack });
            harness.run(h => h.handleTrigger('@', RECT));
            const { event, prevented } = keyEvent('Backspace');
            expect(harness.run(h => h.handleKeyDown(event))).toBe(false);
            expect(prevented.value).toBe(false);
        });

        it('drops the typed query from the editor when entering a submenu', () => {
            harness = mount();
            harness.run(h => h.handleTrigger('@', RECT));
            harness.run(h => h.handleChange('@lib'));
            harness.run(h => h.resetQuery());
            expect(harness.deleted).toEqual(['lib'.length]);
            expect(harness.hook.query).toBe('');
            expect(harness.hook.isOpen).toBe(true);
        });
    });

    describe('opening from the "+" button', () => {
        it('hands focus to the editor, caret at the end, so the menu can be typed into', async () => {
            harness = mount();
            harness.contentRef.current = 'draft text ';
            harness.run(h => h.openFromButton({ x: 0, y: 0 }));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
            expect(harness.focusedAtEnd.count).toBe(1);
        });

        it('anchors the query to the content as it stood, with no @ to take back', () => {
            harness = mount();
            harness.contentRef.current = 'draft text ';
            harness.run(h => h.openFromButton({ x: 10, y: 20 }));
            expect(harness.hook.isOpen).toBe(true);
            expect(harness.hook.position).toEqual({ x: 10, y: 20 });

            harness.run(h => h.handleChange('draft text smith'));
            expect(harness.hook.query).toBe('smith');

            harness.run(h => h.commit());
            expect(harness.deleted).toEqual(['smith'.length]);
        });

        it('deletes nothing when picked before anything was typed', () => {
            harness = mount();
            harness.run(h => h.openFromButton({ x: 0, y: 0 }));
            harness.run(h => h.commit());
            expect(harness.deleted).toEqual([]);
        });
    });
});
