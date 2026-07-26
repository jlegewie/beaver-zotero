/** @vitest-environment jsdom */
/* eslint-disable no-restricted-globals -- jsdom test: `document` is the test DOM, not a Zotero window */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    COMMAND_PRIORITY_EDITOR,
    COMPOSITION_END_COMMAND,
    createEditor,
} from 'lexical';
import type { LexicalEditor } from 'lexical';
import {
    createCompositionGatedEmitter,
    createImeCompositionTracker,
    decideCompositionPayloadRecovery,
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

    it('observes compositionstart before an existing bubble-phase root listener', () => {
        dispose?.();
        dispose = null;
        ime = createImeCompositionTracker();
        let composingSeenByEarlierListener = false;
        const earlierBubbleListener = () => {
            composingSeenByEarlierListener = ime.isComposing();
        };
        root.addEventListener('compositionstart', earlierBubbleListener);
        dispose = ime.register(editor as unknown as LexicalEditor);

        compositionStart();

        expect(composingSeenByEarlierListener).toBe(true);
        root.removeEventListener('compositionstart', earlierBubbleListener);
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

    // A caller that discards a composition's text (a composer reset) scopes the
    // decision to that composition by id, so a composition the user starts
    // afterwards is unaffected.
    it('keeps one id for the whole of a composition, including its commit', () => {
        const before = ime.compositionId();
        compositionStart();
        const id = ime.compositionId();
        expect(id).not.toBe(before);

        compositionUpdate();
        compositionUpdate();
        expect(ime.compositionId()).toBe(id);

        // Held after the end: the update carrying the committed text still
        // reports the composition it came from.
        compositionEnd();
        expect(ime.compositionId()).toBe(id);
        vi.advanceTimersByTime(1_000);
        expect(ime.compositionId()).toBe(id);
    });

    it('gives the next composition a new id', () => {
        compositionStart();
        const first = ime.compositionId();
        compositionEnd();

        compositionStart();
        expect(ime.compositionId()).not.toBe(first);
    });

    it('opens a new composition for a compositionupdate that follows no start', () => {
        compositionUpdate();
        const id = ime.compositionId();
        compositionUpdate();
        expect(ime.compositionId()).toBe(id);

        compositionEnd();
        compositionUpdate();
        expect(ime.compositionId()).not.toBe(id);
    });

    it('stops reporting compositions after unregistering', () => {
        dispose?.();
        dispose = null;
        compositionStart();
        expect(ime.isComposing()).toBe(false);
        expect(ime.isImeActive()).toBe(false);
    });

    it('reports nothing after unregistering during the post-composition grace', () => {
        // Unregistering must not leave the grace period running: the tracker is
        // gone, so it can no longer tell anyone when the IME actually closes.
        compositionStart();
        compositionEnd();
        expect(ime.isImeActive()).toBe(true);

        dispose?.();
        dispose = null;
        expect(ime.isComposing()).toBe(false);
        expect(ime.isImeActive()).toBe(false);
    });

    it('reports nothing after unregistering mid-composition', () => {
        compositionStart();
        editor.composing = true;

        dispose?.();
        dispose = null;
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

describe('composition payload recovery lifecycle', () => {
    it('cancels an older recovery when a new composition starts', () => {
        vi.useFakeTimers();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const editor = createEditor({
            namespace: 'ime-recovery-lifecycle-test',
            onError: error => { throw error; },
        });
        editor.setRootElement(root);
        editor.update(() => {
            const text = $createTextNode('上市\u200b上');
            $getRoot().append($createParagraphNode().append(text));
            text.select(2, 3);
        }, { discrete: true });
        const dispose = registerCompositionEndDeferral(editor);

        editor.dispatchCommand(
            COMPOSITION_END_COMMAND,
            new CompositionEvent('compositionend', { data: '🀄' }),
        );
        root.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: '🀄',
            inputType: 'insertCompositionText',
            isComposing: false,
        }));

        // The new composition owns the selection from this point onward.
        root.dispatchEvent(new CompositionEvent('compositionstart', {
            bubbles: true,
            data: '',
        }));
        vi.runAllTimers();

        let modelText = '';
        editor.getEditorState().read(() => {
            modelText = $getRoot().getTextContent();
        });
        expect(modelText).not.toContain('🀄');

        dispose();
        editor.setRootElement(null);
        root.remove();
        vi.useRealTimers();
    });
});

describe('decideCompositionPayloadRecovery', () => {
    it('waits while Gecko still holds the composition marker', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '上市\u200b上',
            committedText: '🀄',
            replacementRange: { start: 2, end: 3 },
            textSize: 4,
            deadlineReached: false,
        })).toEqual({ action: 'wait' });
    });

    it('inserts at a collapsed caret after cleanup instead of replacing right-hand text', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '上市上',
            committedText: '🀄',
            replacementRange: { start: 2, end: 3 },
            textSize: 3,
            deadlineReached: false,
        })).toEqual({
            action: 'recover',
            start: 2,
            end: 2,
            cleanupObserved: true,
        });
    });

    it('replaces the marker range when the cleanup wait expires', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '上市\u200b上',
            committedText: '🀄',
            replacementRange: { start: 2, end: 3 },
            textSize: 4,
            deadlineReached: true,
        })).toEqual({
            action: 'recover',
            start: 2,
            end: 3,
            cleanupObserved: false,
        });
    });

    it('does nothing when the committed candidate is already present', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '上市🀄上',
            committedText: '🀄',
            replacementRange: { start: 2, end: 3 },
            textSize: 5,
            deadlineReached: false,
        })).toEqual({ action: 'already-present' });
    });

    it('does nothing when Gecko applies the candidate at a different offset', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '🀄上市上',
            committedText: '🀄',
            replacementRange: { start: 2, end: 3 },
            textSize: 5,
            deadlineReached: false,
        })).toEqual({ action: 'already-present' });
    });

    it('aborts when unrelated content changes during the cleanup poll', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '外市\u200b上',
            committedText: '🀄',
            replacementRange: { start: 2, end: 3 },
            textSize: 4,
            deadlineReached: false,
        })).toEqual({ action: 'abort', reason: 'unrelated-change' });
    });

    it('aborts when the captured replacement range is no longer valid', () => {
        expect(decideCompositionPayloadRecovery({
            baselineModel: '上市\u200b上',
            currentText: '上市\u200b上',
            committedText: '🀄',
            replacementRange: { start: 8, end: 9 },
            textSize: 4,
            deadlineReached: true,
        })).toEqual({ action: 'abort', reason: 'invalid-baseline' });
    });
});

describe('createCompositionGatedEmitter', () => {
    const RETRY_MS = 10;
    const MAX_WAIT_MS = 100;

    let emit: ReturnType<typeof vi.fn>;
    let composing: boolean;
    let hasWindow: boolean;
    let emitter: ReturnType<typeof createCompositionGatedEmitter>;

    beforeEach(() => {
        vi.useFakeTimers();
        emit = vi.fn();
        composing = false;
        hasWindow = true;
        emitter = createCompositionGatedEmitter({
            isComposing: () => composing,
            emit,
            getWindow: () => (hasWindow ? (window as Window & typeof globalThis) : null),
            retryMs: RETRY_MS,
            maxWaitMs: MAX_WAIT_MS,
        });
    });

    afterEach(() => {
        emitter.dispose();
        vi.useRealTimers();
    });

    it('emits immediately outside a composition', () => {
        emitter.handleUpdate();
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('withholds the update while composing and emits once it ends', () => {
        composing = true;
        emitter.handleUpdate();
        vi.advanceTimersByTime(RETRY_MS * 3);
        expect(emit).not.toHaveBeenCalled();

        composing = false;
        vi.advanceTimersByTime(RETRY_MS);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    // The point of the gate: N keystrokes of a composition must not produce N
    // re-renders of the composer's consumers, because a consumer that mounts or
    // unmounts a node destroys the running composition.
    it('coalesces a whole composition into a single emission', () => {
        composing = true;
        for (let i = 0; i < 12; i++) {
            emitter.handleUpdate();
            vi.advanceTimersByTime(RETRY_MS);
        }
        expect(emit).not.toHaveBeenCalled();

        composing = false;
        vi.advanceTimersByTime(RETRY_MS);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('emits anyway once the bounded wait expires on a wedged composition', () => {
        composing = true;
        emitter.handleUpdate();
        vi.advanceTimersByTime(MAX_WAIT_MS * 2);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('restarts the wait on each further composition update', () => {
        composing = true;
        emitter.handleUpdate();
        vi.advanceTimersByTime(MAX_WAIT_MS / 2);
        // A composition that is still producing updates has not wedged, so the
        // bound must not expire underneath it.
        emitter.handleUpdate();
        vi.advanceTimersByTime(MAX_WAIT_MS * 0.7);
        expect(emit).not.toHaveBeenCalled();

        vi.advanceTimersByTime(MAX_WAIT_MS);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('flushes a withheld update on dispose', () => {
        composing = true;
        emitter.handleUpdate();
        vi.advanceTimersByTime(RETRY_MS);
        expect(emit).not.toHaveBeenCalled();

        emitter.dispose();
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('does not re-emit on dispose when nothing is withheld', () => {
        emitter.handleUpdate();
        expect(emit).toHaveBeenCalledTimes(1);

        emitter.dispose();
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('drops the pending timer on dispose', () => {
        composing = true;
        emitter.handleUpdate();
        emitter.dispose();
        expect(emit).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(MAX_WAIT_MS * 2);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('ignores updates after dispose', () => {
        emitter.dispose();
        emitter.handleUpdate();
        expect(emit).not.toHaveBeenCalled();
    });

    // What submitting the composer relies on: the text of a just-committed
    // candidate is published on demand rather than one retry interval later.
    it('publishes a withheld update on flush, without waiting for the IME', () => {
        composing = true;
        emitter.handleUpdate();
        expect(emit).not.toHaveBeenCalled();

        expect(emitter.flush()).toBe(true);
        expect(emit).toHaveBeenCalledTimes(1);

        // The flushed update is not emitted a second time by the retry timer.
        composing = false;
        vi.advanceTimersByTime(MAX_WAIT_MS * 2);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('reports nothing to flush when no update is withheld', () => {
        expect(emitter.flush()).toBe(false);
        expect(emit).not.toHaveBeenCalled();

        emitter.handleUpdate();
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emitter.flush()).toBe(false);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    // What a composer reset relies on: text withheld from a thread the user has
    // left must not be published into the next one.
    it('drops a withheld update on discard without emitting it', () => {
        composing = true;
        emitter.handleUpdate();

        expect(emitter.discard()).toBe(true);
        expect(emit).not.toHaveBeenCalled();

        // Neither the retry timer nor dispose resurrects it.
        composing = false;
        vi.advanceTimersByTime(MAX_WAIT_MS * 2);
        emitter.dispose();
        expect(emit).not.toHaveBeenCalled();
    });

    it('reports nothing to discard when no update is withheld', () => {
        expect(emitter.discard()).toBe(false);

        emitter.handleUpdate();
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emitter.discard()).toBe(false);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('keeps gating updates after a discard', () => {
        composing = true;
        emitter.handleUpdate();
        emitter.discard();

        // The next composition is withheld and published as usual.
        emitter.handleUpdate();
        vi.advanceTimersByTime(RETRY_MS * 3);
        expect(emit).not.toHaveBeenCalled();

        composing = false;
        vi.advanceTimersByTime(RETRY_MS);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('reports nothing to flush after dispose', () => {
        composing = true;
        emitter.handleUpdate();
        emitter.dispose();
        expect(emit).toHaveBeenCalledTimes(1);

        expect(emitter.flush()).toBe(false);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    // The default bound is a backstop for a composition that never reports its
    // end, not a deadline for a user reading a candidate list. Emitting
    // mid-composition is the hazard the gate exists to prevent, and paging
    // through candidates or pausing mid-phrase produces no editor update to
    // restart the wait, so the default must stay far above a human pause.
    it('holds a withheld update through a long pause by default', () => {
        composing = true;
        const defaultEmitter = createCompositionGatedEmitter({
            isComposing: () => composing,
            emit,
            getWindow: () => window as Window & typeof globalThis,
        });
        defaultEmitter.handleUpdate();
        vi.advanceTimersByTime(20_000);
        expect(emit).not.toHaveBeenCalled();

        composing = false;
        vi.advanceTimersByTime(100);
        expect(emit).toHaveBeenCalledTimes(1);
        defaultEmitter.dispose();
    });

    // Losing the text is worse than an ill-timed re-render, so a missing window
    // (no mounted root to time with) falls back to emitting immediately.
    it('emits immediately while composing when no window is available', () => {
        composing = true;
        hasWindow = false;
        emitter.handleUpdate();
        expect(emit).toHaveBeenCalledTimes(1);
    });
});
