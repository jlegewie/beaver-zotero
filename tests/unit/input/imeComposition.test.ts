/** @vitest-environment jsdom */
/* eslint-disable no-restricted-globals -- jsdom test: `document` is the test DOM, not a Zotero window */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { COMMAND_PRIORITY_EDITOR, COMPOSITION_END_COMMAND } from 'lexical';
import type { LexicalEditor } from 'lexical';
import { registerCompositionEndDeferral } from '../../../react/components/input/lexical/imeComposition';

type CommandListener = (payload: unknown) => boolean;
type RootListener = (root: HTMLElement | null, prev: HTMLElement | null) => void;

/**
 * Minimal stand-in for LexicalEditor's command bus and root-listener registry,
 * mirroring the semantics the deferral relies on: command listeners run in
 * descending priority order and stop at the first `true`; root listeners are
 * invoked immediately on registration and once more (with a null root) on
 * unregistration.
 */
class FakeEditor {
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
    let editor: FakeEditor;
    let root: HTMLElement;
    let stockHandler: ReturnType<typeof vi.fn>;
    let dispose: (() => void) | null;

    const compositionEndEvent = () =>
        ({ type: 'compositionend', data: '你好' }) as unknown as CompositionEvent;

    beforeEach(() => {
        vi.useFakeTimers();
        editor = new FakeEditor();
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
