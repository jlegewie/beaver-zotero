import {
    $getRoot,
    COMMAND_PRIORITY_CRITICAL,
    COMPOSITION_END_COMMAND,
    type LexicalEditor,
} from 'lexical';
import { logger } from '../../../../src/utils/logger';

/**
 * How long after `compositionend` the IME is still treated as active.
 *
 * Gecko can leave an IME composing after it has already fired
 * `compositionend` (Lexical carries its own workaround for the same quirk),
 * and a scripted selection change inside that window makes Gecko commit or
 * discard whatever the IME still holds. Everything that repairs the caret
 * therefore stands down for a short grace period after composition ends.
 */
const IME_ACTIVE_GRACE_MS = 120;

/**
 * Tracks IME composition from the editor's own DOM events.
 *
 * Custom caret/selection handling must yield to an active IME: acting on
 * composition-owned key events, calling preventDefault() on them, or moving
 * the selection while the IME composes cancels the composition or discards
 * the text the user just committed.
 *
 * Two granularities are exposed because the two hazards differ:
 *
 * - `isComposing()` — strictly between `compositionstart` and
 *   `compositionend`. Use it for edits that would corrupt the composed text
 *   itself (node transforms, intercepting `beforeinput`).
 * - `isImeActive()` — also covers the grace period after `compositionend`.
 *   Use it for anything that writes the selection, which is unsafe for as
 *   long as the IME may still be open.
 *
 * Lexical's own `editor.isComposing()` is folded in so the tracker can never
 * report less than Lexical knows; it is not sufficient on its own, because it
 * is false on the keydown that starts a composition and false again as soon
 * as Lexical has processed `compositionend`.
 *
 * An in-progress composition is only ever cleared by positive evidence that it
 * finished — `compositionend`, the editor losing focus, its root element being
 * replaced, or the tracker being unregistered — never by elapsed time. An IME
 * can sit quietly with its candidate window open for minutes without emitting a
 * single event, and a timeout cannot tell that apart from a dropped end event;
 * erring towards "still composing" costs a few skipped caret repairs, while
 * erring the other way lets a scripted selection change discard the user's
 * composed text. Lexical's flag is the one exception: it survives its own
 * `compositionend` by design for a moment (see isEditorComposing) but is not
 * cleared at all when the event goes missing, so it is honoured only around the
 * end of a composition rather than indefinitely.
 */
export type ImeCompositionTracker = {
    /** True while a composition is in progress. */
    isComposing: () => boolean;
    /** True while a composition is in progress or may still be open. */
    isImeActive: () => boolean;
    /** Attach to an editor's root element. Returns an unregister function. */
    register: (editor: LexicalEditor) => () => void;
};

export function createImeCompositionTracker(): ImeCompositionTracker {
    let editor: LexicalEditor | null = null;
    let composing = false;
    // Positive evidence that no composition is open. Also gates Lexical's flag,
    // which it does not clear when it misses a `compositionend`.
    let ended = true;
    let lastEventAt = 0;

    /**
     * Lexical's own flag. After `compositionend` it can legitimately stay set
     * until Lexical has processed the composition's final `input` — the Windows
     * composition-order deferral holds it there on purpose, and mutating the
     * composed text node inside that window is what discards IME text. That
     * window is milliseconds wide, so it is honoured for the grace period and
     * no longer; a flag still set after that is wedged (Lexical never clears it
     * when it misses a `compositionend`) and must not keep suppressing caret
     * handling for the editor's lifetime.
     */
    const isEditorComposing = () =>
        (editor?.isComposing() ?? false)
        && (!ended || Date.now() - lastEventAt < IME_ACTIVE_GRACE_MS);
    const isComposing = () => composing || isEditorComposing();
    const isImeActive = () =>
        isComposing() || (lastEventAt > 0 && Date.now() - lastEventAt < IME_ACTIVE_GRACE_MS);

    const onCompositionStart = () => {
        composing = true;
        ended = false;
        lastEventAt = Date.now();
    };
    const onCompositionUpdate = onCompositionStart;
    const onCompositionEnd = () => {
        composing = false;
        ended = true;
        lastEventAt = Date.now();
    };
    // Gecko commits an open composition when the editor loses focus, and the
    // resulting compositionend can be missed (e.g. the window is torn down).
    // Losing focus is therefore treated as the composition being over — it is
    // also what lets a lingering Lexical flag recover.
    const onFocusOut = () => {
        if (ended && !composing) return;
        composing = false;
        ended = true;
        lastEventAt = Date.now();
    };

    const register = (nextEditor: LexicalEditor) => {
        editor = nextEditor;
        const attach = (root: HTMLElement) => {
            root.addEventListener('compositionstart', onCompositionStart);
            root.addEventListener('compositionupdate', onCompositionUpdate);
            root.addEventListener('compositionend', onCompositionEnd);
            root.addEventListener('focusout', onFocusOut);
        };
        const detach = (root: HTMLElement) => {
            root.removeEventListener('compositionstart', onCompositionStart);
            root.removeEventListener('compositionupdate', onCompositionUpdate);
            root.removeEventListener('compositionend', onCompositionEnd);
            root.removeEventListener('focusout', onFocusOut);
        };
        const unregisterRoot = nextEditor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) detach(prevRootElement);
            // A composition cannot survive its root element being swapped.
            composing = false;
            ended = true;
            if (rootElement) attach(rootElement);
        });
        return () => {
            unregisterRoot();
            composing = false;
            ended = true;
            editor = null;
        };
    };

    return { isComposing, isImeActive, register };
}

/**
 * How often a withheld composition update re-checks whether the IME has
 * finished.
 */
const EMIT_FLUSH_RETRY_MS = 60;

/**
 * How long a withheld composition update may wait for the IME before it is
 * emitted regardless.
 *
 * Unlike the caret repairs — which can be abandoned, costing only a caret
 * position — this emission is the only path by which the composer's text
 * reaches the rest of the app, so a composition that never ends must not
 * strand it: sending would then post stale text. The wait is bounded and
 * always ends in an emission. Each further composition update restarts it, so
 * the bound only expires for a composition that has genuinely wedged.
 */
const EMIT_FLUSH_MAX_WAIT_MS = 3_000;

export type CompositionGatedEmitter = {
    /**
     * Call for every editor update that would be published upward. Emits
     * immediately outside a composition, defers during one.
     */
    handleUpdate: () => void;
    /** Flushes a withheld update and drops any pending timer. */
    dispose: () => void;
};

/**
 * Withholds the composer's upward text emission for the duration of an IME
 * composition.
 *
 * Every emission re-renders each subscriber of the shared composer-text state,
 * and a subscriber that mounts or unmounts a node lands a childList mutation in
 * Zotero's chrome document — which resets the contenteditable's selection
 * offsets and so destroys the composition anchor the IME is holding. That is
 * the same hazard PlaceholderVisibilityPlugin avoids for the placeholder
 * element, but the placeholder is only one of the nodes that appear or
 * disappear the moment the composer goes from empty to non-empty: the send
 * button swaps its icon and label, and the first-run panels auto-dismiss on the
 * first typed character. Gating the emission covers all of them at once,
 * including any added later, which auditing subscribers one by one does not.
 *
 * A destroyed composition breaks up multi-keystroke input, leaving raw
 * keystrokes mixed into the committed text; a composition short enough to be
 * carried by its first update — punctuation, on most input methods — is lost
 * outright.
 *
 * A withheld update is never dropped: it is emitted as soon as the IME is no
 * longer composing, when the bounded wait expires, or on dispose.
 */
export function createCompositionGatedEmitter(options: {
    /** The composition check to gate on — normally the tracker's isComposing. */
    isComposing: () => boolean;
    /** Publishes the current editor text upward. Must be safe to call spuriously. */
    emit: () => void;
    /** The window to time with; null while no root is mounted. */
    getWindow: () => (Window & typeof globalThis) | null;
    retryMs?: number;
    maxWaitMs?: number;
}): CompositionGatedEmitter {
    const {
        isComposing,
        emit,
        getWindow,
        retryMs = EMIT_FLUSH_RETRY_MS,
        maxWaitMs = EMIT_FLUSH_MAX_WAIT_MS,
    } = options;

    let timer: number | null = null;
    let deadline = 0;
    let pending = false;
    let disposed = false;

    const cancel = () => {
        if (timer === null) return;
        getWindow()?.clearTimeout(timer);
        timer = null;
    };

    const publish = () => {
        pending = false;
        cancel();
        emit();
    };

    const onTimer = () => {
        timer = null;
        if (disposed) return;
        if (isComposing() && Date.now() < deadline) {
            schedule(false);
            return;
        }
        publish();
    };

    function schedule(restartDeadline: boolean) {
        const win = getWindow();
        // Without a window there is nothing to time with, and holding the text
        // back indefinitely would lose it; publishing now is the safer failure.
        if (!win) {
            publish();
            return;
        }
        if (restartDeadline) deadline = Date.now() + maxWaitMs;
        cancel();
        pending = true;
        timer = win.setTimeout(onTimer, retryMs);
    }

    return {
        handleUpdate: () => {
            if (disposed) return;
            if (isComposing()) {
                schedule(true);
                return;
            }
            publish();
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            cancel();
            // The editor still reads normally during teardown (this unregisters
            // before Lexical itself does), so a withheld update is published
            // rather than lost when the composer unmounts mid-composition.
            if (pending) {
                pending = false;
                emit();
            }
        },
    };
}

/**
 * Works around IME text being discarded in Gecko on Windows, where the
 * selected candidate never reaches the composer.
 *
 * Gecko dispatches `compositionend` BEFORE the composition's final `input`
 * event, and on Windows an application that mutates the composed text node
 * between those two events can make the IME discard the just-committed text
 * (see https://bugzilla.mozilla.org/show_bug.cgi?id=1910865#c3). Lexical
 * compensates for exactly this by deferring its composition-end processing
 * until after that final input — but only when its user-agent sniffing
 * detects Firefox. Zotero identifies as "Zotero", so Lexical takes the
 * Chrome/WebKit path instead: it processes `compositionend` immediately,
 * which can reconcile the editor DOM inside the vulnerable window.
 *
 * Lexical's compositionend handling is reachable through its command bus:
 * the root `compositionend` listener dispatches COMPOSITION_END_COMMAND, and
 * the built-in handler runs at COMMAND_PRIORITY_EDITOR (the lowest
 * priority). This registration intercepts the command at critical priority,
 * swallows it (keeping Lexical in composing state, which also makes the
 * selection-repair plugins stand down), and re-dispatches it right after the
 * final `input` event has been processed — reproducing the ordering Lexical
 * itself uses on Firefox without patching Lexical.
 *
 * The next-task fallback re-dispatches when no input follows (cancelled
 * composition, or an IME that delivers input before compositionend), so the
 * editor can never get stuck in composing state; in that case behavior
 * degrades to the stock immediate order.
 *
 * Only this one ordering rule is reproduced, deliberately. Widening Lexical's
 * detection so that it treats Zotero as Gecko everywhere was measured against
 * simulated IME commits and made things worse: Lexical's Gecko commit path
 * also pulls the selection anchor back by the length of the committed text
 * (guarding against an IME that keeps composing past `compositionend`), and
 * when the committed text differs from the last composition update that both
 * inserted the text twice and left it selected, so the next composition
 * replaced it. Keep any future change to this area behind the same kind of
 * measurement.
 */
export function registerCompositionEndDeferral(editor: LexicalEditor): () => void {
    let deferredEvent: CompositionEvent | null = null;
    let redispatching = false;
    let fallbackTimer: number | null = null;
    let rootEl: HTMLElement | null = null;

    const clearFallback = () => {
        if (fallbackTimer === null) return;
        rootEl?.ownerDocument.defaultView?.clearTimeout(fallbackTimer);
        fallbackTimer = null;
    };

    const finish = () => {
        clearFallback();
        const event = deferredEvent;
        deferredEvent = null;
        if (!event) return;
        redispatching = true;
        try {
            editor.dispatchCommand(COMPOSITION_END_COMMAND, event);
        } catch (error) {
            // Only reachable when the editor is torn down mid-composition
            // (e.g. its window closed); Lexical clears its composing state
            // before the failing window access, so nothing is left stuck.
            logger(`registerCompositionEndDeferral: deferred composition end failed: ${error}`, 1);
        } finally {
            redispatching = false;
        }
    };

    // Runs after Lexical's own `input` handler: Lexical attaches its root
    // events before notifying root listeners, and same-node listeners fire in
    // registration order. By this point the final composition input has been
    // adopted into the editor state, so the deferred composition end can be
    // processed safely.
    const onRootInput = () => {
        if (deferredEvent !== null) finish();
    };

    const unregisterCommand = editor.registerCommand<CompositionEvent>(
        COMPOSITION_END_COMMAND,
        (event) => {
            if (redispatching) return false; // our re-dispatch: let Lexical process it now
            const win = rootEl?.ownerDocument.defaultView;
            if (!win) return false; // no mounted root — keep stock behavior
            clearFallback();
            deferredEvent = event;
            fallbackTimer = win.setTimeout(finish, 0);
            return true;
        },
        COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterRoot = editor.registerRootListener((rootElement, prevRootElement) => {
        if (prevRootElement) prevRootElement.removeEventListener('input', onRootInput);
        // A pending deferral belongs to the previous root; complete it before
        // switching so composing state cannot leak across roots.
        if (deferredEvent !== null) finish();
        rootEl = rootElement;
        if (rootElement) rootElement.addEventListener('input', onRootInput);
    });

    return () => {
        unregisterCommand();
        // Unregistering invokes the root listener once more with a null root,
        // which detaches the input listener and flushes any pending deferral
        // (straight to Lexical's handler — ours is already unregistered).
        unregisterRoot();
    };
}

const TRACED_EVENTS = [
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'beforeinput',
    'input',
    'keydown',
] as const;

/**
 * Logs every composition-related DOM event on the editor root together with
 * the DOM text, the editor-state text and the live selection, so IME problems
 * can be diagnosed from debug output without a local reproduction. The
 * listeners are attached after Lexical's, so each line reflects the state
 * AFTER Lexical processed that event.
 *
 * Also reports DOM mutations from outside the editor that land mid-composition:
 * in Zotero's chrome document those reset the selection offsets, which breaks
 * the composition anchor the IME is holding.
 */
export function registerImeTrace(editor: LexicalEditor, ime: ImeCompositionTracker): () => void {
    const describeSelection = (root: HTMLElement): string => {
        const sel = root.ownerDocument.defaultView?.getSelection();
        if (!sel) return 'none';
        const inRoot = !!sel.anchorNode && root.contains(sel.anchorNode);
        return `${sel.anchorOffset}/${sel.focusOffset}${inRoot ? '' : ' (outside)'}`;
    };

    const onEvent = (event: Event) => {
        const e = event as {
            type: string;
            data?: string | null;
            inputType?: string;
            key?: string;
            keyCode?: number;
            isComposing?: boolean;
        };
        const root = editor.getRootElement();
        let modelText = '';
        editor.getEditorState().read(() => {
            modelText = $getRoot().getTextContent();
        });
        const domText = root?.textContent ?? '';
        logger(
            `[IME] ${e.type}`
            + ` data=${JSON.stringify(e.data ?? null)}`
            + ` inputType=${e.inputType ?? '-'}`
            + ` key=${e.key ?? '-'}`
            + ` keyCode=${e.keyCode ?? '-'}`
            + ` isComposing=${e.isComposing ?? '-'}`
            + ` editorComposing=${editor.isComposing()}`
            + ` imeActive=${ime.isImeActive()}`
            + ` sel=${root ? describeSelection(root) : '-'}`
            + ` dom=${JSON.stringify(domText)}`
            + ` model=${JSON.stringify(modelText)}`,
        );
    };

    let detach: (() => void) | null = null;
    const unregisterRoot = editor.registerRootListener((rootElement) => {
        detach?.();
        detach = null;
        if (!rootElement) return;
        for (const type of TRACED_EVENTS) rootElement.addEventListener(type, onEvent);

        const doc = rootElement.ownerDocument;
        const win = doc.defaultView;
        let observer: MutationObserver | null = null;
        if (win) {
            observer = new (win as typeof globalThis & Window).MutationObserver((records) => {
                if (!ime.isImeActive()) return;
                const external = records.filter(record => !rootElement.contains(record.target));
                if (external.length === 0) return;
                const kinds = new Set(external.map(record => record.type));
                logger(
                    `[IME] external mutations during composition:`
                    + ` count=${external.length}`
                    + ` types=${[...kinds].join(',')}`
                    + ` sel=${describeSelection(rootElement)}`,
                );
            });
            observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
        }

        detach = () => {
            for (const type of TRACED_EVENTS) rootElement.removeEventListener(type, onEvent);
            observer?.disconnect();
        };
    });

    const win = editor.getRootElement()?.ownerDocument.defaultView;
    const ua = win?.navigator.userAgent ?? '(no window)';
    logger(
        `[IME] trace enabled: ua=${JSON.stringify(ua)}`
        + ` geckoDetected=${/\bGecko\/\d+/.test(ua)}`
        + ` firefoxToken=${/^(?!.*Seamonkey)(?=.*Firefox).*/i.test(ua)}`,
    );

    return () => {
        unregisterRoot();
        detach?.();
        detach = null;
    };
}
