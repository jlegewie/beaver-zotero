/** @vitest-environment jsdom */
/* eslint-disable no-restricted-globals -- jsdom test: `document` is the test DOM, not a Zotero window */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { COMMAND_PRIORITY_EDITOR, COMPOSITION_END_COMMAND } from 'lexical';
import type { LexicalEditor } from 'lexical';
import {
    createImeCompositionTracker,
    registerCompositionEndDeferral,
} from '../../../react/components/input/lexical/imeComposition';

type RootListener = (root: HTMLElement | null, prev: HTMLElement | null) => void;

/**
 * Minimal stand-in for the LexicalEditor surface the tracker uses: a root
 * listener registry (invoked immediately on registration and once more with a
 * null root on unregistration) plus Lexical's own composing flag.
 */
class FakeEditor {
    private rootListeners = new Set<RootListener>();
    private root: HTMLElement | null = null;
    public composing = false;

    isComposing(): boolean {
        return this.composing;
    }

    registerRootListener(listener: RootListener): () => void {
        listener(this.root, null);
        this.rootListeners.add(listener);
        return () => {
            this.rootListeners.delete(listener);
            listener(null, this.root);
        };
    }

    setRootElement(next: HTMLElement | null): void {
        const prev = this.root;
        this.root = next;
        for (const listener of this.rootListeners) listener(next, prev);
    }
}

describe('createImeCompositionTracker', () => {
    let editor: FakeEditor;
    let root: HTMLElement;
    let ime: ReturnType<typeof createImeCompositionTracker>;
    let dispose: (() => void) | null;

    const compositionStart = () => root.dispatchEvent(new Event('compositionstart'));
    const compositionUpdate = () => root.dispatchEvent(new Event('compositionupdate'));
    const compositionEnd = () => root.dispatchEvent(new Event('compositionend'));

    beforeEach(() => {
        vi.useFakeTimers();
        editor = new FakeEditor();
        root = document.createElement('div');
        document.body.appendChild(root);
        editor.setRootElement(root);
        ime = createImeCompositionTracker();
        dispose = ime.register(editor as unknown as LexicalEditor);
    });

    afterEach(() => {
        dispose?.();
        dispose = null;
        root.remove();
        vi.useRealTimers();
    });

    it('reports no composition before any composition event', () => {
        expect(ime.isComposing()).toBe(false);
        expect(ime.isImeActive()).toBe(false);
    });

    it('reports a composition between compositionstart and compositionend', () => {
        compositionStart();
        expect(ime.isComposing()).toBe(true);
        expect(ime.isImeActive()).toBe(true);

        compositionEnd();
        expect(ime.isComposing()).toBe(false);
    });

    it('keeps the IME active for a grace period after compositionend', () => {
        compositionStart();
        compositionEnd();
        // The IME can still be open right after compositionend, so selection
        // writes must stay suspended.
        expect(ime.isImeActive()).toBe(true);

        vi.advanceTimersByTime(50);
        expect(ime.isImeActive()).toBe(true);

        vi.advanceTimersByTime(200);
        expect(ime.isImeActive()).toBe(false);
        expect(ime.isComposing()).toBe(false);
    });

    it('starts composing on a compositionupdate that follows no compositionstart', () => {
        compositionUpdate();
        expect(ime.isComposing()).toBe(true);
    });

    it('stays composing across a long sequence of updates', () => {
        compositionStart();
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(20_000);
            compositionUpdate();
            expect(ime.isComposing()).toBe(true);
        }
    });

    it('keeps protecting a composition that sits quiet for minutes', () => {
        // An IME can hold its candidate window open without emitting any event.
        // Expiring on elapsed time would let selection writes run against the
        // live composition and discard the composed text.
        compositionStart();
        vi.advanceTimersByTime(10 * 60_000);
        expect(ime.isComposing()).toBe(true);
        expect(ime.isImeActive()).toBe(true);
    });

    it('honours Lexical\'s flag around the end of a composition', () => {
        // The Windows composition-order deferral deliberately keeps Lexical
        // composing until the composition's final input has been processed, and
        // the tracker must never report less than Lexical knows there.
        compositionStart();
        compositionEnd();
        editor.composing = true;
        expect(ime.isComposing()).toBe(true);
        expect(ime.isImeActive()).toBe(true);

        // Long after the composition ended the flag is wedged, not meaningful.
        vi.advanceTimersByTime(1_000);
        expect(ime.isComposing()).toBe(false);
        expect(ime.isImeActive()).toBe(false);
    });

    it('clears a wedged Lexical composition flag on focus loss', () => {
        // Lexical clears its composition key while processing compositionend,
        // so a missed event leaves the flag set for the editor's lifetime.
        compositionStart();
        editor.composing = true;
        expect(ime.isComposing()).toBe(true);

        root.dispatchEvent(new Event('focusout'));
        vi.advanceTimersByTime(200);
        expect(ime.isComposing()).toBe(false);
        expect(ime.isImeActive()).toBe(false);
    });

    it('clears a wedged Lexical composition flag when the root is replaced', () => {
        compositionStart();
        editor.composing = true;
        const newRoot = document.createElement('div');
        document.body.appendChild(newRoot);
        editor.setRootElement(newRoot);

        vi.advanceTimersByTime(200);
        expect(ime.isComposing()).toBe(false);
        newRoot.remove();
    });

    it('trusts Lexical\'s flag again for the next composition', () => {
        compositionStart();
        editor.composing = true;
        root.dispatchEvent(new Event('focusout'));
        vi.advanceTimersByTime(200);
        expect(ime.isComposing()).toBe(false);

        // The cleared state must not latch.
        compositionStart();
        expect(ime.isComposing()).toBe(true);
        expect(ime.isImeActive()).toBe(true);
    });

    it('ends the composition when the editor loses focus', () => {
        compositionStart();
        root.dispatchEvent(new Event('focusout'));
        expect(ime.isComposing()).toBe(false);
    });

    it('follows the editor to a new root element', () => {
        compositionStart();
        const newRoot = document.createElement('div');
        document.body.appendChild(newRoot);
        editor.setRootElement(newRoot);
        // A composition cannot survive its root being replaced.
        expect(ime.isComposing()).toBe(false);

        newRoot.dispatchEvent(new Event('compositionstart'));
        expect(ime.isComposing()).toBe(true);

        // The old root is no longer observed.
        newRoot.dispatchEvent(new Event('compositionend'));
        vi.advanceTimersByTime(1_000);
        compositionStart();
        expect(ime.isComposing()).toBe(false);
        newRoot.remove();
    });

    it('stops reporting compositions after unregistering', () => {
        dispose?.();
        dispose = null;
        compositionStart();
        expect(ime.isComposing()).toBe(false);
        expect(ime.isImeActive()).toBe(false);
    });
});

type CommandListener = (payload: unknown) => boolean;

/**
 * Minimal stand-in for LexicalEditor's command bus and root-listener registry,
 * mirroring the semantics the deferral relies on: command listeners run in
 * descending priority order and stop at the first `true`; root listeners are
 * invoked immediately on registration and once more (with a null root) on
 * unregistration.
 */
class FakeCommandBusEditor {
    private commandListeners: { command: unknown; listener: CommandListener; priority: number; order: number }[] = [];
    private rootListeners = new Set<RootListener>();
    private root: HTMLElement | null = null;
    private order = 0;

    registerCommand(command: unknown, listener: CommandListener, priority: number): () => void {
        const entry = { command, listener, priority, order: this.order++ };
        this.commandListeners.push(entry);
        return () => {
            const i = this.commandListeners.indexOf(entry);
            if (i >= 0) this.commandListeners.splice(i, 1);
        };
    }

    dispatchCommand(command: unknown, payload: unknown): boolean {
        const listeners = this.commandListeners
            .filter(entry => entry.command === command)
            .sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
        for (const { listener } of listeners) {
            if (listener(payload)) return true;
        }
        return false;
    }

    registerRootListener(listener: RootListener): () => void {
        listener(this.root, null);
        this.rootListeners.add(listener);
        return () => {
            this.rootListeners.delete(listener);
            listener(null, this.root);
        };
    }

    setRootElement(next: HTMLElement | null): void {
        const prev = this.root;
        this.root = next;
        for (const listener of this.rootListeners) listener(next, prev);
    }
}

describe('registerCompositionEndDeferral', () => {
    let editor: FakeCommandBusEditor;
    let root: HTMLElement;
    let stockHandler: ReturnType<typeof vi.fn>;
    let dispose: (() => void) | null;

    const compositionEndEvent = () =>
        ({ type: 'compositionend', data: '你好' }) as unknown as CompositionEvent;

    beforeEach(() => {
        vi.useFakeTimers();
        editor = new FakeCommandBusEditor();
        root = document.createElement('div');
        document.body.appendChild(root);
        editor.setRootElement(root);
        // Stands in for Lexical's built-in composition-end handler, which is
        // registered at COMMAND_PRIORITY_EDITOR (the lowest priority).
        stockHandler = vi.fn().mockReturnValue(true);
        editor.registerCommand(COMPOSITION_END_COMMAND, stockHandler, COMMAND_PRIORITY_EDITOR);
        dispose = registerCompositionEndDeferral(editor as unknown as LexicalEditor);
    });

    afterEach(() => {
        dispose?.();
        dispose = null;
        root.remove();
        vi.useRealTimers();
    });

    it('holds composition end until the final input event, then processes it once', () => {
        const event = compositionEndEvent();
        editor.dispatchCommand(COMPOSITION_END_COMMAND, event);
        expect(stockHandler).not.toHaveBeenCalled();

        root.dispatchEvent(new Event('input'));
        expect(stockHandler).toHaveBeenCalledTimes(1);
        expect(stockHandler).toHaveBeenCalledWith(event);

        // The fallback timer must not trigger a second processing pass.
        vi.runAllTimers();
        expect(stockHandler).toHaveBeenCalledTimes(1);
    });

    it('processes composition end on the fallback task when no input follows', () => {
        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        expect(stockHandler).not.toHaveBeenCalled();

        vi.runAllTimers();
        expect(stockHandler).toHaveBeenCalledTimes(1);
    });

    it('tolerates the input-before-compositionend event order', () => {
        // The final input arriving first (no deferral pending) is a no-op.
        root.dispatchEvent(new Event('input'));
        expect(stockHandler).not.toHaveBeenCalled();

        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        vi.runAllTimers();
        expect(stockHandler).toHaveBeenCalledTimes(1);
    });

    it('does not reprocess when input arrives after the fallback already ran', () => {
        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        vi.runAllTimers();
        expect(stockHandler).toHaveBeenCalledTimes(1);

        root.dispatchEvent(new Event('input'));
        expect(stockHandler).toHaveBeenCalledTimes(1);
    });

    it('flushes a pending composition end on cleanup', () => {
        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        expect(stockHandler).not.toHaveBeenCalled();

        dispose?.();
        dispose = null;
        expect(stockHandler).toHaveBeenCalledTimes(1);

        vi.runAllTimers();
        expect(stockHandler).toHaveBeenCalledTimes(1);
    });

    it('flushes a pending composition end when the root element changes', () => {
        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        const newRoot = document.createElement('div');
        document.body.appendChild(newRoot);
        editor.setRootElement(newRoot);
        expect(stockHandler).toHaveBeenCalledTimes(1);

        // The deferral now observes the new root...
        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        newRoot.dispatchEvent(new Event('input'));
        expect(stockHandler).toHaveBeenCalledTimes(2);

        // ...and no longer reacts to the old one.
        root.dispatchEvent(new Event('input'));
        expect(stockHandler).toHaveBeenCalledTimes(2);
        newRoot.remove();
    });

    it('keeps stock (immediate) processing when no root is mounted', () => {
        editor.setRootElement(null);
        editor.dispatchCommand(COMPOSITION_END_COMMAND, compositionEndEvent());
        expect(stockHandler).toHaveBeenCalledTimes(1);
    });
});
