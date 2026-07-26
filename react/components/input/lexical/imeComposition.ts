import {
    $getSelection,
    $getRoot,
    $isRangeSelection,
    COMMAND_PRIORITY_CRITICAL,
    COMPOSITION_END_COMMAND,
    type LexicalEditor,
} from 'lexical';
import { logger } from '../../../../src/utils/logger';
import { isImeKeyEvent } from '../../../utils/ime';
import {
    $getFlatSelectionOffsets,
    $trySelectFlatRange,
} from './selectionOffsets';

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
const NATIVE_CLEANUP_POLL_MS = 10;
const NATIVE_CLEANUP_MAX_WAIT_MS = 100;

type CompositionReplacementRange = { start: number; end: number };

/**
 * Decide whether and where to recover an IME payload that Gecko supplied only
 * through InputEvent.data. Exported for focused unit coverage of the timing and
 * middle-of-text range behavior; it has no browser or Lexical dependencies.
 */
export function decideCompositionPayloadRecovery(options: {
    baselineModel: string | null;
    currentText: string;
    committedText: string;
    replacementRange: CompositionReplacementRange;
    textSize: number;
    deadlineReached: boolean;
}):
    | { action: 'already-present' }
    | { action: 'abort'; reason: 'invalid-baseline' | 'unrelated-change' }
    | { action: 'wait' }
    | {
        action: 'recover';
        start: number;
        end: number;
        cleanupObserved: boolean;
    } {
    const {
        baselineModel,
        currentText,
        committedText,
        replacementRange,
        textSize,
        deadlineReached,
    } = options;
    const { start, end } = replacementRange;
    if (
        baselineModel === null
        || committedText.length === 0
        || !Number.isInteger(start)
        || !Number.isInteger(end)
        || start < 0
        || end < start
        || end > baselineModel.length
        || currentText.length !== textSize
    ) {
        return { action: 'abort', reason: 'invalid-baseline' };
    }

    const cleanedBaseline =
        baselineModel.slice(0, start)
        + baselineModel.slice(end);

    // Gecko may eventually apply the native candidate at an unexpected
    // offset. Recognize a single insertion anywhere relative to the cleaned
    // baseline so recovery never duplicates it.
    let candidateOffset = currentText.indexOf(committedText);
    while (candidateOffset !== -1) {
        if (
            currentText.slice(0, candidateOffset)
            + currentText.slice(candidateOffset + committedText.length)
            === cleanedBaseline
        ) {
            return { action: 'already-present' };
        }
        candidateOffset = currentText.indexOf(
            committedText,
            candidateOffset + 1,
        );
    }

    if (currentText === baselineModel) {
        if (!deadlineReached) return { action: 'wait' };
        return {
            action: 'recover',
            start,
            end,
            cleanupObserved: false,
        };
    }
    if (currentText === cleanedBaseline) {
        return {
            action: 'recover',
            start,
            end: start,
            cleanupObserved: true,
        };
    }
    return { action: 'abort', reason: 'unrelated-change' };
}

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
    /**
     * Identifies the current composition; incremented when one starts.
     *
     * Held after the composition ends, so the update that carries the committed
     * text still reports the composition it came from, and only a genuinely new
     * composition changes it. Lets a caller scope a decision it made during one
     * composition to that composition alone.
     */
    compositionId: () => number;
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
    // Monotonic across registrations, so an id can never be reused.
    let compositionId = 0;

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
        // Also reached by `compositionupdate` (some IMEs skip the start event),
        // so only a transition into composing opens a new composition.
        if (!composing) compositionId++;
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
        lastEventAt = 0;
        const attach = (root: HTMLElement) => {
            // Capture phase runs before Lexical's root listeners. In
            // particular, compositionstart makes Lexical insert its temporary
            // zero-width marker synchronously; the gated emitter must already
            // know that update belongs to an IME or it publishes the marker as
            // real composer text.
            root.addEventListener('compositionstart', onCompositionStart, true);
            root.addEventListener('compositionupdate', onCompositionUpdate, true);
            root.addEventListener('compositionend', onCompositionEnd, true);
            root.addEventListener('focusout', onFocusOut, true);
        };
        const detach = (root: HTMLElement) => {
            root.removeEventListener('compositionstart', onCompositionStart, true);
            root.removeEventListener('compositionupdate', onCompositionUpdate, true);
            root.removeEventListener('compositionend', onCompositionEnd, true);
            root.removeEventListener('focusout', onFocusOut, true);
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
            // Also drop the grace timestamp: an unregistered tracker must report
            // nothing, not keep a just-ended composition alive for another
            // grace period.
            lastEventAt = 0;
            editor = null;
        };
    };

    return { isComposing, isImeActive, compositionId: () => compositionId, register };
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
 * This is a backstop for a composition that never reports its end (a missed
 * `compositionend` while the editor keeps focus), not a deadline for a slow
 * typist: emitting mid-composition is the very hazard the gate exists to
 * prevent, so the bound must comfortably exceed how long a user may leave an
 * input method open — reading a candidate list, paging through candidates, or
 * simply pausing mid-phrase produces no editor update to restart it.
 *
 * Callers that need the text before then flush explicitly (see `flush`), so
 * nothing user-visible depends on this firing.
 */
const EMIT_FLUSH_MAX_WAIT_MS = 60_000;

export type CompositionGatedEmitter = {
    /**
     * Call for every editor update that would be published upward. Emits
     * immediately outside a composition, defers during one.
     */
    handleUpdate: () => void;
    /**
     * Publishes a withheld update now, without waiting for the IME. Returns
     * true when one was actually withheld. Callers that read the published
     * text at a point where staleness matters (submitting the composer) use
     * this instead of racing the retry timer.
     */
    flush: () => boolean;
    /**
     * Drops a withheld update WITHOUT emitting it. Returns true when one was
     * withheld. For callers that are about to overwrite the editor's content
     * anyway (the composer being reset), where publishing it would resurrect
     * text the user has moved on from.
     */
    discard: () => boolean;
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
 * A withheld update is never lost: it is emitted as soon as the IME is no
 * longer composing, when a caller flushes it, when the bounded wait expires, or
 * on dispose — the one exception being an explicit `discard`, for a caller that
 * is replacing the editor's content anyway.
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
        flush: () => {
            if (disposed || !pending) return false;
            publish();
            return true;
        },
        discard: () => {
            if (disposed || !pending) return false;
            pending = false;
            cancel();
            return true;
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
export function registerCompositionEndDeferral(
    editor: LexicalEditor,
    options: { trace?: boolean } = {},
): () => void {
    const { trace = false } = options;
    let deferredEvent: CompositionEvent | null = null;
    let redispatching = false;
    let fallbackTimer: number | null = null;
    let payloadRecoveryTimer: number | null = null;
    let rootEl: HTMLElement | null = null;
    let deferredDomText: string | null = null;
    let deferredModelText: string | null = null;
    let deferredReplacementRange: CompositionReplacementRange | null = null;

    const getModelText = (): string | null => {
        // The optional guard keeps the small command-bus test double usable;
        // a real LexicalEditor always supplies getEditorState().
        if (typeof editor.getEditorState !== 'function') return null;
        let text = '';
        editor.getEditorState().read(() => {
            text = $getRoot().getTextContent();
        });
        return text;
    };

    const describeState = (): string => {
        const modelText = getModelText() ?? '(unavailable)';
        const root = editor.getRootElement();
        const sel = root?.ownerDocument.defaultView?.getSelection();
        return ` editorComposing=${editor.isComposing()}`
            + ` sel=${sel ? `${sel.anchorOffset}/${sel.focusOffset}` : 'none'}`
            + ` dom=${JSON.stringify(root?.textContent ?? '')}`
            + ` model=${JSON.stringify(modelText)}`;
    };

    const tracePhase = (phase: string, event?: CompositionEvent | InputEvent) => {
        if (!trace) return;
        logger(
            `[IME] composition-end deferral ${phase}`
            + (event ? ` data=${JSON.stringify(event.data ?? null)}`
                + ` inputType=${'inputType' in event ? event.inputType : '-'}` : '')
            + describeState(),
        );
    };

    const clearFallback = () => {
        if (fallbackTimer === null) return;
        rootEl?.ownerDocument.defaultView?.clearTimeout(fallbackTimer);
        fallbackTimer = null;
    };

    const clearPayloadRecovery = () => {
        if (payloadRecoveryTimer === null) return;
        rootEl?.ownerDocument.defaultView?.clearTimeout(payloadRecoveryTimer);
        payloadRecoveryTimer = null;
    };

    const onCompositionActivity = () => {
        // A recovery belongs exclusively to the composition that scheduled
        // it. Never let its delayed selection write cross into a new one.
        // compositionupdate is included for IMEs that omit compositionstart.
        clearPayloadRecovery();
    };

    const finish = (
        reason: 'final-input' | 'fallback' | 'root-change' | 'cleanup',
        finalInput?: InputEvent,
    ) => {
        clearFallback();
        const event = deferredEvent;
        deferredEvent = null;
        if (!event) return;
        const browserDidNotMutate =
            reason === 'final-input'
            && deferredDomText !== null
            && rootEl?.textContent === deferredDomText
            && (
                deferredModelText === null
                || getModelText() === deferredModelText
            );
        redispatching = true;
        try {
            editor.dispatchCommand(COMPOSITION_END_COMMAND, event);
            const committedText = finalInput?.data ?? event.data;
            const modelAfterCompositionEnd = getModelText() ?? '';
            const initialDecision =
                committedText
                && deferredReplacementRange
                && deferredModelText !== null
                    ? decideCompositionPayloadRecovery({
                        baselineModel: deferredModelText,
                        currentText: modelAfterCompositionEnd,
                        committedText,
                        replacementRange: deferredReplacementRange,
                        textSize: modelAfterCompositionEnd.length,
                        deadlineReached: false,
                    })
                    : null;
            if (
                browserDidNotMutate
                && finalInput?.inputType === 'insertCompositionText'
                && committedText
                && deferredReplacementRange
                && deferredModelText !== null
                && initialDecision?.action !== 'already-present'
                && initialDecision?.action !== 'abort'
            ) {
                // Zotero's Gecko chrome document can deliver the committed
                // candidate only in InputEvent.data without applying the
                // corresponding native contenteditable mutation. Lexical
                // normally reads that mutation from the DOM. Gecko then
                // removes its composition node asynchronously after `input`,
                // sometimes several tasks later, so wait until the model
                // reflects that cleanup before inserting the otherwise-lost
                // payload. The unchanged DOM+model guard keeps normal IMEs on
                // Lexical's native reconciliation path.
                if (rootEl) {
                    const recoveryRoot = rootEl;
                    const replacementRange = deferredReplacementRange;
                    const baselineModel = deferredModelText;
                    const inputForTrace = finalInput;
                    const win = recoveryRoot.ownerDocument.defaultView;
                    const deadline = Date.now() + NATIVE_CLEANUP_MAX_WAIT_MS;
                    clearPayloadRecovery();
                    const attemptRecovery = () => {
                        payloadRecoveryTimer = null;
                        if (rootEl !== recoveryRoot) return;
                        const currentText = getModelText() ?? '';
                        const textSize = editor.getEditorState().read(
                            () => $getRoot().getTextContentSize(),
                        );
                        const decision = decideCompositionPayloadRecovery({
                            baselineModel,
                            currentText,
                            committedText,
                            replacementRange,
                            textSize,
                            deadlineReached: Date.now() >= deadline,
                        });
                        if (decision.action === 'already-present') {
                            return;
                        }
                        if (decision.action === 'abort') {
                            tracePhase(
                                `recovery aborted: ${decision.reason}`,
                                inputForTrace,
                            );
                            return;
                        }
                        if (decision.action === 'wait') {
                            payloadRecoveryTimer = win?.setTimeout(
                                attemptRecovery,
                                NATIVE_CLEANUP_POLL_MS,
                            ) ?? null;
                            return;
                        }
                        let inserted = false;
                        editor.update(() => {
                            if ($trySelectFlatRange(decision.start, decision.end)) {
                                const selection = $getSelection();
                                if (!$isRangeSelection(selection)) return;
                                selection.insertText(committedText);
                                inserted = true;
                            }
                        }, { discrete: true });
                        tracePhase(
                            inserted
                                ? `recovered payload after ${
                                    decision.cleanupObserved
                                        ? 'observed native cleanup'
                                        : 'cleanup wait timeout'
                                }`
                                : 'recovery skipped: no range selection',
                            inputForTrace,
                        );
                    };
                    payloadRecoveryTimer = win?.setTimeout(
                        attemptRecovery,
                        NATIVE_CLEANUP_POLL_MS,
                    ) ?? null;
                }
            }
        } catch (error) {
            // Only reachable when the editor is torn down mid-composition
            // (e.g. its window closed); Lexical clears its composing state
            // before the failing window access, so nothing is left stuck.
            logger(`registerCompositionEndDeferral: deferred composition end failed: ${error}`, 1);
        } finally {
            redispatching = false;
            deferredDomText = null;
            deferredModelText = null;
            deferredReplacementRange = null;
        }
    };

    // Runs after Lexical's own `input` handler: Lexical attaches its root
    // events before notifying root listeners, and same-node listeners fire in
    // registration order. By this point the final composition input has been
    // adopted into the editor state, so the deferred composition end can be
    // processed safely.
    const onRootInput = (event: Event) => {
        if (deferredEvent !== null) {
            finish('final-input', event as InputEvent);
        }
    };

    const unregisterCommand = editor.registerCommand<CompositionEvent>(
        COMPOSITION_END_COMMAND,
        (event) => {
            if (redispatching) return false; // our re-dispatch: let Lexical process it now
            // Some IMEs omit compositionstart. A new composition end is still
            // positive evidence that any older recovery is stale.
            clearPayloadRecovery();
            const root = rootEl;
            const win = root?.ownerDocument.defaultView;
            if (!root || !win) return false; // no mounted root — keep stock behavior
            clearFallback();
            deferredEvent = event;
            deferredDomText = root.textContent;
            deferredModelText = getModelText();
            deferredReplacementRange = null;
            if (typeof editor.getEditorState === 'function') {
                editor.getEditorState().read(() => {
                    const offsets = $getFlatSelectionOffsets();
                    if (offsets) {
                        deferredReplacementRange = {
                            start: Math.min(offsets.anchor, offsets.focus),
                            end: Math.max(offsets.anchor, offsets.focus),
                        };
                    }
                });
            }
            fallbackTimer = win.setTimeout(() => finish('fallback'), 0);
            return true;
        },
        COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterRoot = editor.registerRootListener((rootElement, prevRootElement) => {
        if (prevRootElement) {
            prevRootElement.removeEventListener('compositionstart', onCompositionActivity, true);
            prevRootElement.removeEventListener('compositionupdate', onCompositionActivity, true);
            prevRootElement.removeEventListener('input', onRootInput);
        }
        if (prevRootElement && prevRootElement !== rootElement) clearPayloadRecovery();
        // A pending deferral belongs to the previous root; complete it before
        // switching so composing state cannot leak across roots.
        if (deferredEvent !== null) finish('root-change');
        rootEl = rootElement;
        if (rootElement) {
            rootElement.addEventListener('compositionstart', onCompositionActivity, true);
            rootElement.addEventListener('compositionupdate', onCompositionActivity, true);
            rootElement.addEventListener('input', onRootInput);
        }
    });

    return () => {
        clearPayloadRecovery();
        unregisterCommand();
        // Unregistering invokes the root listener once more with a null root,
        // which detaches the input listener and flushes any pending deferral
        // (straight to Lexical's handler — ours is already unregistered).
        if (deferredEvent !== null) {
            finish('cleanup');
        }
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

/** Caps text fields in IME trace lines so ordinary typing does not flood the log. */
const TRACE_TEXT_MAX = 80;

/**
 * Compact IME event tracing for diagnosing composition issues from debug
 * output without a local reproduction. Pref `debugImeTrace`.
 *
 * Kept quiet on purpose: ordinary keydowns and non-composition inputs are
 * skipped, `compositionupdate` is a short line, and full DOM/model dumps only
 * land on composition start/end (and on external mutations mid-composition).
 * Listeners attach after Lexical's, so each line reflects state AFTER Lexical
 * processed that event.
 */
export function registerImeTrace(editor: LexicalEditor, ime: ImeCompositionTracker): () => void {
    const truncate = (text: string): string =>
        text.length <= TRACE_TEXT_MAX
            ? text
            : `${text.slice(0, TRACE_TEXT_MAX)}…(+${text.length - TRACE_TEXT_MAX})`;

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

        // Skip the high-volume noise that is not diagnostic on its own.
        if (e.type === 'keydown') {
            if (!isImeKeyEvent(e) && !ime.isComposing()) return;
        } else if (e.type === 'beforeinput' || e.type === 'input') {
            if (!e.isComposing && !ime.isImeActive()) return;
        }

        const composing =
            ` editorComposing=${editor.isComposing()}`
            + ` imeActive=${ime.isImeActive()}`
            + ` compositionId=${ime.compositionId()}`;

        // Per-candidate updates fire constantly; data + flags are enough.
        if (e.type === 'compositionupdate') {
            logger(`[IME] ${e.type} data=${JSON.stringify(e.data ?? null)}${composing}`);
            return;
        }

        const root = editor.getRootElement();
        const detail =
            ` data=${JSON.stringify(e.data ?? null)}`
            + ` inputType=${e.inputType ?? '-'}`
            + (e.type === 'keydown' ? ` key=${e.key ?? '-'} keyCode=${e.keyCode ?? '-'}` : '')
            + ` isComposing=${e.isComposing ?? '-'}`
            + composing
            + ` sel=${root ? describeSelection(root) : '-'}`;

        // Full text at composition boundaries and after the final composition
        // input. The latter is decisive on Gecko/Windows: its payload can name
        // a committed candidate even when neither the DOM nor Lexical adopted
        // it.
        if (
            e.type === 'compositionstart'
            || e.type === 'compositionend'
            || (e.type === 'input' && !e.isComposing)
        ) {
            let modelText = '';
            editor.getEditorState().read(() => {
                modelText = $getRoot().getTextContent();
            });
            const domText = root?.textContent ?? '';
            logger(
                `[IME] ${e.type}${detail}`
                + ` dom=${JSON.stringify(truncate(domText))}`
                + ` model=${JSON.stringify(truncate(modelText))}`,
            );
            return;
        }

        logger(`[IME] ${e.type}${detail}`);
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
