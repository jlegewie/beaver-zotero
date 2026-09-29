/**
 * Guards a context menu whose entries resolve asynchronously.
 *
 * Between the right-click and the entries arriving no menu is mounted, so
 * nothing handles dismissal: a menu that opened late would reappear after the
 * user clicked elsewhere, pressed a key or scrolled, and take focus from
 * whatever they moved on to. A request stays current only until one of those
 * interactions happens in its document, its window loses focus, it is
 * cancelled, or any newer request starts — so two rows resolving out of order
 * cannot both open a menu.
 */
export interface PendingMenuRequest {
    /** Whether the menu may still open. */
    isCurrent(): boolean;
    /** Stop listening once the entries have arrived (or failed). */
    settle(): void;
    /** Invalidate the request, e.g. when its owner unmounts. */
    cancel(): void;
}

/** Keys that are pressed on the way to a click, not instead of one. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS']);

/** Shared by every caller, so a newer menu request anywhere supersedes older ones. */
let latestRequest = 0;

export function beginMenuRequest(doc: Document | null | undefined): PendingMenuRequest {
    const id = ++latestRequest;
    const win = doc?.defaultView ?? null;
    let cancelled = false;

    const onKeyDown = (event: KeyboardEvent) => {
        if (!MODIFIER_KEYS.has(event.key)) cancel();
    };
    const settle = () => {
        doc?.removeEventListener('mousedown', cancel, true);
        doc?.removeEventListener('keydown', onKeyDown, true);
        doc?.removeEventListener('wheel', cancel, true);
        win?.removeEventListener('blur', cancel);
    };
    function cancel() {
        cancelled = true;
        settle();
    }

    // Capture phase: a handler that stops propagation cannot hide the interaction.
    doc?.addEventListener('mousedown', cancel, true);
    doc?.addEventListener('keydown', onKeyDown, true);
    doc?.addEventListener('wheel', cancel, { capture: true, passive: true });
    win?.addEventListener('blur', cancel);

    return {
        isCurrent: () => !cancelled && id === latestRequest,
        settle,
        cancel,
    };
}
