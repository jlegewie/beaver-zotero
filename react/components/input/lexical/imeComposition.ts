import {
    $getRoot,
    COMMAND_PRIORITY_CRITICAL,
    COMPOSITION_END_COMMAND,
    type LexicalEditor,
} from 'lexical';
import { logger } from '../../../../src/utils/logger';

/**
 * Works around IME text being discarded in Gecko on Windows (reported with
 * Sogou Pinyin: the selected candidate never appears in the composer).
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
 * the DOM text and the editor-state text, so IME problems can be diagnosed
 * from a user's debug output without a local reproduction. The listeners are
 * attached after Lexical's, so each line reflects the state AFTER Lexical
 * processed that event.
 */
export function registerImeTrace(editor: LexicalEditor): () => void {
    const onEvent = (event: Event) => {
        const e = event as {
            type: string;
            data?: string | null;
            inputType?: string;
            key?: string;
            keyCode?: number;
            isComposing?: boolean;
        };
        let modelText = '';
        editor.getEditorState().read(() => {
            modelText = $getRoot().getTextContent();
        });
        const domText = editor.getRootElement()?.textContent ?? '';
        logger(
            `[IME] ${e.type}`
            + ` data=${JSON.stringify(e.data ?? null)}`
            + ` inputType=${e.inputType ?? '-'}`
            + ` key=${e.key ?? '-'}`
            + ` keyCode=${e.keyCode ?? '-'}`
            + ` isComposing=${e.isComposing ?? '-'}`
            + ` editorComposing=${editor.isComposing()}`
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
        detach = () => {
            for (const type of TRACED_EVENTS) rootElement.removeEventListener(type, onEvent);
        };
    });
    return () => {
        unregisterRoot();
        detach?.();
        detach = null;
    };
}
